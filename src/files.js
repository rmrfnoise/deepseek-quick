'use strict';

/**
 * Files API：把本地文件传到 DeepSeek，拿回 file_id 在对话里引用。
 * 官方文档：/guides/files_api 与 /guides/document_parsing
 *
 * 三种 purpose：
 *   user_data               纯文本、代码、表格（xlsx/xls）、电子书（epub/mobi）——免费转 Markdown
 *   text_recognition        PDF / Word / PPT / 扫描件，只取文字
 *   rich_layout_recognition 同上，另把文档里的图表裁出来一起给模型
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { dataDir } = require('./paths');

const HOST = 'api.deepseek.com';
const FILES_PATH = '/files';

/* 文档解析（purpose 走 text/rich） */
const DOC_EXT = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx']);
/* 扫描件：当图片交给解析器取文字 */
const SCAN_EXT = new Set(['bmp', 'tif', 'tiff']);
/* 免解析，服务端转 Markdown */
const PLAIN_EXT = new Set([
  'txt', 'text', 'md', 'markdown', 'csv', 'json', 'jsonl', 'xml', 'yaml', 'yml', 'toml', 'ini', 'conf',
  'log', 'tex', 'rst', 'sql', 'html', 'htm', 'css', 'scss', 'less',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'svelte',
  'py', 'java', 'kt', 'go', 'rs', 'rb', 'php', 'swift', 'cs', 'c', 'h', 'cpp', 'cc', 'hpp', 'm', 'mm',
  'sh', 'bash', 'zsh', 'ps1', 'bat', 'lua', 'pl', 'r', 'dart', 'scala', 'gradle', 'properties',
]);
const SHEET_EXT = new Set(['xlsx', 'xls']);
const BOOK_EXT = new Set(['epub', 'mobi']);

const MiB = 1024 * 1024;
const MAX_DOC_BYTES = 100 * MiB; /* PDF / Word / PPT */
const MAX_PLAIN_BYTES = 32 * MiB; /* 文本、表格、电子书 */

const MIME = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  epub: 'application/epub+zip',
  mobi: 'application/x-mobipocket-ebook',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
};

function extOf(file) {
  return String(path.extname(file || '')).replace('.', '').toLowerCase();
}

/** 文件选择框里列出的扩展名 */
const SUPPORTED = [
  ...new Set([...DOC_EXT, ...SCAN_EXT, ...PLAIN_EXT, ...SHEET_EXT, ...BOOK_EXT, 'jpg', 'jpeg', 'png', 'gif', 'webp']),
].sort();

/** 该文件走哪种解析方式；不支持时返回 null */
function pickPurpose(file) {
  const ext = extOf(file);
  if (DOC_EXT.has(ext)) return 'rich_layout_recognition';
  if (SCAN_EXT.has(ext)) return 'text_recognition';
  if (PLAIN_EXT.has(ext) || SHEET_EXT.has(ext) || BOOK_EXT.has(ext)) return 'user_data';
  return null;
}

function limitOf(purpose) {
  return purpose === 'user_data' ? MAX_PLAIN_BYTES : MAX_DOC_BYTES;
}

/* ---------- 上传结果缓存：同一文件不重复上传，避免重复付解析费 ---------- */

let cache = null;

/* 服务端的 file_id 可能被清理，超过 30 天的缓存视为过期，重新上传 */
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;

function cachePath() {
  return path.join(dataDir(), 'filecache.json');
}

/** 丢掉过期条目 */
function pruneCache() {
  const now = Date.now();
  for (const key of Object.keys(cache || {})) {
    const entry = cache[key];
    if (!entry || typeof entry.at !== 'number' || now - entry.at > CACHE_TTL) {
      delete cache[key];
    }
  }
}

function loadCache() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
    cache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    cache = {};
  }
  pruneCache();
  return cache;
}

function saveCache() {
  try {
    const keys = Object.keys(cache || {});
    /* 只保留最近 300 条，别让这个文件无限长 */
    if (keys.length > 300) {
      const keep = keys
        .sort((a, b) => (cache[b].at || 0) - (cache[a].at || 0))
        .slice(0, 300);
      const next = {};
      for (const k of keep) next[k] = cache[k];
      cache = next;
    }
    fs.writeFileSync(cachePath(), JSON.stringify(cache), 'utf8');
  } catch (_) {
    /* 缓存写不进去不影响使用 */
  }
}

function abortError() {
  const e = new Error('已停止');
  e.name = 'AbortError';
  return e;
}

function hashFile(file, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortError());
      return;
    }
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(file);
    const onAbort = () => {
      try {
        rs.destroy(abortError());
      } catch (_) {
        /* 已关闭 */
      }
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const clean = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    rs.on('data', (c) => h.update(c));
    rs.on('end', () => {
      clean();
      resolve(h.digest('hex'));
    });
    rs.on('error', (err) => {
      clean();
      reject(err);
    });
  });
}

/* ---------- 上传 ---------- */

/**
 * 手工拼 multipart：官方要求 purpose 字段必须排在 file 之前，且大文件要流式发。
 * 解析在上传过程中完成，成功后才返回响应，所以超时给足。
 * signal 用于“停止生成”：中断时直接销毁请求和文件流。
 */
function post({ filePath, purpose, apiKey, signal }) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortError());
      return;
    }

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (err) {
      reject(new Error('读不到这个文件'));
      return;
    }

    const rawName = path.basename(filePath);
    const name = rawName.replace(/["\\\r\n]/g, '_').slice(0, 200);
    const boundary = `----dsp${crypto.randomBytes(12).toString('hex')}`;
    const mime = MIME[extOf(filePath)] || 'application/octet-stream';

    const head = Buffer.from(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="purpose"\r\n\r\n' +
        `${purpose}\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${name}"\r\n` +
        `Content-Type: ${mime}\r\n\r\n`,
      'utf8'
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');

    let req = null;
    let rs = null;
    let settled = false;
    let onAbort = null;

    const cleanup = () => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        rs?.destroy();
      } catch (_) {
        /* 已关闭 */
      }
      reject(err);
    };
    const done = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    req = https.request(
      {
        host: HOST,
        path: FILES_PATH,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': head.length + stat.size + tail.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', (err) => fail(err));
        res.on('aborted', () => fail(new Error('上传中断')));
        res.on('end', () => {
          if (settled) return;
          const body = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(body);
          } catch (_) {
            /* 非 JSON 响应，下面按状态码报错 */
          }
          if (res.statusCode === 200 && json && json.id) return done(json);

          const err = new Error(friendly(res.statusCode, json));
          err.status = res.statusCode;
          err.code = json && json.error ? json.error.code : '';
          fail(err);
        });
      }
    );

    if (signal) {
      onAbort = () => {
        const err = abortError();
        try {
          req.destroy(err);
        } catch (_) {
          /* 已销毁 */
        }
        fail(err);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    req.setTimeout(360000, () => {
      const err = new Error('上传超时，请稍后重试');
      try {
        req.destroy(err);
      } catch (_) {
        /* 已销毁 */
      }
      fail(err);
    });
    req.on('error', (err) => fail(err));

    try {
      if (settled) return;
      req.write(head);
    } catch (err) {
      fail(err);
      return;
    }

    rs = fs.createReadStream(filePath);
    rs.on('error', (err) => {
      try {
        req.destroy(err);
      } catch (_) {
        /* 已销毁 */
      }
      fail(err);
    });
    rs.on('data', (chunk) => {
      if (settled) return;
      if (!req.write(chunk)) rs.pause();
    });
    req.on('drain', () => {
      if (!settled) rs.resume();
    });
    rs.on('end', () => {
      if (!settled) req.end(tail);
    });
  });
}

function friendly(status, json) {
  const detail = json && json.error ? String(json.error.message || '') : '';
  switch (status) {
    case 400:
      return detail || '文件无法解析，可能格式不支持或设有打开密码';
    case 408:
      return '上传超时，文件可能太大或网络太慢';
    case 413:
      return '文件超过大小上限';
    case 429:
      return '同时解析的文件太多，请稍后再试';
    case 500:
      return '解析结果不完整，请重试';
    case 503:
      return '服务繁忙，请稍后重试';
    case 504:
      return '解析超时，这个文件可能过于复杂';
    default:
      return detail || `上传失败（HTTP ${status}）`;
  }
}

/**
 * 把本地文件变成可引用的 file_id。
 * @returns {Promise<{fileId:string, purpose:string, name:string, bytes:number, cached:boolean}>}
 */
async function prepare({ filePath, apiKey, force = false, signal }) {
  if (signal && signal.aborted) throw abortError();
  const purpose = pickPurpose(filePath);
  if (!purpose) throw new Error('这种文件暂不支持');

  const stat = fs.statSync(filePath);
  const limit = limitOf(purpose);
  if (stat.size > limit) {
    throw new Error(`文件超过 ${Math.round(limit / MiB)} MB 上限`);
  }
  if (!stat.size) throw new Error('文件是空的');

  const name = path.basename(filePath);
  const store = loadCache();
  const hash = await hashFile(filePath, signal);
  const key = `${hash}:${purpose}`;

  if (signal && signal.aborted) throw abortError();

  const hit = store[key];
  if (!force && hit && hit.fileId && Date.now() - (hit.at || 0) <= CACHE_TTL) {
    hit.at = Date.now();
    saveCache();
    return { fileId: hit.fileId, purpose, name, bytes: stat.size, cached: true };
  }

  const uploaded = await post({ filePath, purpose, apiKey, signal });
  store[key] = { fileId: uploaded.id, name, bytes: stat.size, purpose, at: Date.now() };
  saveCache();
  return { fileId: uploaded.id, purpose, name, bytes: stat.size, cached: false };
}

module.exports = { prepare, pickPurpose, SUPPORTED };
