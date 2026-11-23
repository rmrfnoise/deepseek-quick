'use strict';

const $ = (id) => document.getElementById(id);

const el = {
  stream: $('stream'),
  streamInner: $('streamInner'),
  empty: $('empty'),
  toBottom: $('btnToBottom'),
  input: $('input'),
  send: $('btnSend'),
  sendIcon: $('sendIcon'),
  btnNew: $('btnNew'),
  btnSessions: $('btnSessions'),
  btnSettings: $('btnSettings'),
  btnFullscreen: $('btnFullscreen'),
  btnPin: $('btnPin'),
  btnClose: $('btnClose'),
  btnThinking: $('btnThinking'),
  btnModel: $('btnModel'),
  modelTag: $('modelTag'),
  effortLabel: $('effortLabel'),
  menuModel: $('menuModel'),
  menuEffort: $('menuEffort'),
  usage: $('usage'),
  notice: $('notice'),
  settings: $('settings'),
  btnSettingsClose: $('btnSettingsClose'),
  apiKeyInput: $('apiKeyInput'),
  keyHint: $('keyHint'),
  btnSaveKey: $('btnSaveKey'),
  btnTestKey: $('btnTestKey'),
  themeSwitch: $('themeSwitch'),
  fullscreenKeyBtn: $('fullscreenKeyBtn'),
  fullscreenKeyReset: $('fullscreenKeyReset'),
  fullscreenKeyHint: $('fullscreenKeyHint'),
  newlineKeyBtn: $('newlineKeyBtn'),
  newlineKeyReset: $('newlineKeyReset'),
  newlineKeyHint: $('newlineKeyHint'),
  startFullscreenInput: $('startFullscreenInput'),
  autostartInput: $('autostartInput'),
  autostartHint: $('autostartHint'),
  zoomHint: $('zoomHint'),
  sessionTitle: $('sessionTitle'),
  metaModel: $('metaModel'),
  metaHotkey: $('metaHotkey'),
  metaPath: $('metaPath'),
  metaVersion: $('metaVersion'),
  sessionsPanel: $('sessionsPanel'),
  btnNewSession: $('btnNewSession'),
  btnSessionsClose: $('btnSessionsClose'),
  sessionList: $('sessionList'),
  btnClearAll: $('btnClearAll'),
  btnSearch: $('btnSearch'),
  btnAttach: $('btnAttach'),
  attachRow: $('attachRow'),
};

const ICON_SEND = '<path d="M12 19V5M5 12l7-7 7 7"/>';
const ICON_STOP = '<rect x="7" y="7" width="10" height="10" rx="2"/>';
const ICON_CHECK = '<svg class="check" viewBox="0 0 24 24"><path d="m4 12 5 5L20 6"/></svg>';
const EFFORT_LABELS = { off: 'Off', low: 'Low', high: 'High', max: 'Max' };
const ICON_X = '<path d="M18 6 6 18M6 6l12 12"/>';
const ICON_EXPAND =
  '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/>';
const ICON_COMPRESS =
  '<path d="M8 3v3a2 2 0 0 1-2 2H3M16 3v3a2 2 0 0 0 2 2h3M8 21v-3a2 2 0 0 0-2-2H3M16 21v-3a2 2 0 0 1 2-2h3"/>';

const state = {
  cfg: null,
  busy: false,
  fullscreen: false,
  pinned: false,
  turns: [],
  cur: null,
  renderTimer: null,
  currentSessionId: null,
  sessions: [],
  images: [],
  docs: [],
  usageTurn: null,
  usageSession: null,
};

let md = null;
if (typeof window.markdownit === 'function') {
  md = window.markdownit({ html: false, linkify: true, breaks: true, typographer: false });
  /* 宽表格放进可横向滚动的容器，否则会被 .stream 的 overflow-x:hidden 裁掉 */
  md.renderer.rules.table_open = () => '<div class="table-wrap"><table>';
  md.renderer.rules.table_close = () => '</table></div>';
  /* 代码块右上角加"复制"按钮，点击由 answer 上的事件委托处理 */
  const defaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = function (tokens, idx, options, env, self) {
    const html = defaultFence.call(this, tokens, idx, options, env, self);
    return `<div class="code-block">${html}<button class="code-copy" type="button" title="复制代码">复制</button></div>`;
  };
}


function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function siteNameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

/** 从 server_tool_calls 按出现顺序登记来源，同一 URL 只编一次号 */
function buildSources(toolCalls) {
  const list = [];
  const byUrl = new Map();
  const add = (url, title, meta = {}, read = false) => {
    if (!url) return null;
    const exist = byUrl.get(url);
    if (exist) {
      if (exist.title === url && title) exist.title = title;
      if (!exist.siteName) exist.siteName = String(meta.site_name || '').trim();
      if (read) exist.read = true;
      return exist;
    }
    const src = {
      url,
      title: title || url,
      siteName: String(meta.site_name || '').trim() || siteNameOf(url),
      index: list.length + 1,
      read,
    };
    list.push(src);
    byUrl.set(url, src);
    return src;
  };
  for (const step of toolCalls || []) {
    for (const call of step.calls || []) {
      for (const item of call.sources || []) add(item.url, item.title, item);
      if (call.page && call.page.url) add(call.page.url, call.page.title, {}, true);
    }
  }
  return { list, byUrl };
}

/** 标记字符：私有区字符，不会和 markdown 的链接/强调语法冲突 */
const CITE_OPEN = '\uE000';
const CITE_CLOSE = '\uE001';

/** 按 annotations 的码点位置插入角标标记，渲染后再替换成角标 */
function insertCitations(text, annotations, byUrl) {
  if (!annotations || !annotations.length) return text;
  const chars = Array.from(text);
  const marks = new Map();
  for (const ann of annotations) {
    const c = ann.url_citation || ann.citation || ann;
    if (!c || !c.url) continue;
    const src = byUrl.get(c.url);
    if (!src) continue;
    const end = Number.isFinite(c.end_index) ? c.end_index : chars.length;
    let pos = Math.max(0, Math.min(chars.length, end));
    /* 落点若正好在 ** 加粗标记中间，往后挪出标记，避免破坏强调 */
    while (pos < chars.length && chars[pos] === '*') pos += 1;
    if (!marks.has(pos)) marks.set(pos, []);
    const arr = marks.get(pos);
    if (!arr.includes(src.index)) arr.push(src.index);
  }
  if (!marks.size) return text;
  let out = '';
  for (let i = 0; i <= chars.length; i += 1) {
    const arr = marks.get(i);
    if (arr) for (const n of arr) out += `${CITE_OPEN}${n}${CITE_CLOSE}`;
    if (i < chars.length) out += chars[i];
  }
  return out;
}

/** 渲染后的 HTML 里把 [citation:N] 换成可点击上标，悬停显示来源 */
function decorateCitations(html, sources) {
  if (!sources || !sources.length) return html;
  return html.replace(/\uE000(\d+)\uE001/g, (_raw, n) => {
    const src = sources[Number(n) - 1];
    if (!src) return '';
    return `<span class="cite" data-url="${escapeHtml(src.url)}">${n}` +
      `<span class="cite-card"><b>${escapeHtml(src.title)}</b>` +
      `<i>${escapeHtml(src.siteName)}</i></span></span>`;
  });
}

function describeAction(action, kind) {
  const a = action || {};
  if (a.type === 'search') {
    const q = (a.queries || []).join(' / ');
    return `${kind === 'deep_search' || kind === 'deep_image_search' ? '深度搜索' : '搜索'}「${q}」`;
  }
  if (a.type === 'open_page') return `打开 ${siteNameOf(a.url) || a.url || ''}`;
  if (a.type === 'find_in_page') return `页内查找「${a.pattern || ''}」`;
  if (a.type === 'read_link') return `阅读 ${siteNameOf(a.url) || a.url || ''}`;
  return '联网检索';
}

/** 该次工具调用是不是“阅读链接”（与搜索区分，标题文案不同） */
function callIsRead(call) {
  return Boolean(call) && (call.kind === 'read_link' || call.action?.type === 'read_link');
}

/** 服务端读链接的失败原因 */
const READ_ERRORS = {
  url_not_allowed: '该网站不允许抓取',
  url_not_accessible: '打不开这个链接',
  unavailable: '服务暂时不可用',
};

function readErrorText(call) {
  const code = call?.error?.code || call?.error_code || '';
  return READ_ERRORS[code] || '读取失败';
}

function ensureSearchBox(turn) {
  if (turn.search) return turn.search;
  const box = document.createElement('div');
  box.className = 'search-box';

  const head = document.createElement('div');
  head.className = 'search-head';
  const spin = document.createElement('span');
  spin.className = 'spinner';
  const label = document.createElement('span');
  label.textContent = '正在联网搜索…';
  head.appendChild(spin);
  head.appendChild(label);
  head.addEventListener('click', () => box.classList.toggle('collapsed'));

  const body = document.createElement('div');
  body.className = 'search-body';

  box.appendChild(head);
  box.appendChild(body);
  turn.a.insertBefore(box, turn.answer);

  turn.search = {
    box,
    head,
    label,
    spin,
    body,
    steps: [],
    reads: 0,
    readFails: 0,
    localReads: 0,
    searches: 0,
    done: false,
    total: 0,
  };
  scrollBottom(false);
  return turn.search;
}

function paintSearchLabel(turn) {
  const s = turn.search;
  if (!s) return;
  if (s.done) {
    const parts = [];
    if (s.reads) parts.push(`已阅读 ${s.reads} 个链接${s.localReads >= s.reads ? '（本地）' : ''}`);
    else if (s.readFails) parts.push('链接读取失败');
    if (s.searches) parts.push(s.total ? `已联网检索 · ${s.total} 个来源` : '已完成联网检索');
    s.label.textContent = parts.join(' · ') || '已完成';
    s.box.classList.add('collapsed');
    return;
  }
  const hasRead = s.steps.some((step) => step.read);
  s.label.textContent = hasRead && !s.searches ? '正在阅读链接…' : `正在联网搜索…（${s.steps.length} 步）`;
}

function paintSearchBox(turn) {
  const s = turn.search;
  if (!s) return;
  s.body.innerHTML = s.steps
    .map((step) => `<div class="search-step">${escapeHtml(step.text)}</div>`)
    .join('');
}

function handleToolEvent(turn, evt) {
  if (!evt || (evt.type !== 'call_started' && evt.type !== 'call_completed')) return;
  const s = ensureSearchBox(turn);
  const call = evt.call || {};
  if (evt.type === 'call_started') {
    const read = callIsRead(call);
    if (!read) s.searches += 1;
    s.steps.push({ id: call.id, text: describeAction(call.action, call.kind), read });
  } else if (evt.type === 'call_completed') {
    const step = s.steps.find((item) => item.id === call.id);
    if (step) {
      if (call.status === 'failed') {
        if (step.read) {
          s.readFails += 1;
          step.text += ` · ${readErrorText(call)}`;
        } else {
          step.text += ' · 失败';
        }
      } else if (step.read) {
        s.reads += 1;
        step.text += call.page?.title ? ` · ${call.page.title}` : ' · 已读取';
      } else {
        const n = (call.sources || []).length;
        if (n) step.text += ` · ${n} 个结果`;
      }
    }
  }
  paintSearchLabel(turn);
  paintSearchBox(turn);
}

function replaySearchBox(turn, toolCalls) {
  const calls = [];
  for (const step of toolCalls || []) {
    for (const call of step.calls || []) calls.push(call);
  }
  if (!calls.length) return;
  const box = ensureSearchBox(turn);
  for (const call of calls) {
    const read = callIsRead(call);
    if (!read) box.searches += 1;
    const text = describeAction(call.action, call.kind);
    if (read) {
      if (call.status === 'failed') {
        box.readFails += 1;
        box.steps.push({ id: call.id, read: true, text: `${text} · ${readErrorText(call)}` });
      } else {
        box.reads += 1;
        box.steps.push({
          id: call.id,
          read: true,
          text: call.page?.title ? `${text} · ${call.page.title}` : `${text} · 已读取`,
        });
      }
    } else {
      const n = (call.sources || []).length;
      box.steps.push({ id: call.id, read: false, text: n ? `${text} · ${n} 个结果` : text });
    }
  }
  paintSearchBox(turn);
}

/** 服务端读不了、客户端用本地浏览器读到的页面 */
function applyLocalRead(turn, pages) {
  if (!pages || !pages.length) return;
  const s = ensureSearchBox(turn);
  for (const p of pages) {
    s.reads += 1;
    s.localReads += 1;
    s.steps.push({
      id: `local:${p.url}`,
      read: true,
      text: `本地读取 ${siteNameOf(p.url) || p.url}${p.title ? ` · ${p.title}` : ''}`,
    });
  }
  paintSearchLabel(turn);
  paintSearchBox(turn);
}

function finishSearchBox(turn, sourceCount) {
  const s = turn.search;
  if (!s) return;
  if (s.spin) s.spin.remove();
  s.spin = null;
  s.done = true;
  s.total = sourceCount || 0;
  paintSearchLabel(turn);
  paintSearchBox(turn);
  s.box.classList.add('collapsed');
}

function renderSources(turn, sources) {
  if (!sources || !sources.length) return;
  const box = document.createElement('div');
  box.className = 'sources';
  const head = document.createElement('div');
  head.className = 'sources-head';
  const allRead = sources.every((src) => src.read);
  head.textContent = allRead ? `已阅读的链接 · ${sources.length}` : `来源 · ${sources.length}`;
  box.appendChild(head);

  const list = document.createElement('div');
  box.appendChild(list);

  const buildRow = (src) => {
    const row = document.createElement('div');
    row.className = 'source-item';
    row.title = src.url;
    row.innerHTML = `<span class="source-idx">${src.index}</span>` +
      `<span class="source-title">${escapeHtml(src.title)}</span>` +
      `<span class="source-site">${escapeHtml(src.siteName)}</span>`;
    row.addEventListener('click', () => window.api.openExternal(src.url));
    return row;
  };

  const LIMIT = 4;
  const folded = sources.length > LIMIT;
  const shown = folded ? sources.slice(0, LIMIT) : sources;
  shown.forEach((src) => list.appendChild(buildRow(src)));

  if (folded) {
    const more = document.createElement('button');
    more.className = 'sources-more';
    more.textContent = `展开全部 ${sources.length} 个来源`;
    more.addEventListener('click', () => {
      list.innerHTML = '';
      sources.forEach((src) => list.appendChild(buildRow(src)));
      more.remove();
    });
    box.appendChild(more);
  }

  turn.a.appendChild(box);
  scrollBottom(false);
}

/* CommonMark 的 emphasis 规则很严格：`**` 内侧紧贴中文引号/标点时，
   markdown-it 会判定无法开启强调，把星号原样输出。
   这里在成对的 ** 内侧临时插入私有区字符，绕过 flanking 判断，
   渲染后再删掉，正文内容不受影响。 */
const EMPHASIS_PAD = '\uE000';

function relaxCjkEmphasis(text) {
  return String(text).replace(
    /\*\*((?:(?!\n\s*\n)[\s\S])+?)\*\*/g,
    (_, inner) => `**${EMPHASIS_PAD}${inner}${EMPHASIS_PAD}**`,
  );
}

function renderMarkdown(text) {
  if (md) {
    try {
      return md.render(relaxCjkEmphasis(text)).split(EMPHASIS_PAD).join('');
    } catch (_) {
      /* 落回纯文本 */
    }
  }
  const div = document.createElement('div');
  div.textContent = text;
  return `<p>${div.innerHTML.replace(/\n/g, '<br>')}</p>`;
}

function scrollBottom(force) {
  const s = el.stream;
  const near = s.scrollHeight - s.scrollTop - s.clientHeight < 120;
  if (force || near) s.scrollTop = s.scrollHeight;
  updateToBottom();
}

/** 离底部较远时露出“回到底部”，生成中也不打扰 */
function updateToBottom() {
  const s = el.stream;
  const far = s.scrollHeight - s.scrollTop - s.clientHeight > 240;
  el.toBottom.classList.toggle('hidden', !far);
}

/* ---------- 图片附件 ---------- */

let MAX_IMAGES = 6;
const IMAGE_SIDE = 1600;
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** 太长的边缩到 1600px，小图原样保留（截图上的文字更清楚） */
async function prepareImage(dataUrl, name) {
  const img = await loadImageEl(dataUrl).catch(() => null);
  if (!img) return null;
  const w0 = img.naturalWidth || img.width;
  const h0 = img.naturalHeight || img.height;
  if (!w0 || !h0) return null;
  const scale = Math.min(1, IMAGE_SIDE / Math.max(w0, h0));
  /* BMP 浏览器能显示，但接口不接受 image/bmp；小图也必须转成 PNG */
  const isBmp = /^data:image\/bmp/i.test(dataUrl);
  if (!isBmp && scale === 1 && dataUrl.length <= 2600000) return { dataUrl, name, w: w0, h: h0 };

  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  const isPng = /^data:image\/(png|bmp)/i.test(dataUrl);
  let out = isPng ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.9);
  if (out.length > 3600000) out = canvas.toDataURL('image/jpeg', 0.82);
  if (!out || out.length > 12 * 1024 * 1024) return null;
  return { dataUrl: out, name, w, h };
}

/** 只有 V4.1-Flash 支持图片与文件输入，带附件时自动切过去 */
async function ensureVisionModel() {
  if (!state.cfg || state.cfg.model === 'deepseek-flash') return;
  state.cfg.model = 'deepseek-flash';
  updateMeta();
  await window.api.saveConfig({ model: 'deepseek-flash' });
  showNotice('文件理解需要 DeepSeek-V4.1-Flash，已自动切换模型');
}

/* ---------- 附件：图片 + 文档 ---------- */

let MAX_DOCS = 6;
/* 由主进程 files.js 经 config:get 下发，避免两份扩展名清单漂移 */
let FILES_OK = [];
const DOC_BADGE = {
  pdf: 'PDF', doc: 'DOC', docx: 'DOC', ppt: 'PPT', pptx: 'PPT',
  xlsx: 'XLS', xls: 'XLS', epub: 'EPUB', mobi: 'MOBI', csv: 'CSV',
  txt: 'TXT', md: 'MD', json: 'JSON',
};

function docExt(name) {
  return String(name || '').split('.').pop().toLowerCase();
}

function fmtSize(n) {
  const b = Number(n) || 0;
  if (!b) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** 文件卡片：桌面端附件行与消息气泡共用同一套外观 */
function buildDocCard(doc, opts = {}) {
  const ext = docExt(doc.name);
  const box = document.createElement('div');
  box.className = 'doc';
  box.title = doc.bytes ? `${doc.name} · ${fmtSize(doc.bytes)}` : doc.name || '';

  const badge = document.createElement('span');
  badge.className = `doc-badge ext-${ext}`;
  badge.textContent = DOC_BADGE[ext] || (ext ? ext.slice(0, 4).toUpperCase() : 'FILE');

  const body = document.createElement('span');
  body.className = 'doc-text';
  const name = document.createElement('span');
  name.className = 'doc-name';
  name.textContent = doc.name || '文件';
  const meta = document.createElement('span');
  meta.className = doc.state === 'error' ? 'doc-meta bad' : 'doc-meta';
  meta.textContent = doc.state === 'uploading' ? '解析中…' : doc.state === 'error' ? (doc.message || '失败') : fmtSize(doc.bytes);
  body.appendChild(name);
  body.appendChild(meta);

  box.appendChild(badge);
  box.appendChild(body);
  box.metaEl = meta;
  box.docRef = doc;

  if (opts.removable) {
    const del = document.createElement('button');
    del.className = 'thumb-x doc-x';
    del.textContent = '×';
    del.title = '移除';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onRemove?.();
    });
    box.appendChild(del);
  }
  return box;
}

function renderAttachRow() {
  el.attachRow.innerHTML = '';
  const total = state.images.length + state.docs.length;
  el.attachRow.classList.toggle('hidden', !total);

  for (const img of state.images) {
    const box = document.createElement('div');
    box.className = 'thumb';

    const pic = document.createElement('img');
    pic.src = img.dataUrl;
    pic.title = img.name || '';

    const del = document.createElement('button');
    del.className = 'thumb-x';
    del.textContent = '×';
    del.title = '移除';
    del.addEventListener('click', () => {
      state.images = state.images.filter((item) => item.id !== img.id);
      renderAttachRow();
      el.input.focus();
    });

    box.appendChild(pic);
    box.appendChild(del);
    el.attachRow.appendChild(box);
  }

  for (const doc of state.docs) {
    el.attachRow.appendChild(
      buildDocCard(doc, {
        removable: true,
        onRemove: () => {
          state.docs = state.docs.filter((item) => item.id !== doc.id);
          renderAttachRow();
          el.input.focus();
        },
      })
    );
  }

  updateSendState();
}

function addImages(items) {
  for (const item of items) {
    if (state.images.length >= MAX_IMAGES) {
      showNotice(`一次最多 ${MAX_IMAGES} 张图片`);
      break;
    }
    state.images.push({
      id: `i${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
      ...item,
    });
  }
  ensureVisionModel();
  renderAttachRow();
}

function addDocs(items) {
  const base = (name) => String(name || '').replace(/\.[^.]+$/, '').trim();
  let sameDoc = false;
  for (const item of items) {
    if (state.docs.length >= MAX_DOCS) {
      showNotice(`一次最多 ${MAX_DOCS} 个文件`);
      break;
    }
    if (state.docs.some((d) => d.path === item.path && item.path)) {
      showNotice('这个文件已经加过了');
      continue;
    }
    /* 同一份文件的 PDF 与 Word 同时传很常见，解析要各算一份，提醒一下 */
    if (base(item.name) && state.docs.some((d) => base(d.name) === base(item.name))) sameDoc = true;
    state.docs.push({
      id: `d${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
      ...item,
      bytes: Number(item.bytes || item.size) || 0,
    });
  }
  if (sameDoc) showNotice('看着是同一份文件的两种格式，传一份就够了，能省一半解析时间');
  ensureVisionModel();
  renderAttachRow();
}

async function addImagesFromFiles(files) {
  const room = MAX_IMAGES - state.images.length;
  const picked = [];
  for (const file of Array.from(files).slice(0, Math.max(0, room))) {
    if (!/^image\/(jpeg|png|gif|webp|bmp)$/i.test(file.type || '')) continue;
    let dataUrl = '';
    try {
      dataUrl = await fileToDataUrl(file);
    } catch (_) {
      continue;
    }
    const prepared = await prepareImage(dataUrl, file.name || '图片');
    if (prepared) picked.push(prepared);
  }
  if (picked.length) addImages(picked);
}

/**
 * 拖拽/粘贴进来的非图片文件。
 * 拖拽时 File 自带本地路径，直接用；从剪贴板来的有时没有路径，就把内容落盘暂存再上传。
 */
async function docsFromFiles(files) {
  const items = [];
  for (const file of Array.from(files || [])) {
    if (/^image\//i.test(file.type || '')) continue;
    if (!FILES_OK.includes(docExt(file.name))) continue;
    if (state.docs.length + items.length >= MAX_DOCS) {
      showNotice(`一次最多 ${MAX_DOCS} 个文件`);
      break;
    }

    let p = file.path || '';
    if (!p) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const res = await window.api.stashFile({ name: file.name, bytes });
        if (res && res.ok) p = res.path;
      } catch (_) {
        p = '';
      }
    }
    if (!p) continue;

    items.push({ kind: 'file', name: file.name, size: file.size || 0, path: p });
  }
  return items;
}

function clearAttach() {
  state.images = [];
  state.docs = [];
  renderAttachRow();
}

function hasDroppable(e) {
  const items = e.dataTransfer?.items;
  if (!items) return false;
  return Array.from(items).some((item) => item.kind === 'file');
}

/* ---------- 消息构建 ---------- */

function createTurn(question, thinkingOn, images = [], docs = []) {
  el.empty.classList.add('hidden');

  const root = document.createElement('div');
  root.className = 'turn';

  const q = document.createElement('div');
  q.className = 'q';
  const bubble = document.createElement('div');
  bubble.className = 'q-bubble';

  if (images && images.length) {
    bubble.classList.add('has-images');
    const grid = document.createElement('div');
    grid.className = 'q-images';
    for (const img of images) {
      const pic = document.createElement('img');
      pic.title = img.name || '';
      pic.alt = img.name || '图片';
      if (img.dataUrl) {
        pic.src = img.dataUrl;
      } else if (img.file) {
        /* 历史会话只带文件名，按需取图，避免切换会话时一次读几十 MB */
        pic.classList.add('pending');
        window.api
          .readStoredImage(img.file)
          .then((res) => {
            if (!pic.isConnected) return;
            if (res && res.ok) {
              pic.src = res.dataUrl;
            } else {
              pic.classList.add('missing');
              pic.title = `${img.name || '图片'}（已丢失）`;
            }
            pic.classList.remove('pending');
          })
          .catch(() => {
            if (!pic.isConnected) return;
            pic.classList.add('missing');
            pic.classList.remove('pending');
          });
      }
      grid.appendChild(pic);
    }
    bubble.appendChild(grid);
  }

  const docEls = [];
  if (docs && docs.length) {
    bubble.classList.add('has-images');
    const list = document.createElement('div');
    list.className = 'q-docs';
    for (const doc of docs) {
      const card = buildDocCard(doc);
      docEls.push(card);
      list.appendChild(card);
    }
    bubble.appendChild(list);
  }

  if (question) {
    const textEl = document.createElement('div');
    textEl.className = 'q-text';
    textEl.textContent = question;
    bubble.appendChild(textEl);
  }

  q.appendChild(bubble);
  root.appendChild(q);

  const a = document.createElement('div');
  a.className = 'a';

  let reasonBlock = null;
  let reasonBody = null;
  let reasonTitle = null;
  let spinner = null;

  if (thinkingOn) {
    reasonBlock = document.createElement('div');
    reasonBlock.className = 'reason';

    const head = document.createElement('div');
    head.className = 'reason-head';
    spinner = document.createElement('span');
    spinner.className = 'spinner';
    reasonTitle = document.createElement('span');
    reasonTitle.textContent = '深度思考中…';
    head.appendChild(spinner);
    head.appendChild(reasonTitle);
    head.addEventListener('click', () => reasonBlock.classList.toggle('collapsed'));

    reasonBody = document.createElement('div');
    reasonBody.className = 'reason-body';

    reasonBlock.appendChild(head);
    reasonBlock.appendChild(reasonBody);
    a.appendChild(reasonBlock);
  }

  const answer = document.createElement('div');
  answer.className = 'answer';
  a.appendChild(answer);

  /* 关掉思考时没有推理块，先用一个占位提示，避免发送后一片空白 */
  if (!thinkingOn) {
    const loading = document.createElement('div');
    loading.className = 'answer-loading';
    const spin = document.createElement('span');
    spin.className = 'spinner';
    const label = document.createElement('span');
    label.textContent = '正在生成…';
    loading.appendChild(spin);
    loading.appendChild(label);
    answer.appendChild(loading);
  }

  root.appendChild(a);
  el.streamInner.appendChild(root);
  scrollBottom(true);

  answer.addEventListener('click', (e) => {
    const cite = e.target.closest('.cite');
    if (cite && cite.dataset.url) {
      window.api.openExternal(cite.dataset.url);
      return;
    }
    const copyBtn = e.target.closest('.code-copy');
    if (!copyBtn) return;
    const code = copyBtn.closest('.code-block')?.querySelector('code');
    if (!code) return;
    window.api
      .copy(code.textContent)
      .then(() => {
        copyBtn.textContent = '已复制';
        copyBtn.classList.add('done');
        setTimeout(() => {
          if (copyBtn.isConnected) {
            copyBtn.textContent = '复制';
            copyBtn.classList.remove('done');
          }
        }, 1400);
      })
      .catch(() => {});
  });

  const turn = {
    root,
    a,
    answer,
    search: null,
    sources: [],
    reasonBlock,
    reasonBody,
    reasonTitle,
    spinner,
    content: '',
    reasoning: '',
    docEls,
  };

  state.turns.push(turn);
  return turn;
}

function scheduleRender() {
  if (state.renderTimer) return;
  state.renderTimer = setTimeout(() => {
    state.renderTimer = null;
    const turn = state.cur;
    if (!turn) return;
    turn.answer.innerHTML = `${renderMarkdown(turn.content)}<span class="cursor"></span>`;
    scrollBottom(false);
  }, 90);
}

function finalizeTurn(turn, statusLabel) {
  let html = turn.content ? renderMarkdown(turn.content) : '';
  if (html && turn.sources && turn.sources.length) {
    html = decorateCitations(html, turn.sources);
  }
  turn.answer.innerHTML = html || `<p style="color:var(--text-faint)">${statusLabel || '（无输出）'}</p>`;

  if (turn.reasonBlock) {
    if (turn.spinner) turn.spinner.remove();
    if (turn.reasoning) {
      turn.reasonTitle.textContent = `深度思考过程（${turn.reasoning.length} 字，点击展开）`;
      turn.reasonBlock.classList.add('collapsed');
    } else {
      turn.reasonBlock.remove();
    }
  }
  scrollBottom(false);
}

function appendError(message, actions = []) {
  const box = document.createElement('div');
  box.className = 'err';
  const text = document.createElement('span');
  text.textContent = message;
  box.appendChild(text);

  actions.forEach((action) => {
    const btn = document.createElement('button');
    btn.className = 'err-btn';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      box.remove();
      action.fn();
    });
    box.appendChild(btn);
  });

  el.empty.classList.add('hidden');
  const wrap = document.createElement('div');
  wrap.className = 'turn';
  wrap.appendChild(box);
  el.streamInner.appendChild(wrap);
  scrollBottom(true);
}

/* ---------- 会话 ---------- */

function clearDom() {
  state.turns.forEach((t) => t.root.remove());
  state.turns = [];
  state.cur = null;
  el.empty.classList.remove('hidden');
  clearUsage();
  updateToBottom();
}

function setSessionTitle(title) {
  el.sessionTitle.textContent = title && title !== '新会话' ? title : '';
}

function renderHistory(messages) {
  clearDom();
  let pending = null;

  messages.forEach((m) => {
    if (m.role === 'user') {
      pending = { text: m.content || '', images: m.images || [], docs: m.docs || [] };
    } else if (m.role === 'assistant') {
      const turn = createTurn(
        pending ? pending.text : '',
        false,
        pending ? pending.images : [],
        pending ? pending.docs : []
      );
      const { list, byUrl } = buildSources(m.serverToolCalls);
      turn.content = list.length ? insertCitations(m.content, m.annotations, byUrl) : m.content;
      turn.sources = list;
      replaySearchBox(turn, m.serverToolCalls);
      applyLocalRead(turn, m.localRead);
      finishSearchBox(turn, list.length);
      finalizeTurn(turn);
      renderSources(turn, list);
      pending = null;
    }
  });

  if (pending) createTurn(pending.text, false, pending.images, pending.docs);
  el.stream.scrollTop = el.stream.scrollHeight;
  updateToBottom();
}

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return '昨天';
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function renderSessionList() {
  el.sessionList.innerHTML = '';

  el.btnClearAll.classList.toggle('hidden', !state.sessions.length);

  const isDraft = !state.currentSessionId;
  el.btnNewSession.classList.toggle('current', isDraft);
  const poolLabel = el.btnNewSession.querySelector('span');
  if (poolLabel) poolLabel.textContent = isDraft ? '当前：新会话' : '新建会话';

  if (!state.sessions.length) {
    const empty = document.createElement('div');
    empty.className = 'session-empty';
    empty.textContent = '还没有历史会话';
    el.sessionList.appendChild(empty);
    return;
  }

  state.sessions.forEach((s) => {
    const item = document.createElement('div');
    item.className = `session-item${s.id === state.currentSessionId ? ' active' : ''}`;

    const main = document.createElement('div');
    main.className = 's-main';
    const title = document.createElement('div');
    title.className = 's-title';
    title.textContent = s.title;
    const meta = document.createElement('div');
    meta.className = 's-meta';
    meta.textContent = `${formatTime(s.updatedAt)} · ${Math.ceil(s.count / 2)} 轮`;
    main.appendChild(title);
    main.appendChild(meta);

    const del = document.createElement('button');
    del.className = 's-del';
    del.innerHTML = `<svg viewBox="0 0 24 24">${ICON_X}</svg>`;
    del.title = '删除会话';

    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!del.classList.contains('confirm')) {
        del.classList.add('confirm');
        del.textContent = '确认';
        del.style.opacity = '1';
        del.style.background = 'rgba(242, 90, 90, 0.30)';
        del.style.color = '#f25a5a';
        del.style.border = '1px solid rgba(242, 90, 90, 0.55)';
        setTimeout(() => {
          if (del.isConnected && del.classList.contains('confirm')) {
            del.classList.remove('confirm');
            del.style.cssText = '';
            del.innerHTML = `<svg viewBox="0 0 24 24">${ICON_X}</svg>`;
          }
        }, 2600);
        return;
      }
      removeSession(s.id);
    });

    item.addEventListener('click', () => switchSession(s.id));
    item.appendChild(main);
    item.appendChild(del);
    el.sessionList.appendChild(item);
  });
}

async function refreshSessions() {
  const res = await window.api.listSessions();
  state.sessions = res.items || [];
  state.currentSessionId = res.currentId || null;
  renderSessionList();
}

async function openSessions() {
  await refreshSessions();
  el.sessionsPanel.classList.remove('hidden');
}

function closeSessions() {
  el.sessionsPanel.classList.add('hidden');
  el.input.focus();
}

async function switchSession(id) {
  if (state.busy) await window.api.abort();
  const res = await window.api.switchSession(id);
  if (!res.ok) return;
  state.cur = null;
  state.currentSessionId = res.id;
  setSessionTitle(res.title);
  /* 附件属于上一个会话的草稿，不跟着切过去 */
  clearAttach();
  renderHistory(res.messages || []);
  setUsage(lastUsage(res.messages), res.sessionUsage);
  closeSessions();
}

async function newSession() {
  if (state.busy) await window.api.abort();
  await window.api.createSession();
  state.currentSessionId = null;
  state.cur = null;
  clearDom();
  setSessionTitle('');
  el.input.value = '';
  el.input.style.height = 'auto';
  clearAttach();
  closeSessions();
  el.input.focus();
  await refreshSessions();
}

async function clearAllSessions() {
  if (state.busy) await window.api.abort();
  await window.api.clearSessions();
  state.currentSessionId = null;
  state.cur = null;
  clearDom();
  setSessionTitle('');
  el.input.value = '';
  el.input.style.height = 'auto';
  clearAttach();
  closeSessions();
  el.input.focus();
  await refreshSessions();
}

async function removeSession(id) {
  if (state.busy && state.currentSessionId === id) await window.api.abort();
  const res = await window.api.deleteSession(id);
  if (res.currentId === null && state.currentSessionId === id) {
    /* 删掉的是当前会话：回到空白草稿，标题也要跟着清掉，
       否则关掉会话列表后标题栏还挂着已删会话的名字 */
    state.currentSessionId = null;
    state.cur = null;
    clearDom();
    setSessionTitle('');
  }
  await refreshSessions();
}

/* ---------- 用量与费用 ---------- */

const TIER_LABEL = { peak: '高峰价', off: '空闲价', mixed: '混合价' };

function fmtNum(n) {
  return Number(n || 0).toLocaleString('zh-CN');
}

function fmtLimit(n) {
  const v = Number(n) || 0;
  if (v >= 1e6 && v % 1e6 === 0) return `${v / 1e6}M`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}K`;
  return String(v);
}

function fmtMoney(v) {
  const n = Number(v) || 0;
  if (!n) return '¥0';
  const trim = (s) => s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  if (n < 0.01) return `¥${trim(n.toFixed(6))}`;
  if (n < 1) return `¥${trim(n.toFixed(4))}`;
  return `¥${n.toFixed(2)}`;
}

function buildUsageTitle(t, s) {
  const lines = [];
  if (t.rates) {
    lines.push(`价格：命中 ¥${t.rates.hit}/M · 未命中 ¥${t.rates.miss}/M · 输出 ¥${t.rates.out}/M`);
  } else {
    lines.push('价格：本轮跨峰谷或多个模型，按每次调用分别计价');
  }
  if (t.cacheKnown === false) {
    lines.push(`输入：命中未知 / 未命中 ${fmtNum(t.miss)}（接口未返回缓存字段，按全部未命中估算，费用为上限）`);
  } else {
    lines.push(`输入：${fmtNum(t.hit)} 命中 / ${fmtNum(t.miss)} 未命中 · 上下文 ${fmtNum(t.prompt)} / ${fmtLimit(t.limit)}`);
  }
  lines.push('上下文上限按官方 1M；联网工具可能有更低限制');
  lines.push(`输出：${fmtNum(t.completion)} tokens${t.reasoning ? `（其中思考 ${fmtNum(t.reasoning)}）` : ''}`);
  lines.push(`${TIER_LABEL[t.tier] || ''}：高峰为北京时间周一至周五 09:00-12:00、14:00-18:00，法定节假日除外`);
  if (t.holidayKnown === false) {
    lines.push('节假日表未覆盖本轮年份：按工作日规则估算，节假日可能多算；可在 src/holidays.json 补日期');
  }
  if (t.model) lines.push(`模型：${t.model}`);
  lines.push(`调用：${t.calls} 次（含自动重试）`);
  const approx = t.cacheKnown === false || t.holidayKnown === false;
  lines.push(`本轮模型费：${approx ? '≈' : ''}${fmtMoney(t.cost)}`);
  lines.push('仅统计模型 token；文件解析等附加费用未计入');
  if (t.partial) lines.push('本轮已停止，用量可能不完整，且未计入会话累计');
  const sessText = s && s.calls
    ? `${s.cacheKnown === false || s.holidayKnown === false ? '≈' : ''}${fmtMoney(s.cost)}`
    : '未记录';
  lines.push(`会话累计：${sessText}${s && s.missing ? `（有 ${s.missing} 条历史回答未记录用量）` : ''}`);
  lines.push(`价格表：${t.priceVersion || '-'}`);
  return lines.join('\n');
}

function renderUsage() {
  const t = state.usageTurn;
  if (!t || !t.calls) {
    clearUsage();
    return;
  }
  const s = state.usageSession;
  const approx = t.cacheKnown === false || t.holidayKnown === false;
  const hitText = t.cacheKnown === false ? '?' : fmtNum(t.hit);
  const hitClass = t.cacheKnown === false ? 'u-unknown' : t.hit > 0 ? 'u-hit' : '';
  const sessionApprox = s && (s.cacheKnown === false || s.holidayKnown === false);
  const sessionCost = s && s.calls ? `${sessionApprox ? '≈' : ''}${fmtMoney(s.cost)}` : '—';
  const note = s && s.missing ? '<i class="u-note" title="有历史回答未记录用量">*</i>' : '';
  el.usage.innerHTML = `
    <span class="u-group">
      <span class="u-item" title="缓存命中 / 未命中"><span class="u-label">输入</span><b class="${hitClass}">${hitText}</b><span class="u-sep">/</span><b>${fmtNum(t.miss)}</b></span>
      <span class="u-item" title="本轮上下文 / 官方上下文上限"><span class="u-label">上下文</span><b>${fmtNum(t.prompt)}</b><span class="u-sep">/</span><b class="u-limit">${fmtLimit(t.limit)}</b></span>
      <span class="u-item" title="输出 tokens（含思考）"><span class="u-label">输出</span><b>${fmtNum(t.completion)}</b></span>
    </span>
    <span class="u-group u-right">
      <span class="u-item u-cost" title="本轮模型费"><span class="u-label">本轮</span><b>${approx ? '≈' : ''}${fmtMoney(t.cost)}</b></span>
      <span class="u-item"><span class="u-label">会话</span><b>${sessionCost}</b>${note}</span>
      <span class="u-badge ${t.tier || 'mixed'}">${TIER_LABEL[t.tier] || '—'}</span>
    </span>`;
  el.usage.title = buildUsageTitle(t, s);
  el.usage.classList.remove('hidden');
}

function setUsage(turn, session) {
  state.usageTurn = turn && turn.calls ? turn : null;
  state.usageSession = session || null;
  renderUsage();
  scrollBottom(false);
}

function clearUsage() {
  state.usageTurn = null;
  state.usageSession = null;
  el.usage.classList.add('hidden');
  el.usage.textContent = '';
  el.usage.title = '';
}

function lastUsage(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role === 'assistant' && m.usage && m.usage.calls) return m.usage;
  }
  return null;
}

/* ---------- 发送 ---------- */

function canSend() {
  return state.busy || el.input.value.trim().length > 0 || state.images.length > 0 || state.docs.length > 0;
}

function updateSendState() {
  el.send.disabled = !canSend();
}

function setBusy(busy) {
  state.busy = busy;
  el.send.classList.toggle('stop', busy);
  el.sendIcon.innerHTML = busy ? ICON_STOP : ICON_SEND;
  el.send.title = busy ? '停止生成' : '发送';
  updateSendState();
}

async function submit() {
  if (state.busy) {
    await window.api.abort();
    return;
  }

  const text = el.input.value.trim();
  const images = state.images.slice();
  const docs = state.docs.slice();
  if (!text && !images.length && !docs.length) return;

  if (!state.cfg || !state.cfg.hasKey) {
    openSettings();
    setKeyHint('请先填写 API KEY 再提问', 'bad');
    return;
  }

  const effort = state.cfg.effort;
  const turn = createTurn(text, effort !== 'off', images, docs);
  el.input.value = '';
  el.input.style.height = 'auto';
  clearAttach();
  clearUsage();
  state.cur = turn;
  setBusy(true);

  try {
    const res = await window.api.send({
      text,
      model: state.cfg.model,
      effort,
      search: state.cfg.search === true,
      sessionId: state.currentSessionId,
      images: images.map((img) => ({ dataUrl: img.dataUrl, name: img.name, w: img.w, h: img.h })),
      files: docs.map((doc) => ({ path: doc.path, name: doc.name, bytes: doc.bytes })),
    });

    /* 生成期间切了会话/新建/删除了当前会话：旧请求的结果不要写回新界面 */
    if (!turn.root.isConnected) return;

    if (res.ok) {
      if (res.sessionId) state.currentSessionId = res.sessionId;
      if (res.model && res.model !== state.cfg.model) {
        state.cfg.model = res.model;
        updateMeta();
      }
      setSessionTitle(res.title);
      const { list, byUrl } = buildSources(res.toolCalls);
      if (list.length) {
        turn.content = insertCitations(turn.content, res.annotations, byUrl);
        turn.sources = list;
      }
      finishSearchBox(turn, list.length);
      finalizeTurn(turn);
      renderSources(turn, list);
      setUsage(res.usage, res.sessionUsage);
      if (!el.sessionsPanel.classList.contains('hidden')) refreshSessions();
    } else if (res.aborted) {
      if (res.sessionId) state.currentSessionId = res.sessionId;
      turn.content = res.content || turn.content;
      const partial = buildSources(res.toolCalls);
      if (partial.list.length) {
        turn.content = insertCitations(turn.content, res.annotations, partial.byUrl);
        turn.sources = partial.list;
      }
      finishSearchBox(turn, partial.list.length);
      finalizeTurn(turn, '已停止生成');
      renderSources(turn, partial.list);
      setUsage(res.usage ? { ...res.usage, partial: true } : null, null);
    } else if (res.error === 'NO_KEY') {
      turn.root.remove();
      state.turns = state.turns.filter((t) => t !== turn);
      openSettings();
      setKeyHint('请先填写 API KEY', 'bad');
    } else {
      turn.root.remove();
      state.turns = state.turns.filter((t) => t !== turn);
      const actions = [{ label: '重试', fn: () => submitText(text, effort, images, docs) }];
      if (res.status === 401 || res.status === 402) {
        actions.unshift({ label: '打开设置', fn: openSettings });
      }
      appendError(res.error || '请求失败', actions);
    }
  } finally {
    if (state.renderTimer) {
      clearTimeout(state.renderTimer);
      state.renderTimer = null;
    }
    state.cur = null;
    setBusy(false);
    if (el.input.value === '') el.input.focus();
  }
}

async function submitText(text, effort, images, docs) {
  el.input.value = text;
  if (images && images.length) {
    state.images = images.map((img) => ({ ...img }));
  }
  if (docs && docs.length) {
    state.docs = docs.map((doc) => ({ ...doc }));
  }
  if ((images && images.length) || (docs && docs.length)) renderAttachRow();
  if (effort && effort !== state.cfg.effort) {
    state.cfg.effort = effort;
    updateMeta();
    await window.api.saveConfig({ effort });
  }
  await submit();
}

/* ---------- 设置 ---------- */

function setKeyHint(text, kind) {
  el.keyHint.textContent = text;
  el.keyHint.className = `field-hint${kind ? ` ${kind}` : ''}`;
}

const AUTOSTART_HINT = '登录 Windows 后自动在托盘后台启动，不弹窗口';

function setAutostartHint(text, kind) {
  el.autostartHint.textContent = text || AUTOSTART_HINT;
  el.autostartHint.className = `field-hint${kind ? ` ${kind}` : ''}`;
}

/* ---------- 界面字体已固定为官方风格（Inter + 系统中文） ---------- */

function currentModel() {
  return (state.cfg.models || []).find((m) => m.id === state.cfg.model) || null;
}

function updateMeta() {
  if (!state.cfg) return;
  const m = currentModel();
  el.modelTag.textContent = m ? m.label : 'DeepSeek-V4.1-Flash';
  el.metaModel.textContent = m ? m.label : state.cfg.model;
  el.metaHotkey.textContent = state.cfg.hotkey || '未注册';
  el.metaPath.textContent = state.cfg.configPath || '-';
  el.metaVersion.textContent = state.cfg.version || '-';
  el.effortLabel.textContent = EFFORT_LABELS[state.cfg.effort] || 'High';
  el.btnThinking.classList.toggle('on', state.cfg.effort !== 'off');
  el.btnSearch.classList.toggle('on', state.cfg.search === true);
}

/* ---------- 全屏与快捷键 ---------- */

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift']);
const NAMED_SHORTCUT_KEYS = new Set([
  'Enter',
  'Tab',
  'Backspace',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

const SHORTCUT_DEFAULTS = { fullscreen: 'Alt+Enter', newline: 'Shift+Enter' };
const SHORTCUT_FIELDS = { fullscreen: 'fullscreenHotkey', newline: 'newlineHotkey' };

/* 这些组合在输入框/系统里有固定含义，不允许覆盖 */
const RESERVED_SHORTCUTS = new Set([
  'Ctrl+A',
  'Ctrl+C',
  'Ctrl+V',
  'Ctrl+X',
  'Ctrl+Z',
  'Ctrl+Y',
  'Ctrl+F',
  'Ctrl+S',
  'Ctrl+P',
  'Ctrl+N',
  'Ctrl+O',
  'Ctrl+R',
  'Ctrl+W',
  'Ctrl+L',
  'Ctrl+T',
  'Ctrl+Backspace',
  'Ctrl+Delete',
  'Ctrl+Space',
  'Ctrl+Home',
  'Ctrl+End',
  'Ctrl+PageUp',
  'Ctrl+PageDown',
  'Ctrl+ArrowLeft',
  'Ctrl+ArrowRight',
  'Ctrl+ArrowUp',
  'Ctrl+ArrowDown',
  'Ctrl+Shift+R',
  'Ctrl+Shift+ArrowLeft',
  'Ctrl+Shift+ArrowRight',
  'Ctrl+Shift+Z',
  'Ctrl+Shift+S',
  'Ctrl+Shift+I',
  'Ctrl+Shift+J',
  'Ctrl+Shift+C',
  'Ctrl+Shift+V',
  'Alt+F4',
  'Alt+Tab',
  'Alt+Space',
  'Alt+ArrowLeft',
  'Alt+ArrowRight',
  'Alt+Home',
  'Ctrl+Alt+Space',
]);

let recordingShortcut = false;
let recordingTarget = null;

function shortcutHintEl(target) {
  return target === 'fullscreen' ? el.fullscreenKeyHint : el.newlineKeyHint;
}

function shortcutButtonEl(target) {
  return target === 'fullscreen' ? el.fullscreenKeyBtn : el.newlineKeyBtn;
}

function shortcutConfigValue(target) {
  return state.cfg?.[SHORTCUT_FIELDS[target]] || SHORTCUT_DEFAULTS[target];
}

function shortcutKeyFromEvent(e) {
  const key = e.key;
  if (!key || MODIFIER_KEYS.has(key)) return '';
  if (key === ' ') return 'Space';
  if (key.length === 1 && /[a-z0-9]/i.test(key)) return key.toUpperCase();
  if (/^F([1-9]|1[0-2])$/.test(key)) return key;
  if (NAMED_SHORTCUT_KEYS.has(key)) return key;
  return '';
}

/** 生成统一格式的快捷键串；Meta 不支持 */
function shortcutFromEvent(e) {
  if (e.isComposing || e.metaKey) return '';
  const key = shortcutKeyFromEvent(e);
  if (!key) return '';
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return [...mods, key].join('+');
}

function isShortcutValidFor(target, combo) {
  const parts = combo.split('+');
  const key = parts.pop();
  const mods = parts;
  const hasMainMod = mods.some((m) => m === 'Ctrl' || m === 'Alt');
  if (target === 'fullscreen') return hasMainMod;
  return hasMainMod || (mods.length === 1 && mods[0] === 'Shift' && key === 'Enter');
}

function shortcutConflict(target, combo) {
  const other = target === 'fullscreen' ? 'newline' : 'fullscreen';
  if (combo === shortcutConfigValue(other)) {
    return `和${other === 'fullscreen' ? '全屏' : '换行'}快捷键冲突`;
  }
  if (combo === state.cfg.hotkey || combo === state.cfg.expectedHotkey) {
    return '和呼出窗口的全局热键冲突';
  }
  if (RESERVED_SHORTCUTS.has(combo)) return '这是系统或编辑快捷键，请换一个';
  return '';
}

function setShortcutHint(target, text, kind = '') {
  const hint = shortcutHintEl(target);
  hint.textContent = text;
  hint.classList.toggle('hidden', !text);
  hint.classList.toggle('ok', Boolean(text) && kind === 'ok');
  hint.classList.toggle('bad', Boolean(text) && kind === 'bad');
}

function renderShortcutButton(target) {
  shortcutButtonEl(target).textContent = shortcutConfigValue(target);
}

function renderShortcutButtons() {
  renderShortcutButton('fullscreen');
  renderShortcutButton('newline');
  el.btnFullscreen.title = `${state.fullscreen ? '退出全屏' : '全屏'}（${shortcutConfigValue(
    'fullscreen',
  )}）`;
}

function stopShortcutRecording() {
  recordingShortcut = false;
  recordingTarget = null;
  el.fullscreenKeyBtn.classList.remove('recording');
  el.newlineKeyBtn.classList.remove('recording');
  renderShortcutButtons();
}

function startShortcutRecording(target) {
  if (!state.cfg) return;
  if (recordingShortcut) stopShortcutRecording();
  recordingShortcut = true;
  recordingTarget = target;
  const btn = shortcutButtonEl(target);
  btn.classList.add('recording');
  btn.textContent = '按下新的快捷键…';
  setShortcutHint(target, '按下组合键，Esc 取消');
  btn.focus();
}

async function saveShortcut(target, combo) {
  if (!isShortcutValidFor(target, combo)) {
    setShortcutHint(
      target,
      target === 'fullscreen' ? '全屏快捷键需要包含 Ctrl 或 Alt' : '换行只能用 Shift+Enter，或 Ctrl/Alt 组合',
      'bad',
    );
    return;
  }
  const conflict = shortcutConflict(target, combo);
  if (conflict) {
    setShortcutHint(target, conflict, 'bad');
    return;
  }

  state.cfg[SHORTCUT_FIELDS[target]] = combo;
  stopShortcutRecording();
  setShortcutHint(target, `已保存：${combo}`, 'ok');
  await window.api.saveConfig({ [SHORTCUT_FIELDS[target]]: combo });
}

function resetShortcut(target) {
  if (recordingShortcut) stopShortcutRecording();
  const combo = SHORTCUT_DEFAULTS[target];
  const conflict = shortcutConflict(target, combo);
  if (conflict) {
    setShortcutHint(target, conflict, 'bad');
    return;
  }
  saveShortcut(target, combo);
}

function handleShortcutRecording(e) {
  e.preventDefault();
  e.stopPropagation();
  const target = recordingTarget;
  if (!target) return;

  if (e.key === 'Escape') {
    stopShortcutRecording();
    setShortcutHint(target, '已取消，仍使用原来的快捷键');
    return;
  }
  if (MODIFIER_KEYS.has(e.key)) {
    setShortcutHint(target, '再按一个非修饰键…');
    return;
  }
  if (e.metaKey) {
    setShortcutHint(target, '不支持 Win/Meta 键，请只用 Ctrl / Alt / Shift', 'bad');
    return;
  }
  const combo = shortcutFromEvent(e);
  if (!combo) {
    setShortcutHint(target, '需要 Ctrl / Alt / Shift 加一个键', 'bad');
    return;
  }
  saveShortcut(target, combo);
}

function applyFullscreen(on) {
  state.fullscreen = Boolean(on);
  document.body.classList.toggle('fullscreen', state.fullscreen);
  el.btnFullscreen.innerHTML = `<svg viewBox="0 0 24 24">${
    state.fullscreen ? ICON_COMPRESS : ICON_EXPAND
  }</svg>`;
  renderShortcutButtons();
  syncContentWidth();
}

async function toggleFullscreen() {
  const res = await window.api.setFullscreen(!state.fullscreen);
  if (res && res.ok) applyFullscreen(res.fullscreen);
}

/* ---------- 窗口置顶 ---------- */

/** 只有标题栏图钉一个入口，状态以主进程为准 */
function applyPinned(on) {
  state.pinned = Boolean(on);
  if (state.cfg) state.cfg.pinned = state.pinned;
  el.btnPin.classList.toggle('on', state.pinned);
  el.btnPin.title = state.pinned ? '取消置顶' : '窗口置顶';
  el.btnPin.setAttribute('aria-pressed', state.pinned ? 'true' : 'false');
}

async function setPinned(value) {
  const res = await window.api.setPinned(value);
  /* 主进程说了算：失败时按旧状态回滚，别让界面显示成已生效 */
  applyPinned(res && res.ok ? res.pinned : state.pinned);
}

/* ---------- 主题 ---------- */

const THEME_CHOICES = ['dark', 'light', 'system'];

function resolveTheme(choice) {
  if (choice === 'light' || choice === 'dark') return choice;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** 应用主题：写到 <html data-theme>，并同步设置面板里的选中态 */
function applyTheme(choice) {
  const theme = THEME_CHOICES.includes(choice) ? choice : 'dark';
  document.documentElement.dataset.theme = resolveTheme(theme);
  /* 缓存一份给 theme-boot.js，下次启动首帧就是正确主题 */
  try {
    localStorage.setItem('dsq-theme', theme);
  } catch (_) {
    /* localStorage 不可用时忽略，只影响首帧 */
  }
  for (const btn of el.themeSwitch.querySelectorAll('.theme-opt')) {
    const on = btn.dataset.themeChoice === theme;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

/* 选了“跟随系统”时，系统深浅色变化要实时生效 */
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (state.cfg && state.cfg.theme === 'system') applyTheme('system');
});

/* ---------- 正文缩放 ---------- */

const ZOOM_MIN = 1;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.05;
const ZOOM_COMMIT_DELAY = 160;

function clampZoom(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(n * 100) / 100));
}

function currentZoomScale() {
  return (
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--content-zoom')) || 1
  );
}

/** 内容宽度固定为流区域的原始宽度：zoom 时换行位置才不会被挤窄 */
function syncContentWidth() {
  const s = el.stream;
  if (!s) return;

  const cs = getComputedStyle(s);
  const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  let baseW = Math.max(0, s.clientWidth - pad);

  /* 全屏时流区域会随 zoom 变宽，但正文基准宽度仍固定在 960px 内，
     否则放大后行宽变化，换行位置会跳 */
  if (state.fullscreen) baseW = Math.min(baseW, 960 - pad);

  if (baseW > 0) el.streamInner.style.width = `${baseW}px`;
}

/* 捏合过程中只在合成器里做 transform（不触发布局，所以跟手）；
   停手后再落到 CSS zoom，浏览器重新栅格化，文字恢复清晰 */
let zoomGesture = null;
let zoomCommitTimer = 0;

function beginZoomGesture(focus) {
  const s = el.stream;
  const rect = s.getBoundingClientRect();
  const cs = getComputedStyle(s);
  const z = currentZoomScale();
  const vx = focus.x - rect.left;
  const vy = focus.y - rect.top;
  const ox = (s.scrollLeft + vx - (parseFloat(cs.paddingLeft) || 0)) / z;
  const oy = (s.scrollTop + vy - (parseFloat(cs.paddingTop) || 0)) / z;

  zoomGesture = { z, target: z, ox, oy };
  const inner = el.streamInner;
  inner.style.willChange = 'transform';
  inner.style.transition = 'transform 60ms linear';
  inner.style.transformOrigin = `${ox}px ${oy}px`;
  inner.style.transform = 'scale(1)';
}

function zoomBy(delta, focus) {
  if (!zoomGesture) beginZoomGesture(focus);
  const g = zoomGesture;
  if (!g) return;

  const next = clampZoom(g.target + delta);
  if (next === g.target) return;
  g.target = next;

  el.streamInner.style.transform = `scale(${next / g.z})`;
  showZoomHint(next);
  clearTimeout(zoomCommitTimer);
  zoomCommitTimer = setTimeout(commitZoomGesture, ZOOM_COMMIT_DELAY);
}

function commitZoomGesture() {
  clearTimeout(zoomCommitTimer);
  zoomCommitTimer = 0;
  const g = zoomGesture;
  if (!g) return;
  zoomGesture = null;

  const s = el.stream;
  const inner = el.streamInner;
  const target = g.target;
  const sx = s.scrollLeft;
  const sy = s.scrollTop;

  document.documentElement.style.setProperty('--content-zoom', String(target));
  inner.style.transition = 'none';
  inner.style.transform = '';
  inner.style.transformOrigin = '';
  inner.style.willChange = '';

  /* 保持捏合中心下的内容不动，再切到最终 zoom */
  s.scrollLeft = sx + g.ox * (target - g.z);
  s.scrollTop = sy + g.oy * (target - g.z);

  state.cfg.zoom = target;
  persistZoom(target);
  updateToBottom();
}

/** 直接落定缩放（启动、打开设置时用）；有正在进行的手势先结算 */
function applyZoom(value, focus) {
  if (zoomGesture) commitZoomGesture();

  const scale = clampZoom(value);
  const s = el.stream;
  const current = currentZoomScale();
  const atBottom = s.scrollHeight - s.scrollTop - s.clientHeight < 80;

  let contentX = 0;
  let contentY = 0;
  let vx = 0;
  let vy = 0;
  let padLeft = 0;
  let padTop = 0;

  if (focus) {
    const rect = s.getBoundingClientRect();
    const cs = getComputedStyle(s);
    padLeft = parseFloat(cs.paddingLeft) || 0;
    padTop = parseFloat(cs.paddingTop) || 0;
    vx = focus.x - rect.left;
    vy = focus.y - rect.top;
    contentX = (s.scrollLeft + vx - padLeft) / current;
    contentY = (s.scrollTop + vy - padTop) / current;
  }

  document.documentElement.style.setProperty('--content-zoom', String(scale));

  if (focus) {
    s.scrollLeft = padLeft + contentX * scale - vx;
    s.scrollTop = padTop + contentY * scale - vy;
  } else if (atBottom) {
    s.scrollTop = s.scrollHeight;
  }

  updateToBottom();
  return scale;
}

window.addEventListener('resize', () => {
  if (zoomGesture) commitZoomGesture();
  syncContentWidth();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) commitZoomGesture();
});
window.addEventListener('blur', commitZoomGesture);

let zoomSaveTimer = 0;
function persistZoom(scale) {
  clearTimeout(zoomSaveTimer);
  zoomSaveTimer = setTimeout(() => {
    zoomSaveTimer = 0;
    window.api.saveConfig({ zoom: scale });
  }, 300);
}

let zoomHintTimer = 0;
function showZoomHint(zoom) {
  el.zoomHint.textContent = `${Math.round(zoom * 100)}%`;
  el.zoomHint.classList.add('show');
  clearTimeout(zoomHintTimer);
  zoomHintTimer = setTimeout(() => el.zoomHint.classList.remove('show'), 900);
}

/* ---------- 下拉菜单：模型 / 推理等级 ---------- */

let openMenuEl = null;
let openMenuAnchor = null;

function buildMenus() {
  const models = state.cfg.models || [];
  el.menuModel.innerHTML =
    '<div class="menu-title">模型</div>' +
    models
      .map(
        (m) =>
          `<button class="menu-item${m.id === state.cfg.model ? ' current' : ''}" role="menuitem" data-value="${m.id}">` +
          `<span class="item-label">${m.label}</span>${ICON_CHECK}</button>`
      )
      .join('');

  const efforts = state.cfg.efforts || [];
  el.menuEffort.innerHTML =
    '<div class="menu-title">推理等级</div>' +
    efforts
      .map(
        (v) =>
          `<button class="menu-item${v === state.cfg.effort ? ' current' : ''}" role="menuitem" data-value="${v}">` +
          `<span class="item-label">${EFFORT_LABELS[v] || v}</span>${ICON_CHECK}</button>`
      )
      .join('');
}

function closeMenus() {
  if (!openMenuEl) return;
  openMenuEl.classList.add('hidden');
  if (openMenuAnchor) openMenuAnchor.classList.remove('open');
  openMenuEl = null;
  openMenuAnchor = null;
}

function openMenu(menu, anchor, place) {
  closeMenus();
  menu.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const gap = 7;
  const left = clamp(r.left, 8, window.innerWidth - w - 8);
  const top = place === 'up' ? clamp(r.top - h - gap, 8, window.innerHeight - h - 8) : clamp(r.bottom + gap, 8, window.innerHeight - h - 8);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  openMenuEl = menu;
  openMenuAnchor = anchor;
  anchor.classList.add('open');
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(v, max));
}

function bindMenu(btn, menu, place) {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (openMenuEl === menu) return closeMenus();
    buildMenus();
    openMenu(menu, btn, place);
  });
  menu.addEventListener('click', async (e) => {
    const item = e.target.closest('.menu-item');
    if (!item) return;
    e.stopPropagation();
    const value = item.dataset.value;
    closeMenus();

    if (menu === el.menuModel) {
      if (value === state.cfg.model) return;
      state.cfg.model = value;
      updateMeta();
      await window.api.saveConfig({ model: value });
    } else {
      if (value === state.cfg.effort) return;
      state.cfg.effort = value;
      updateMeta();
      await window.api.saveConfig({ effort: value });
    }
  });
}

async function openSettings() {
  /* 刚捏合过的话先把待保存的缩放落盘，避免读完配置又被拉回去 */
  if (zoomSaveTimer) {
    clearTimeout(zoomSaveTimer);
    zoomSaveTimer = 0;
    await window.api.saveConfig({ zoom: state.cfg.zoom });
  }
  state.cfg = await window.api.getConfig();
  applyTheme(state.cfg.theme);
  applyZoom(state.cfg.zoom);
  applyPinned(state.cfg.pinned === true);
  updateMeta();
  stopShortcutRecording();
  renderShortcutButtons();
  el.startFullscreenInput.checked = state.cfg.startFullscreen === true;
  el.autostartInput.checked = state.cfg.autostart === true;
  setAutostartHint('');
  setShortcutHint('fullscreen', '');
  setShortcutHint('newline', '');
  el.apiKeyInput.value = state.cfg.hasKey ? state.cfg.apiKeyMasked : '';
  el.apiKeyInput.type = 'password';
  setKeyHint(
    state.cfg.hasKey
      ? '已保存 Key（以掩码显示，重新输入可覆盖）'
      : '在 platform.deepseek.com 创建后粘贴，可先“测试连通”再保存',
  );
  el.settings.classList.remove('hidden');
  const body = el.settings.querySelector('.settings-body');
  if (body) body.scrollTop = 0;
  el.apiKeyInput.focus();
  el.apiKeyInput.select();
}

function closeSettings() {
  if (recordingShortcut) stopShortcutRecording();
  el.settings.classList.add('hidden');
  el.input.focus();
}

async function saveKey() {
  const raw = el.apiKeyInput.value.trim();
  if (!raw || raw.includes('****')) {
    setKeyHint('请输入完整 Key（当前显示的是掩码）', 'bad');
    return;
  }
  if (!raw.startsWith('sk-')) {
    setKeyHint('Key 通常以 sk- 开头，请确认是否复制完整', 'bad');
    return;
  }
  const res = await window.api.saveConfig({ apiKey: raw });
  if (res.ok) {
    state.cfg = await window.api.getConfig();
    updateMeta();
    el.apiKeyInput.value = state.cfg.apiKeyMasked;
    setKeyHint('已保存到本机配置文件', 'ok');
    setTimeout(closeSettings, 650);
  } else {
    setKeyHint(`保存失败：${res.error}`, 'bad');
  }
}

let keyTesting = false;
async function testKey() {
  if (keyTesting) return;

  const raw = el.apiKeyInput.value.trim();
  /* 掩码是已保存 Key 的展示形式，不能拿它去请求 */
  const typed = Boolean(raw) && !raw.includes('****');
  if (!typed && !(state.cfg && state.cfg.hasKey)) {
    setKeyHint('请先填写 API KEY 再测试', 'bad');
    el.apiKeyInput.focus();
    return;
  }
  if (typed && !raw.startsWith('sk-')) {
    setKeyHint('Key 通常以 sk- 开头，请确认是否复制完整', 'bad');
    return;
  }

  keyTesting = true;
  setKeyHint('正在测试…');
  try {
    /* 输入框里是新 Key 就直接测新的（无需先保存）；显示掩码时测已保存的。
       这里只验证连通性，不写盘——落盘只由「保存」按钮负责。 */
    const res = await window.api.testKey(typed ? raw : undefined);
    if (!res || !res.ok) {
      setKeyHint((res && res.error) || '测试失败', 'bad');
      return;
    }
    setKeyHint(typed ? '连通正常，点“保存”后生效' : '连通正常', 'ok');
  } finally {
    keyTesting = false;
  }
}

/* ---------- 事件 ---------- */

el.send.addEventListener('click', submit);

/* 选/粘贴拿到的条目统一入库：图片走压缩内联，文档走 Files API */
async function ingestItems(items) {
  const imgs = [];
  const docs = [];
  for (const item of items || []) {
    if (item.kind === 'image') {
      /* 对话框只给路径，这里逐张取回并压缩，避免一次读多张大图 */
      let dataUrl = item.dataUrl || '';
      if (!dataUrl && item.path) {
        const res = await window.api.readImage(item.path);
        if (res && res.ok) dataUrl = res.dataUrl;
      }
      if (!dataUrl) continue;
      const prepared = await prepareImage(dataUrl, item.name);
      if (prepared) imgs.push(prepared);
    } else if (item.kind === 'file') {
      docs.push(item);
    }
  }
  if (imgs.length) addImages(imgs);
  if (docs.length) addDocs(docs);
  return imgs.length + docs.length;
}

el.btnAttach.addEventListener('click', async () => {
  const res = await window.api.pickFiles();
  if (!res || !res.items?.length) return;
  await ingestItems(res.items);
  el.input.focus();
});

/* 粘贴：截图直接 Ctrl+V；从资源管理器复制的文件也走这里 */
document.addEventListener('paste', async (e) => {
  const data = e.clipboardData;
  if (!data) return;

  const types = Array.from(data.types || []);
  if (!types.includes('Files')) return; /* 纯文本保持默认行为 */

  /* 必须同步拦掉，否则文件名会被粘进输入框 */
  e.preventDefault();

  const files = Array.from(data.items || [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter(Boolean);

  const docs = await docsFromFiles(files);
  if (docs.length) addDocs(docs);

  const images = files.filter((f) => /^image\//i.test(f.type || ''));
  if (images.length) await addImagesFromFiles(images);

  if (!docs.length && !images.length) {
    /* 剪贴板里没有可取的文件，退回文本，别让粘贴变成什么都没发生 */
    const text = data.getData('text/plain');
    if (text) document.execCommand('insertText', false, text);
  }
  el.input.focus();
});

/* 拖入图片或文档 */
const panelEl = document.querySelector('.panel');
document.addEventListener('dragover', (e) => {
  if (!hasDroppable(e)) return;
  e.preventDefault();
  panelEl.classList.add('dragging');
});
document.addEventListener('dragleave', (e) => {
  if (e.relatedTarget) return;
  panelEl.classList.remove('dragging');
});
document.addEventListener('drop', async (e) => {
  if (!hasDroppable(e)) return;
  e.preventDefault();
  panelEl.classList.remove('dragging');
  const files = Array.from(e.dataTransfer.files || []);
  const images = files.filter((f) => /^image\//i.test(f.type || ''));
  if (images.length) await addImagesFromFiles(images);
  const docs = await docsFromFiles(files);
  if (docs.length) addDocs(docs);
  else if (!images.length && files.length) {
    const unsupported = files.some((f) => !/^image\//i.test(f.type || '') && !FILES_OK.includes(docExt(f.name)));
    showNotice(
      unsupported
        ? '这种文件暂不支持，可传 PDF、Word、PPT、Excel、文本、代码或图片'
        : '没能读到文件路径，请点回形针按钮选择'
    );
  }
  el.input.focus();
});

bindMenu(el.btnModel, el.menuModel, 'up');
bindMenu(el.btnThinking, el.menuEffort, 'up');

el.btnSearch.addEventListener('click', async () => {
  const on = el.btnSearch.classList.toggle('on');
  if (state.cfg) state.cfg.search = on;
  await window.api.saveConfig({ search: on });
});

document.addEventListener('click', closeMenus);
window.addEventListener('blur', closeMenus);
window.addEventListener('resize', closeMenus);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenus();
});

el.input.addEventListener('input', () => {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, 120)}px`;
  updateSendState();
});

function insertNewline() {
  const input = el.input;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.setRangeText('\n', start, end, 'end');
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

el.input.addEventListener('keydown', (e) => {
  if (e.isComposing || e.key !== 'Enter') return;
  const combo = shortcutFromEvent(e);
  if (combo && combo === (state.cfg?.newlineHotkey || 'Shift+Enter')) {
    /* Shift+Enter 直接交给浏览器，保留原生换行和撤销栈 */
    if (combo === 'Shift+Enter') return;
    e.preventDefault();
    insertNewline();
    return;
  }
  /* 改键后仍保留 Shift+Enter 这个最常用的换行习惯 */
  if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) return;
  e.preventDefault();
  if (!e.shiftKey) submit();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!el.settings.classList.contains('hidden')) {
    closeSettings();
    return;
  }
  if (!el.sessionsPanel.classList.contains('hidden')) {
    closeSessions();
    return;
  }
  if (state.fullscreen) return;
  window.api.hide();
});

el.btnNew.addEventListener('click', newSession);
el.btnNewSession.addEventListener('click', newSession);
el.btnSessions.addEventListener('click', openSessions);
el.btnSessionsClose.addEventListener('click', closeSessions);
el.toBottom.addEventListener('click', () => {
  el.stream.scrollTo({ top: el.stream.scrollHeight, behavior: 'smooth' });
});
el.stream.addEventListener('scroll', updateToBottom);

let clearTimer = null;
el.btnClearAll.addEventListener('click', async () => {
  if (!el.btnClearAll.classList.contains('confirm')) {
    el.btnClearAll.classList.add('confirm');
    el.btnClearAll.textContent = '确认清空全部？';
    clearTimer = setTimeout(() => {
      el.btnClearAll.classList.remove('confirm');
      el.btnClearAll.textContent = '清空全部会话';
    }, 3000);
    return;
  }
  clearTimeout(clearTimer);
  el.btnClearAll.classList.remove('confirm');
  el.btnClearAll.textContent = '清空全部会话';
  await clearAllSessions();
});

el.btnClose.addEventListener('click', () => window.api.hide());
el.btnSettings.addEventListener('click', openSettings);
el.btnSettingsClose.addEventListener('click', closeSettings);
el.btnFullscreen.addEventListener('click', toggleFullscreen);
el.btnPin.addEventListener('click', () => setPinned(!state.pinned));
el.fullscreenKeyBtn.addEventListener('click', () => {
  if (recordingShortcut && recordingTarget === 'fullscreen') {
    stopShortcutRecording();
    setShortcutHint('fullscreen', '已取消，仍使用原来的快捷键');
  } else {
    startShortcutRecording('fullscreen');
  }
});
el.newlineKeyBtn.addEventListener('click', () => {
  if (recordingShortcut && recordingTarget === 'newline') {
    stopShortcutRecording();
    setShortcutHint('newline', '已取消，仍使用原来的快捷键');
  } else {
    startShortcutRecording('newline');
  }
});
el.fullscreenKeyReset.addEventListener('click', () => resetShortcut('fullscreen'));
el.newlineKeyReset.addEventListener('click', () => resetShortcut('newline'));
el.settings.addEventListener('click', (e) => {
  if (!recordingShortcut) return;
  if (e.target instanceof Element && e.target.closest('.shortcut-btn')) return;
  const target = recordingTarget;
  stopShortcutRecording();
  if (target) setShortcutHint(target, '已取消，仍使用原来的快捷键');
});
el.startFullscreenInput.addEventListener('change', () => {
  state.cfg.startFullscreen = el.startFullscreenInput.checked;
  window.api.saveConfig({ startFullscreen: state.cfg.startFullscreen });
});

/* 开机自启直接落在注册表 Run 键，以主进程回读的状态为准 */
el.autostartInput.addEventListener('change', async () => {
  const res = await window.api.setAutostart(el.autostartInput.checked);
  state.cfg.autostart = Boolean(res && res.enabled);
  el.autostartInput.checked = state.cfg.autostart;
  setAutostartHint(res && res.ok ? '' : `设置失败：${(res && res.error) || '未知错误'}`, res && res.ok ? '' : 'bad');
});

document.addEventListener(
  'keydown',
  (e) => {
    if (recordingShortcut) {
      handleShortcutRecording(e);
      return;
    }
    if (!state.cfg) return;
    const combo = shortcutFromEvent(e);
    if (!combo || combo !== shortcutConfigValue('fullscreen')) return;
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) toggleFullscreen();
  },
  true,
);

window.addEventListener('blur', () => {
  if (!recordingShortcut) return;
  const target = recordingTarget;
  stopShortcutRecording();
  if (target) setShortcutHint(target, '已取消，仍使用原来的快捷键');
});

el.btnSaveKey.addEventListener('click', saveKey);
el.btnTestKey.addEventListener('click', testKey);

/* 触控板双指捏合：Chromium 以 ctrl+wheel 送达，只缩放对话内容 */
window.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey || !e.deltaY) return;
    if (!(e.target instanceof Element) || !e.target.closest('.stream')) return;
    e.preventDefault();
    if (!state.cfg || !el.streamInner.firstElementChild) return;

    const base = zoomGesture ? zoomGesture.target : clampZoom(state.cfg.zoom);
    const next = clampZoom(base + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
    if (next === base) return;

    zoomBy(next - base, { x: e.clientX, y: e.clientY });
  },
  { passive: false },
);

el.themeSwitch.addEventListener('click', async (e) => {
  const btn = e.target.closest('.theme-opt');
  if (!btn) return;
  const choice = btn.dataset.themeChoice;
  if (!THEME_CHOICES.includes(choice) || choice === state.cfg.theme) return;
  state.cfg.theme = choice;
  applyTheme(choice);
  await window.api.saveConfig({ theme: choice });
});

el.apiKeyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveKey();
});

let noticeTimer = null;
function showNotice(msg, ms = 4200) {
  el.notice.textContent = msg;
  el.notice.classList.remove('hidden');
  clearTimeout(noticeTimer);
  /* ms 传 0 表示常驻，等用户处理 */
  if (ms > 0) noticeTimer = setTimeout(() => el.notice.classList.add('hidden'), ms);
}

/* 推理内容可能很长，按帧刷新，别让每个 token 都改一次 DOM */
let reasonRaf = 0;
function scheduleReasonRender(turn) {
  if (reasonRaf) return;
  reasonRaf = requestAnimationFrame(() => {
    reasonRaf = 0;
    if (!turn.reasonBody) return;
    turn.reasonBody.textContent = turn.reasoning;
    turn.reasonBody.scrollTop = turn.reasonBody.scrollHeight;
  });
}

window.api.onDelta((delta) => {
  const turn = state.cur;
  if (!turn) return;
  if (delta.kind === 'reasoning') {
    turn.reasoning += delta.text;
    if (turn.reasonBody) scheduleReasonRender(turn);
  } else {
    turn.content += delta.text;
    scheduleRender();
  }
});

window.api.onTool((evt) => {
  const turn = state.cur;
  if (!turn) return;
  handleToolEvent(turn, evt);
});

/* 服务端读不了链接、改走本地读取：丢掉“读不到”的那段回答，重新生成 */
window.api.onReset(() => {
  const turn = state.cur;
  if (!turn) return;
  if (state.renderTimer) {
    clearTimeout(state.renderTimer);
    state.renderTimer = null;
  }
  turn.content = '';
  turn.reasoning = '';
  turn.answer.innerHTML = '';
  if (turn.reasonBody) turn.reasonBody.textContent = '';
  scrollBottom(false);
});

window.api.onLocalRead((pages) => {
  const turn = state.cur;
  if (!turn) return;
  applyLocalRead(turn, pages);
  scrollBottom(false);
});

/* 文件上传/解析进度：直接改气泡里对应卡片的状态文案 */
window.api.onUpload((info) => {
  const turn = state.cur;
  if (!turn || !turn.docEls) return;
  const card = turn.docEls[info.index];
  if (!card || !card.metaEl) return;
  if (info.stage === 'start') {
    card.metaEl.classList.remove('bad');
    card.metaEl.textContent = '解析中…';
  } else if (info.stage === 'done') {
    card.metaEl.classList.remove('bad');
    card.metaEl.textContent = fmtSize(card.docRef?.bytes) || '已解析';
  } else {
    card.metaEl.classList.add('bad');
    card.metaEl.textContent = info.message || '失败';
  }
  scrollBottom(false);
});

window.api.onNotice((info) => {
  if (!info || !info.text) return;
  showNotice(info.text);
});

window.api.onShown(() => {
  el.input.focus();
  el.input.select();
});

window.api.onOpenSettings(() => openSettings());
window.api.onFullscreen((value) => applyFullscreen(value));
window.api.onPinned((value) => applyPinned(value));

window.api.onSessionCreated(() => {
  if (state.busy) window.api.abort();
  state.currentSessionId = null;
  state.cur = null;
  clearDom();
  setSessionTitle('');
  el.input.value = '';
  clearAttach();
  el.input.focus();
});

/* ---------- 启动 ---------- */

(async function boot() {
  state.cfg = await window.api.getConfig();
  applyTheme(state.cfg.theme);
  syncContentWidth();
  applyZoom(state.cfg.zoom);
  applyFullscreen(state.cfg.fullscreen === true);
  applyPinned(state.cfg.pinned === true);
  /* 图片走独立的内联通道，这里只保留文档扩展名 */
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
  FILES_OK = (Array.isArray(state.cfg.fileExts) ? state.cfg.fileExts : []).filter((e) => !imageExts.includes(e));
  if (state.cfg.limits?.images) MAX_IMAGES = state.cfg.limits.images;
  if (state.cfg.limits?.files) MAX_DOCS = state.cfg.limits.files;
  updateMeta();

  if (!state.cfg.hotkey) {
    showNotice(`全局热键 ${state.cfg.expectedHotkey} 注册失败，已被其他程序占用。可先用托盘图标打开，或在设置里查看。`, 0);
  }

  if (!state.cfg.hasKey) setTimeout(openSettings, 260);

  await window.api.createSession();
  await refreshSessions();
  el.input.focus();
  updateSendState();
})();
