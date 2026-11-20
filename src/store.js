'use strict';

const fs = require('fs');
const path = require('path');
const { dataDir } = require('./paths');

const { MODELS: MODEL_LIST, EFFORTS, DEFAULT_MODEL, DEFAULT_EFFORT } = require('./deepseek');

/* 模型与推理等级只在 deepseek.js 维护一份，这里只派生 id 白名单 */
const MODELS = MODEL_LIST.map((m) => m.id);

const DEFAULTS = {
  apiKey: '',
  model: DEFAULT_MODEL,
  effort: DEFAULT_EFFORT,
  search: false,
  theme: 'dark',
  zoom: 1,
  fullscreenHotkey: 'Alt+Enter',
  newlineHotkey: 'Shift+Enter',
  startFullscreen: false,
};

const THEMES = ['dark', 'light', 'system'];
const ZOOM_MIN = 1;
const ZOOM_MAX = 2;

const HOTKEY_MODS = ['Ctrl', 'Alt', 'Shift'];
const HOTKEY_KEYS = new Set([
  'Enter',
  'Space',
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
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ...'0123456789',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
]);

/** 只接受“修饰键 + 单个键”，且必须包含 Ctrl/Alt，避免误占用普通字母 */
function normalizeFullscreenHotkey(value) {
  const raw = String(value || '').trim();
  const parts = raw.split('+').filter(Boolean);
  if (parts.length < 2) return DEFAULTS.fullscreenHotkey;

  const key = parts.pop();
  const mods = parts;
  if (!mods.every((m) => HOTKEY_MODS.includes(m)) || new Set(mods).size !== mods.length) {
    return DEFAULTS.fullscreenHotkey;
  }
  if (!mods.some((m) => m !== 'Shift')) return DEFAULTS.fullscreenHotkey;
  if (!HOTKEY_KEYS.has(key)) return DEFAULTS.fullscreenHotkey;

  const ordered = HOTKEY_MODS.filter((m) => mods.includes(m));
  return [...ordered, key].join('+');
}

/** 换行允许 Shift+Enter；Shift 加其他键会和正常输入冲突，拒绝 */
function normalizeNewlineHotkey(value) {
  const raw = String(value || '').trim();
  const parts = raw.split('+').filter(Boolean);
  if (parts.length < 2) return DEFAULTS.newlineHotkey;

  const key = parts.pop();
  const mods = parts;
  if (!mods.every((m) => HOTKEY_MODS.includes(m)) || new Set(mods).size !== mods.length) {
    return DEFAULTS.newlineHotkey;
  }
  if (!HOTKEY_KEYS.has(key)) return DEFAULTS.newlineHotkey;

  const hasMainMod = mods.some((m) => m === 'Ctrl' || m === 'Alt');
  if (!hasMainMod && !(mods.length === 1 && key === 'Enter')) return DEFAULTS.newlineHotkey;

  const ordered = HOTKEY_MODS.filter((m) => mods.includes(m));
  return [...ordered, key].join('+');
}

function clampZoom(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULTS.zoom;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(n * 100) / 100));
}

function configPath() {
  return path.join(dataDir(), 'config.json');
}

/** 归一化：补默认值、清掉旧版字段（thinking 布尔、已移除的字体开关）、丢弃非法取值 */
function normalize(raw) {
  const src = raw || {};
  const cfg = { ...DEFAULTS, ...src };

  if (Object.prototype.hasOwnProperty.call(src, 'thinking')) {
    if (src.thinking === false) cfg.effort = 'off';
    delete cfg.thinking;
  }
  if (Object.prototype.hasOwnProperty.call(src, 'font')) delete cfg.font;

  if (!MODELS.includes(cfg.model)) cfg.model = DEFAULTS.model;
  if (!EFFORTS.includes(cfg.effort)) cfg.effort = DEFAULTS.effort;
  if (!THEMES.includes(cfg.theme)) cfg.theme = DEFAULTS.theme;
  cfg.zoom = clampZoom(cfg.zoom);
  cfg.fullscreenHotkey = normalizeFullscreenHotkey(cfg.fullscreenHotkey);
  cfg.newlineHotkey = normalizeNewlineHotkey(cfg.newlineHotkey);
  if (cfg.fullscreenHotkey === cfg.newlineHotkey) cfg.newlineHotkey = DEFAULTS.newlineHotkey;
  if (cfg.fullscreenHotkey === cfg.newlineHotkey) cfg.fullscreenHotkey = DEFAULTS.fullscreenHotkey;
  cfg.startFullscreen = cfg.startFullscreen === true;
  cfg.search = cfg.search === true;
  return cfg;
}

function load() {
  try {
    return normalize(JSON.parse(fs.readFileSync(configPath(), 'utf8')));
  } catch (_) {
    return { ...DEFAULTS };
  }
}

function save(patch) {
  const next = normalize({ ...load(), ...patch });
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    return { ok: false, error: err.message };
  }
  /* 回给渲染进程的配置不含 Key：Key 只在主进程内存里用于请求 */
  const safe = { ...next };
  delete safe.apiKey;
  return { ok: true, config: safe };
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 10) return `${key.slice(0, 3)}****`;
  return `${key.slice(0, 6)}****${key.slice(-4)}`;
}

/** 把磁盘上的旧格式（thinking 布尔、font 字段）就地升级，内容一致时不写盘 */
function migrate() {
  let text;
  try {
    text = fs.readFileSync(configPath(), 'utf8');
  } catch (_) {
    return false;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    return false;
  }
  const next = normalize(parsed);
  if (JSON.stringify(parsed) === JSON.stringify(next)) return false;
  try {
    fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { load, save, configPath, maskKey, migrate };
