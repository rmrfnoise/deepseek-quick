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
};

const THEMES = ['dark', 'light', 'system'];

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
