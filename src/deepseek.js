'use strict';

const ENDPOINT = 'https://api.deepseek.com/chat/completions';

/** 可选模型：id 为 API 传参值，label 为界面展示名 */
const MODELS = [
  { id: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro' },
];

/** 推理等级：off 表示关闭思考，其余透传给 reasoning_effort */
const EFFORTS = ['off', 'low', 'high', 'max'];

const DEFAULT_MODEL = 'deepseek-flash';
const DEFAULT_EFFORT = 'high';

const ERROR_HINTS = {
  400: '请求格式有误',
  401: 'API KEY 无效或已失效，请检查设置',
  402: '账户余额不足，请到 platform.deepseek.com 充值',
  403: '无访问权限',
  422: '参数校验失败',
  429: '请求过于频繁，稍等几秒再试',
  500: '服务端异常，请稍后重试',
  503: '服务端繁忙，请稍后重试',
};

function describeError(status, detail) {
  const raw = String(detail || '');
  /* 服务端：user input too long, N tokens exceeds max M tokens */
  const over = raw.match(/user input too long,\s*(\d+)\s*tokens exceeds max\s*(\d+)\s*tokens/i);
  if (over) {
    const used = Number(over[1]).toLocaleString('zh-CN');
    const max = Number(over[2]).toLocaleString('zh-CN');
    return `内容太长：这次输入约 ${used} tokens，超过 ${max} 的上限。如果开着智能搜索，先关掉它通常会好很多；也可能是附件太大，换更小的文件或者拆成几次问`;
  }
  if (/file[_ ]?id|file not found|invalid file/i.test(raw)) {
    return '附件解析结果已失效，请重新发送这个文件';
  }
  const hint = ERROR_HINTS[status] || `请求失败（HTTP ${status}）`;
  return detail ? `${hint}：${detail}` : hint;
}

/**
 * 以 SSE 流式方式请求 DeepSeek，边收边把增量交给 onDelta。
 * @param {object} opts
 * @param {string} opts.model   模型 id，非法值回落默认
 * @param {string} opts.effort  推理等级 off|low|high|max
 * @param {boolean} opts.readUrl 是否声明阅读链接工具（用户消息里带链接时）
 * @returns {Promise<{content:string, reasoning:string, usage:object|null}>}
 */
async function streamChat({ apiKey, model, messages, effort, search, readUrl, onDelta, onToolEvent, signal }) {
  const modelId = MODELS.some((m) => m.id === model) ? model : DEFAULT_MODEL;
  const level = EFFORTS.includes(effort) ? effort : DEFAULT_EFFORT;
  const thinking = level !== 'off';

  const body = {
    model: modelId,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    thinking: { type: thinking ? 'enabled' : 'disabled' },
  };
  if (thinking) body.reasoning_effort = level;
  /* 服务端联网工具：模型自主决定用不用，不能用 tool_choice 强制。
     搜索与读链接都声明时，思考模式会走深度搜索并自行打开网页，与官方一致。 */
  const tools = [];
  if (search) tools.push({ type: 'deepseek_web_search' });
  if (readUrl) tools.push({ type: 'deepseek_read_url' });
  if (tools.length) body.tools = tools;

  let resp;
  try {
    resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    const e = new Error('网络连接失败，检查网络或代理设置');
    e.cause = err;
    throw e;
  }

  if (!resp.ok) {
    let detail = '';
    try {
      const raw = await resp.text();
      const parsed = JSON.parse(raw);
      detail = parsed?.error?.message || '';
    } catch (_) {
      /* 忽略解析失败，用状态码兜底 */
    }
    const e = new Error(describeError(resp.status, detail));
    e.status = resp.status;
    /* 原始错误信息：上层据此判断是不是“输入超长”，message 已是给用户看的中文 */
    e.detail = detail;
    throw e;
  }

  let content = '';
  let reasoning = '';
  let usage = null;
  let toolCalls = [];
  let annotations = [];

  if (!resp.body) throw new Error('服务端没有返回内容');

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const handleFrame = (raw) => {
    /* 一条 SSE 事件可能是多行 data:，换行也可能是 \r\n */
    const dataLines = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (!dataLines.length) return;
    const payload = dataLines.join('\n').trim();
    if (!payload || payload === '[DONE]') return;

    let json;
    try {
      json = JSON.parse(payload);
    } catch (_) {
      return;
    }
    if (json.usage) usage = json.usage;
    const choice = json.choices?.[0];
    if (!choice) return;

    /* 检索进度事件：call_started / call_completed */
    if (choice.server_tool_event && onToolEvent) onToolEvent(choice.server_tool_event);

    const delta = choice.delta;
    if (!delta) return;
    if (Array.isArray(delta.server_tool_calls) && delta.server_tool_calls.length) {
      toolCalls = delta.server_tool_calls;
    }
    if (Array.isArray(delta.annotations) && delta.annotations.length) {
      annotations = delta.annotations;
    }
    if (delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      onDelta({ kind: 'reasoning', text: delta.reasoning_content });
    }
    if (delta.content) {
      content += delta.content;
      onDelta({ kind: 'content', text: delta.content });
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        handleFrame(frame);
      }
    }
    if (buffer.trim()) handleFrame(buffer);
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
  }

  return { content, reasoning, usage, toolCalls, annotations };
}

module.exports = {
  streamChat,
  describeError,
  MODELS,
  EFFORTS,
  DEFAULT_MODEL,
  DEFAULT_EFFORT,
  ENDPOINT,
};
