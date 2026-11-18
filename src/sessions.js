'use strict';

const fs = require('fs');
const path = require('path');
const { dataDir } = require('./paths');

const MAX_SESSIONS = 200;
const TITLE_MAX = 26;

let cache = null;

function filePath() {
  return path.join(dataDir(), 'sessions.json');
}

function blank() {
  return { currentId: null, sessions: [] };
}

function load() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    cache = {
      currentId: parsed.currentId || null,
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    };
  } catch (_) {
    cache = blank();
  }
  return cache;
}

function flush() {
  const data = load();
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(data), 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

function newId() {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function deriveTitle(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '新会话';
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX)}…` : t;
}

function list() {
  const data = load();
  return data.sessions
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((s) => ({
      id: s.id,
      title: s.title,
      updatedAt: s.updatedAt,
      count: s.messages.length,
    }));
}

function currentId() {
  return load().currentId;
}

function get(id) {
  return load().sessions.find((s) => s.id === id) || null;
}

function create() {
  const data = load();
  const now = Date.now();
  const s = {
    id: newId(),
    title: '新会话',
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  data.sessions.unshift(s);
  if (data.sessions.length > MAX_SESSIONS) {
    data.sessions = data.sessions.slice(0, MAX_SESSIONS);
  }
  data.currentId = s.id;
  flush();
  return s;
}

/** 只记录“当前打开的是哪一个”，不改动会话自身的时间戳 */
function setCurrent(id) {
  const data = load();
  data.currentId = id;
  flush();
}

/** 追加一轮问答；assistant 为空时只存提问。meta 携带联网检索、图片等原始记录。 */
function appendTurn(id, userText, assistantText, meta = {}) {
  const s = get(id);
  if (!s) return null;
  const question = { role: 'user', content: userText };
  if (meta.userImages?.length) question.images = meta.userImages;
  if (meta.userDocs?.length) question.docs = meta.userDocs;
  s.messages.push(question);
  if (assistantText) {
    const reply = { role: 'assistant', content: assistantText };
    if (meta.serverToolCalls?.length) reply.serverToolCalls = meta.serverToolCalls;
    if (meta.annotations?.length) reply.annotations = meta.annotations;
    if (meta.localRead?.length) reply.localRead = meta.localRead;
    if (Array.isArray(meta.usage) && meta.usage.length) reply.usage = meta.usage;
    s.messages.push(reply);
  }
  const titleSeed = userText || meta.titleText;
  if (s.title === '新会话' && titleSeed) s.title = deriveTitle(titleSeed);
  s.updatedAt = Date.now();
  flush();
  return s;
}

function remove(id) {
  const data = load();
  data.sessions = data.sessions.filter((s) => s.id !== id);
  if (data.currentId === id) data.currentId = null;
  flush();
  return data.currentId;
}

function clearAll() {
  cache = blank();
  flush();
}

/** 所有会话引用到的图片文件名，用于清理 data/images 里的孤儿文件 */
function imageFiles() {
  const used = new Set();
  for (const s of load().sessions) {
    for (const m of s.messages || []) {
      for (const img of m.images || []) {
        if (img && img.file) used.add(img.file);
      }
    }
  }
  return used;
}

module.exports = {
  list,
  create,
  get,
  currentId,
  setCurrent,
  appendTurn,
  remove,
  clearAll,
  imageFiles,
  filePath,
};
