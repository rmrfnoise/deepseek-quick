'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const {
  app,
  BrowserWindow,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  screen,
  clipboard,
  shell,
  dialog,
} = require('electron');

const paths = require('./paths');
const store = require('./store');
const sessionsStore = require('./sessions');
const filesStore = require('./files');
const brand = require('./brand');

/* Windows 任务栏/通知里的应用身份；进程名由启动用的 exe 名决定 */
app.setName(brand.NAME);
const { streamChat, describeError, MODELS, EFFORTS, DEFAULT_MODEL, ENDPOINT } = require('./deepseek');
const { normalizeUsage, summarize, holidayKnown } = require('./pricing');

/* 便携模式启动检查：必须在 ready 之前、单实例锁之前完成。
   数据目录不可写就直接失败退出，绝不在 C 盘用户目录留任何东西。 */
const DATA_ROOT = paths.setupElectronPaths();
if (!DATA_ROOT) {
  dialog.showErrorBox(
    '无法启动',
    `数据目录不可写：\n${path.join(paths.appRoot(), 'data')}\n\n` +
      '本程序为纯便携版，不会把配置和会话写到 C 盘用户目录。\n' +
      '请把程序目录移动到有写入权限的位置（如 D:\\tools\\ds-palette）后重试。'
  );
  app.exit(1);
  return;
}

const PRIMARY_HOTKEY = 'Alt+Space';
const FALLBACK_HOTKEY = 'Ctrl+Alt+Space';
const WIN_WIDTH = 780;
const WIN_HEIGHT = 560;

/** 服务端“输入超长”错误：user input too long, N tokens exceeds max M tokens */
function isInputTooLong(err) {
  if (!err || err.status !== 400) return false;
  const raw = `${err.detail || ''} ${err.message || ''}`;
  return /user input too long|exceeds max \d+ tokens|输入约 [\d,]+ tokens/i.test(raw);
}

/** 服务端提示附件 file_id 已失效（文件被清理或过期） */
function isFileExpired(err) {
  if (!err || ![400, 404, 409, 422].includes(err.status)) return false;
  const raw = `${err.detail || ''} ${err.message || ''}`;
  return /file[_ ]?id|file not found|invalid file|文件.{0,8}(不存在|失效|过期)|附件.{0,8}(不存在|失效|过期)/i.test(raw);
}

/* 判断这条消息里有没有链接：有就声明 deepseek_read_url，让服务端自动读网页。
   官方文档：只在最后一条用户消息里识别，最多前 10 个不同 URL，读几个由模型决定。 */
const URL_RE = /https?:\/\/[^\s<>"'`（）()【】]+/gi;

function extractUrls(text) {
  const found = String(text || '').match(URL_RE) || [];
  const out = [];
  for (const raw of found) {
    const url = raw.replace(/[.,;:!?，。；：！？、）】》」』]+$/u, '');
    if (!out.includes(url)) out.push(url);
    if (out.length >= 10) break;
  }
  return out;
}

/* 服务端拒绝读取时（例如 github.io 这类用户内容域名），改用本地隐藏窗口渲染再取正文。
   只对失败的链接兜底，正常情况仍走官方服务端读取。 */
const LOCAL_TEXT_MAX = 12000;
const LOCAL_TOTAL_MAX = 24000;
const LOCAL_MIN_CHARS = 60;

function cleanPageText(raw) {
  return String(raw || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, LOCAL_TEXT_MAX);
}

function renderPage(url, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) {
      resolve(null);
      return;
    }
    let settled = false;
    let timer = null;
    let onAbort = null;

    const w = new BrowserWindow({
      show: false,
      width: 1200,
      height: 900,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        images: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });

    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      try {
        w.destroy();
      } catch (_) {
        /* 已销毁 */
      }
      resolve(val);
    };
    if (signal) {
      onAbort = () => finish(null);
      signal.addEventListener('abort', onAbort, { once: true });
    }

    timer = setTimeout(() => finish(null), 12000);
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', (e, target) => {
      if (target !== url) e.preventDefault();
    });
    w.webContents.on('did-fail-load', () => finish(null));
    w.webContents.on('did-finish-load', async () => {
      /* SPA 挂载 + 首屏数据请求留点时间 */
      await new Promise((r) => setTimeout(r, 1400));
      try {
        const raw = await w.webContents.executeJavaScript(
          'JSON.stringify({title: document.title || "", text: (document.body && document.body.innerText) || ""})'
        );
        const data = JSON.parse(raw);
        const text = cleanPageText(data.text);
        finish(text.length >= LOCAL_MIN_CHARS ? { url, title: data.title, text } : null);
      } catch (_) {
        finish(null);
      }
    });

    w.loadURL(url).catch(() => finish(null));
  });
}

/** 把服务端读失败的链接收集出来 */
function failedReads(toolCalls) {
  const out = [];
  for (const step of toolCalls || []) {
    for (const call of step.calls || []) {
      if (call.kind === 'read_link' && call.status === 'failed' && call.action?.url) {
        if (!out.includes(call.action.url)) out.push(call.action.url);
      }
    }
  }
  return out;
}

/* ---------- 图片 ---------- */

const IMAGE_MAX = 6;
const FILE_MAX = 6;
const IMAGE_MAX_CHARS = 12 * 1024 * 1024; /* data URL 长度上限，约 9MB 原图 */
const IMAGE_BUDGET = 30 * 1024 * 1024; /* 单次请求内联图片总量上限 */
const IMAGE_MIME = /^data:image\/(?:jpeg|png|gif|webp);base64,/i;

function imagesDir() {
  const dir = path.join(DATA_ROOT, 'images');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 图片按内容哈希落盘，同一张图不会重复存 */
function saveImage(dataUrl) {
  const m = /^data:image\/([a-z]+);base64,([\s\S]+)$/i.exec(dataUrl || '');
  if (!m) return null;
  const raw = m[1].toLowerCase();
  const ext = raw === 'jpeg' ? 'jpg' : raw;
  if (!['jpg', 'png', 'gif', 'webp'].includes(ext)) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) return null;
  const file = `${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16)}.${ext}`;
  const full = path.join(imagesDir(), file);
  if (!fs.existsSync(full)) fs.writeFileSync(full, buf);
  return { file, bytes: buf.length };
}

function readImageDataUrl(file) {
  if (!file || path.basename(file) !== file) return '';
  try {
    const ext = path.extname(file).slice(1).toLowerCase();
    if (!['jpg', 'png', 'gif', 'webp'].includes(ext)) return '';
    const buf = fs.readFileSync(path.join(imagesDir(), file));
    const mime = ext === 'jpg' ? 'jpeg' : ext;
    return `data:image/${mime};base64,${buf.toString('base64')}`;
  } catch (_) {
    return '';
  }
}

/** 删除没有被任何会话引用的图片；生成中先跳过，避免误删刚落盘、还没写入会话的图 */
function gcImages() {
  if (activeAbort) return 0;
  const dir = path.join(DATA_ROOT, 'images');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return 0;
  }
  const used = sessionsStore.imageFiles();
  let removed = 0;
  for (const name of names) {
    if (used.has(name)) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
      removed += 1;
    } catch (_) {
      /* 删不掉就下次再来 */
    }
  }
  return removed;
}

/** 汇总一个会话里所有已记录的调用；missing 是没有用量记录的历史回答条数 */
function collectUsage(sess) {
  const calls = [];
  let missing = 0;
  for (const m of sess?.messages || []) {
    if (m.role !== 'assistant') continue;
    if (Array.isArray(m.usage) && m.usage.length) calls.push(...m.usage);
    else missing += 1;
  }
  const summary = summarize(calls);
  summary.missing = missing;
  return summary;
}

/** 文本 + 图片 + 已上传文件拼成 Chat Completions 的 content 数组 */
function userContent(text, dataUrls, fileIds = []) {
  if ((!dataUrls || !dataUrls.length) && (!fileIds || !fileIds.length)) return text;
  const parts = [];
  const t = String(text || '').trim();
  if (t) parts.push({ type: 'text', text: t });
  else parts.push({ type: 'text', text: fileIds.length ? '请阅读这些文件，说明主要内容。' : '请描述这张图片。' });
  for (const url of dataUrls || []) {
    parts.push({ type: 'image_url', image_url: { url } });
  }
  for (const id of fileIds || []) {
    parts.push({ type: 'file', file_id: id });
  }
  return parts;
}

/** 联网时补一条当前时间，避免模型按训练时的日期理解“今天” */
function buildTimeMessage() {
  const now = new Date();
  const stamp = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return { role: 'system', content: `当前时间：${stamp}。涉及实时信息时，以检索到的网页内容为准。` };
}

function buildLocalContext(pages) {
  let used = 0;
  const blocks = [];
  for (const p of pages) {
    if (used >= LOCAL_TOTAL_MAX) break;
    const text = p.text.slice(0, Math.min(LOCAL_TEXT_MAX, LOCAL_TOTAL_MAX - used));
    used += text.length;
    blocks.push(`【${p.title || p.url}】\n${p.url}\n${text}`);
  }
  return (
    '服务端无法读取用户消息中的链接，客户端已用本地浏览器加载并提取网页正文（可能不完整，含页面噪声）：\n\n' +
    blocks.join('\n\n---\n\n') +
    '\n\n请基于以上正文回答用户的最后一条消息；若正文与问题无关或明显为空，请如实说明看不到内容。'
  );
}

let win = null;
let tray = null;
let activeHotkey = null;
let activeAbort = null;
let quitting = false;
/* 透明无边框窗口在 Windows 上走 setFullScreen 时 isFullScreen() 不会置位，
   这里自己保存窗口边界，用 setBounds 实现可进可出的全屏 */
let fullscreen = false;
let normalBounds = null;
/* 置顶开关：开着时窗口不随失焦自动隐藏，始终浮在其他窗口之上 */
let pinned = false;
/* 系统对话框（选文件）期间不计失焦，否则窗口会自己藏起来 */
let dialogOpen = 0;

/* ---------- 窗口 ---------- */

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const x = Math.round(workArea.x + (workArea.width - WIN_WIDTH) / 2);
  const y = Math.round(workArea.y + workArea.height * 0.18);

  /* 置顶状态在窗口创建前就位，避免第一帧按默认值判断失焦 */
  pinned = store.load().pinned === true;

  win = new BrowserWindow({
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    minWidth: 640,
    minHeight: 440,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    icon: path.join(__dirname, 'renderer', 'assets', 'app.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.on('blur', () => {
    if (quitting) return;
    /* 全屏阅读、置顶时不要因为点到别的窗口就自动隐藏 */
    if (fullscreen || pinned) return;
    if (win.webContents.isDevToolsOpened()) return;
    /* 打开系统文件对话框时窗口必然失焦，这时候不能把自己藏起来；
       对话框刚关掉的那一瞬间也可能补发一次 blur，稍等一下再看焦点在哪 */
    if (dialogOpen > 0) return;
    setTimeout(() => {
      if (quitting || dialogOpen > 0) return;
      if (!win || win.isDestroyed() || win.isFocused()) return;
      if (fullscreen || pinned) return;
      hideWindow();
    }, 40);
  });

  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      hideWindow();
    }
  });

  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
}

function showWindow() {
  if (!win) return;
  win.setAlwaysOnTop(true, 'screen-saver');
  win.show();
  win.focus();
  win.moveTop();
  win.webContents.send('ui:shown');
}

function setFullscreen(value) {
  if (!win || win.isDestroyed()) return false;
  const next = Boolean(value);
  if (next === fullscreen) return fullscreen;

  if (next) {
    normalBounds = win.getBounds();
    const display = screen.getDisplayMatching(normalBounds);
    win.setResizable(false);
    win.setBounds(display.bounds);
    fullscreen = true;
  } else {
    fullscreen = false;
    win.setResizable(true);
    if (normalBounds) win.setBounds(normalBounds);
    normalBounds = null;
  }

  if (!win.isDestroyed() && !win.webContents.isLoading()) {
    win.webContents.send('ui:fullscreen', fullscreen);
  }
  return fullscreen;
}

function hideWindow() {
  if (!win || !win.isVisible()) return;
  /* 关闭/隐藏时退出全屏，下次唤出仍是正常尺寸 */
  if (fullscreen) setFullscreen(false);
  win.hide();
}

/** 系统对话框关掉后把窗口拉回来：不发 ui:shown，避免输入框里的草稿被全选 */
function refocusWindow() {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(true, 'screen-saver');
  win.show();
  win.moveTop();
  win.focus();
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) hideWindow();
  else showWindow();
}

/** 置顶：写入配置，下次启动沿用。置顶期间点其他窗口不会自动隐藏，窗口始终浮在最前 */
function setPinned(value) {
  pinned = Boolean(value);
  store.save({ pinned });
  if (win && !win.isDestroyed()) {
    if (pinned) win.setAlwaysOnTop(true, 'screen-saver');
    /* 加载中先不发，渲染进程 boot 时会从 config:get 拿到一致状态 */
    if (!win.webContents.isLoading()) win.webContents.send('ui:pinned', pinned);
  }
  return pinned;
}

/* ---------- 热键 ---------- */

function registerHotkeys() {
  try {
    if (globalShortcut.register(PRIMARY_HOTKEY, toggleWindow)) {
      activeHotkey = PRIMARY_HOTKEY;
      return;
    }
  } catch (_) {
    /* 落到备用键 */
  }
  try {
    if (globalShortcut.register(FALLBACK_HOTKEY, toggleWindow)) {
      activeHotkey = FALLBACK_HOTKEY;
      return;
    }
  } catch (_) {
    /* 两个都失败 */
  }
  activeHotkey = null;
}

/* ---------- 托盘 ---------- */

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'renderer', 'assets', 'tray16.png'));
  tray = new Tray(icon);
  tray.setToolTip(
    activeHotkey ? `${brand.NAME} · ${brand.TAGLINE} · ${activeHotkey}` : `${brand.NAME} · 热键未生效`
  );

  const menu = Menu.buildFromTemplate([
    { label: '显示 / 隐藏', click: toggleWindow },
    {
      label: activeHotkey ? `热键：${activeHotkey}` : '热键未生效，请查看设置',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: '新建会话',
      click: () => {
        sessionsStore.setCurrent(null);
        if (win && !win.isDestroyed()) win.webContents.send('ui:session-created');
        showWindow();
      },
    },
    {
      label: '设置',
      click: () => {
        showWindow();
        win.webContents.send('ui:open-settings');
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
  tray.on('click', toggleWindow);
}

/* ---------- IPC ---------- */

const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];

/** 本地路径 → 附件项：图片只带回路径，由渲染进程逐张读取压缩（避免一次读多张大图） */
function itemsFromPaths(paths, limit) {
  const items = [];
  for (const file of (paths || []).slice(0, limit)) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (_) {
      continue;
    }
    if (!stat.isFile() || !stat.size) continue;

    const name = path.basename(file);
    const ext = path.extname(file).slice(1).toLowerCase();

    if (IMAGE_EXT.includes(ext)) {
      if (stat.size > 24 * 1024 * 1024) continue;
      items.push({ kind: 'image', name, size: stat.size, path: file });
      continue;
    }

    if (!filesStore.pickPurpose(file)) continue;
    items.push({ kind: 'file', name, size: stat.size, path: file });
  }
  return items;
}

function registerIpc() {
  ipcMain.handle('config:get', () => {
    const cfg = store.load();
    return {
      hasKey: Boolean(cfg.apiKey),
      apiKeyMasked: store.maskKey(cfg.apiKey),
      model: cfg.model,
      effort: cfg.effort,
      search: cfg.search,
      theme: cfg.theme,
      zoom: cfg.zoom,
      fullscreenHotkey: cfg.fullscreenHotkey,
      newlineHotkey: cfg.newlineHotkey,
      startFullscreen: cfg.startFullscreen,
      pinned,
      fullscreen,
      models: MODELS,
      efforts: EFFORTS,
      fileExts: filesStore.SUPPORTED,
      limits: { images: IMAGE_MAX, files: FILE_MAX },
      configPath: store.configPath(),
      hotkey: activeHotkey,
      expectedHotkey: PRIMARY_HOTKEY,
      version: app.getVersion(),
    };
  });

  ipcMain.handle('config:save', (_e, patch) => store.save(patch));

  /* 允许带上输入框里的 Key 直接测：首次使用还没保存时也能验证 */
  ipcMain.handle('config:test', async (_e, inputKey) => {
    const cfg = store.load();
    const key = String(inputKey || '').trim().slice(0, 400) || cfg.apiKey;
    if (!key) return { ok: false, error: '尚未填写 API KEY' };
    try {
      const resp = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'user', content: 'ping' }],
          thinking: { type: 'disabled' },
          max_tokens: 8,
          stream: false,
        }),
      });
      if (resp.ok) return { ok: true, model: cfg.model };
      let detail = '';
      try {
        const raw = await resp.text();
        detail = JSON.parse(raw)?.error?.message || '';
      } catch (_) {
        /* 忽略 */
      }
      return { ok: false, error: describeError(resp.status, detail) };
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        return { ok: false, error: '测试超时，检查网络或代理' };
      }
      return { ok: false, error: '网络连接失败，检查网络或代理' };
    }
  });

  /* ---- 会话管理 ---- */

  ipcMain.handle('session:list', () => ({
    currentId: sessionsStore.currentId(),
    items: sessionsStore.list(),
  }));

  ipcMain.handle('session:create', () => {
    sessionsStore.setCurrent(null);
    return { ok: true };
  });

  ipcMain.handle('session:switch', (_e, id) => {
    const s = sessionsStore.get(id);
    if (!s) return { ok: false, error: '会话不存在' };
    sessionsStore.setCurrent(id);
    const sessionUsage = collectUsage(s);
    return {
      ok: true,
      id: s.id,
      title: s.title,
      messages: s.messages.map((m) => {
        const msg = { role: m.role, content: m.content };
        if (m.role === 'assistant' && Array.isArray(m.usage) && m.usage.length) {
          msg.usage = summarize(m.usage);
        }
        if (m.serverToolCalls?.length) msg.serverToolCalls = m.serverToolCalls;
        if (m.annotations?.length) msg.annotations = m.annotations;
        if (m.localRead?.length) msg.localRead = m.localRead;
        if (m.images?.length) {
          /* 只回文件名，渲染进程按需逐张取回，避免一次切换塞进几十 MB */
          msg.images = m.images
            .filter((ref) => ref && ref.file)
            .map((ref) => ({ file: ref.file, name: ref.name, w: ref.w, h: ref.h }));
        }
        if (m.docs?.length) {
          msg.docs = m.docs.map((ref) => ({
            name: ref.name,
            bytes: ref.bytes,
            purpose: ref.purpose,
            fileId: ref.fileId,
          }));
        }
        return msg;
      }),
      sessionUsage,
    };
  });

  ipcMain.handle('session:delete', (_e, id) => {
    const nextCurrent = sessionsStore.remove(id);
    gcImages();
    return { ok: true, currentId: nextCurrent };
  });

  ipcMain.handle('session:clear', () => {
    sessionsStore.clearAll();
    gcImages();
    return { ok: true };
  });

  /* ---- 对话 ---- */

  ipcMain.handle('chat:send', async (event, payload) => {
    if (activeAbort) return { ok: false, error: '正在生成中，请先停止' };

    const cfg = store.load();
    if (!cfg.apiKey) return { ok: false, error: 'NO_KEY' };

    const text = String(payload?.text || '').trim();
    const sender = event.sender;
    /* 图片先落盘，再按内容哈希复用 */
    const imageRefs = [];
    const inlineImages = [];
    for (const img of Array.isArray(payload?.images) ? payload.images.slice(0, IMAGE_MAX) : []) {
      const dataUrl = String(img?.dataUrl || '');
      if (!IMAGE_MIME.test(dataUrl) || dataUrl.length > IMAGE_MAX_CHARS) continue;
      const saved = saveImage(dataUrl);
      if (!saved) continue;
      imageRefs.push({
        file: saved.file,
        name: String(img?.name || '图片').slice(0, 80),
        w: Number(img?.w) || 0,
        h: Number(img?.h) || 0,
      });
      inlineImages.push(dataUrl);
    }

    /* 文件走 Files API：上传解析后拿 file_id 引用。同一文件命中缓存，不重复付解析费 */
    const docRefs = [];
    const fileIds = [];
    const rawFiles = Array.isArray(payload?.files) ? payload.files.slice(0, FILE_MAX) : [];

    /* 上传阶段也算“生成中”：停止按钮能中断后续文件，图片 GC 也不会误删刚落盘的图 */
    const controller = new AbortController();
    activeAbort = controller;

    for (let i = 0; i < rawFiles.length; i += 1) {
      if (controller.signal.aborted) {
        activeAbort = null;
        return { ok: false, aborted: true };
      }
      const filePath = String(rawFiles[i]?.path || '');
      if (!filePath) continue;
      const label = String(rawFiles[i]?.name || path.basename(filePath));
      const emitUpload = (stage, extra = {}) => {
        if (!sender.isDestroyed()) sender.send('chat:upload', { stage, index: i, name: label, ...extra });
      };
      emitUpload('start', { total: rawFiles.length });
      try {
        const up = await filesStore.prepare({ filePath, apiKey: cfg.apiKey, signal: controller.signal });
        docRefs.push({ name: up.name, bytes: up.bytes, purpose: up.purpose, fileId: up.fileId });
        fileIds.push(up.fileId);
        emitUpload('done', { total: rawFiles.length, cached: up.cached });
      } catch (err) {
        if (err.name === 'AbortError') {
          emitUpload('error', { message: '已停止' });
          activeAbort = null;
          return { ok: false, aborted: true };
        }
        emitUpload('error', { message: err.message });
        activeAbort = null;
        return { ok: false, error: `${label}：${err.message}` };
      }
    }

    if (!text && !imageRefs.length && !docRefs.length) {
      activeAbort = null;
      return { ok: false, error: '内容为空' };
    }

    let sid = payload.sessionId || sessionsStore.currentId();
    const sess = sid ? sessionsStore.get(sid) : null;
    /* 先不建空会话：请求失败/中途停止时不留下空壳，成功落盘时再创建 */
    if (!sess) sid = null;
    /* 历史：user 消息带图时回填 base64，带文件时回填 file_id；server_tool_calls 必须原样回传 */
    const history = [];
    let imageBudget = IMAGE_BUDGET;
    for (const m of sess ? sess.messages : []) {
      if (m.role === 'user' && (m.images?.length || m.docs?.length)) {
        const urls = [];
        for (const ref of m.images || []) {
          const dataUrl = readImageDataUrl(ref.file);
          if (!dataUrl || dataUrl.length > imageBudget) continue;
          imageBudget -= dataUrl.length;
          urls.push(dataUrl);
        }
        const ids = (m.docs || []).map((d) => d.fileId).filter(Boolean);
        history.push({ role: 'user', content: userContent(m.content, urls, ids) });
        continue;
      }
      const msg = { role: m.role, content: m.content };
      if (m.serverToolCalls?.length) msg.server_tool_calls = m.serverToolCalls;
      history.push(msg);
    }
    /* 联网检索时补一条当前时间，避免模型按训练时的日期理解“今天” */
    const timeMsg = buildTimeMessage();
    if (payload.search === true) history.unshift(timeMsg);
    history.push({ role: 'user', content: userContent(text, inlineImages, fileIds) });

    const askedModel = payload.model || cfg.model || DEFAULT_MODEL;
    /* 只有 V4.1-Flash 支持图片与文件输入 */
    const needsFlash = imageRefs.length || docRefs.length;
    const model = needsFlash && askedModel !== 'deepseek-flash' ? 'deepseek-flash' : askedModel;
    const effort = payload.effort || cfg.effort;
    const urls = extractUrls(text);

    const emitDelta = (delta) => {
      if (!sender.isDestroyed()) sender.send('chat:delta', delta);
    };
    const emitTool = (toolEvent) => {
      if (!sender.isDestroyed()) sender.send('chat:tool', toolEvent);
    };

    let searchOn = payload.search === true;
    let searchDropped = false;

    const calls = [];
    const callModel = async (messages, withSearch, opts = {}) => {
      const at = Date.now();
      const res = await streamChat({
        apiKey: cfg.apiKey,
        model,
        messages,
        effort,
        search: withSearch,
        readUrl: opts.readUrl !== undefined ? opts.readUrl : urls.length > 0,
        signal: controller.signal,
        onDelta: emitDelta,
        onToolEvent: emitTool,
      });
      const used = normalizeUsage(res.usage);
      if (used) calls.push({ at, model, ...used });
      return res;
    };

    try {
      let result;
      try {
        result = await callModel(history, searchOn);
      } catch (err) {
        /* 开联网工具时服务端把输入限制在 32768 tokens，附件一大就报 user input too long；
           关掉搜索重提一次即可，附件本身不受这个限制。 */
        if (searchOn && (docRefs.length || imageRefs.length) && isInputTooLong(err)) {
          searchOn = false;
          searchDropped = true;
          if (!sender.isDestroyed()) {
            sender.send('chat:notice', {
              text: '附件占用的上下文较长，联网搜索与它无法同时使用，已自动关闭搜索重新提交',
            });
          }
          result = await callModel(history.filter((m) => m !== timeMsg), false);
        } else if (docRefs.length && isFileExpired(err)) {
          /* 服务端文件已过期：跳过缓存重传本轮附件，替换最后一条用户消息后重试一次 */
          const freshDocs = [];
          const freshIds = [];
          for (const file of rawFiles) {
            const filePath = String(file?.path || '');
            if (!filePath) continue;
            const up = await filesStore.prepare({ filePath, apiKey: cfg.apiKey, force: true, signal: controller.signal });
            freshDocs.push({ name: up.name, bytes: up.bytes, purpose: up.purpose, fileId: up.fileId });
            freshIds.push(up.fileId);
          }
          if (!freshIds.length) throw err;
          docRefs.splice(0, docRefs.length, ...freshDocs);
          fileIds.splice(0, fileIds.length, ...freshIds);
          history[history.length - 1] = { role: 'user', content: userContent(text, inlineImages, fileIds) };
          if (!sender.isDestroyed()) {
            sender.send('chat:notice', { text: '附件解析结果已失效，已重新上传后重试' });
          }
          result = await callModel(history, searchOn);
        } else {
          throw err;
        }
      }

      if (controller.signal.aborted) {
        return {
          ok: false,
          aborted: true,
          sessionId: sid,
          ...result,
          usage: summarize(calls),
          sessionUsage: collectUsage(sessionsStore.get(sid)),
        };
      }

      /* 服务端拒绝读取某些域名：本地浏览器渲染兜底，同一次提问里接着答 */
      let final = result;
      let localRead = [];
      const refused = failedReads(result.toolCalls);
      if (refused.length) {
        /* 两个链接并行渲染：互相独立，最坏情况从 24s 降到 12s */
        const pages = (
          await Promise.all(refused.slice(0, 2).map((url) => renderPage(url, controller.signal)))
        ).filter(Boolean);
        if (pages.length && !controller.signal.aborted) {
          localRead = pages.map((p) => ({ url: p.url, title: p.title, chars: p.text.length }));
          if (!sender.isDestroyed()) {
            sender.send('chat:reset');
            sender.send('chat:local-read', localRead);
          }
          const retryMessages = [
            ...history.slice(0, -1),
            { role: 'system', content: buildLocalContext(pages) },
            history[history.length - 1],
          ];
          final = await callModel(retryMessages, false, { readUrl: false });
        }
      }

      if (controller.signal.aborted) {
        return {
          ok: false,
          aborted: true,
          sessionId: sid,
          ...result,
          content: final.content,
          usage: summarize(calls),
          sessionUsage: collectUsage(sessionsStore.get(sid)),
          localRead,
        };
      }

      const writeSid = sid && sessionsStore.get(sid) ? sid : sessionsStore.create().id;
      const updated = sessionsStore.appendTurn(writeSid, text, final.content, {
        serverToolCalls: result.toolCalls,
        annotations: final.annotations,
        localRead,
        userImages: imageRefs,
        userDocs: docRefs,
        usage: calls,
        titleText: imageRefs.length || docRefs.length ? '文件提问' : '',
      });
      return {
        ok: true,
        sessionId: writeSid,
        title: updated ? updated.title : '',
        content: final.content,
        reasoning: final.reasoning,
        usage: summarize(calls),
        sessionUsage: collectUsage(sessionsStore.get(writeSid)),
        toolCalls: result.toolCalls,
        annotations: final.annotations,
        localRead,
        model,
        userImages: imageRefs.map((ref) => ({ name: ref.name, w: ref.w, h: ref.h })),
        userDocs: docRefs.map((ref) => ({ name: ref.name, bytes: ref.bytes, purpose: ref.purpose })),
        searchDropped,
      };
    } catch (err) {
      if (err.name === 'AbortError') {
        return {
          ok: false,
          aborted: true,
          sessionId: sid,
          usage: summarize(calls),
          sessionUsage: collectUsage(sessionsStore.get(sid)),
        };
      }
      return { ok: false, error: err.message || '未知错误', status: err.status || 0 };
    } finally {
      activeAbort = null;
    }
  });

  ipcMain.handle('chat:abort', () => {
    if (activeAbort) {
      activeAbort.abort();
      return { ok: true };
    }
    return { ok: false };
  });

  ipcMain.handle('window:hide', () => {
    hideWindow();
    return { ok: true };
  });

  ipcMain.handle('window:set-fullscreen', (_e, value) => {
    const on = setFullscreen(value);
    return { ok: true, fullscreen: on };
  });

  ipcMain.handle('window:set-pinned', (_e, value) => ({ ok: true, pinned: setPinned(value) }));

  ipcMain.handle('shell:open-external', (_e, url) => {
    const raw = String(url || '');
    if (!/^https?:\/\//i.test(raw)) return { ok: false };
    shell.openExternal(raw).catch(() => {});
    return { ok: true };
  });

  ipcMain.handle('clipboard:write', (_e, text) => {
    clipboard.writeText(String(text || ''));
    return { ok: true };
  });

  /* 选附件：图片只回路径，由渲染进程逐张读取并转成接口接受的格式 */
  ipcMain.handle('dialog:pick-files', async () => {
    const wasVisible = Boolean(win && !win.isDestroyed() && win.isVisible());
    dialogOpen += 1;
    let res;
    try {
      res = await dialog.showOpenDialog(win, {
        title: '添加图片或文档',
        buttonLabel: '添加',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: '图片与文档', extensions: filesStore.SUPPORTED },
          { name: '图片', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] },
          { name: '文档', extensions: ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xlsx', 'xls', 'txt', 'md', 'csv', 'json', 'epub', 'mobi'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
    } finally {
      dialogOpen -= 1;
      if (wasVisible) refocusWindow();
    }
    if (res.canceled) return { ok: false, items: [] };
    return { ok: true, items: itemsFromPaths(res.filePaths, IMAGE_MAX + FILE_MAX) };
  });

  /* 会话里的图片按需读取：只传文件名，禁止路径穿越 */
  ipcMain.handle('image:read', (_e, file) => {
    const name = String(file || '');
    if (!name || name !== path.basename(name)) return { ok: false };
    const dataUrl = readImageDataUrl(name);
    return dataUrl ? { ok: true, dataUrl } : { ok: false };
  });

  /* 图片按需单张读取：一次选多张大图时，主进程不会被一次性撑爆 */
  ipcMain.handle('file:read-image', (_e, filePath) => {
    const file = String(filePath || '');
    const ext = path.extname(file).slice(1).toLowerCase();
    if (!IMAGE_EXT.includes(ext)) return { ok: false, error: '不是支持的图片格式' };
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (_) {
      return { ok: false, error: '读不到这个文件' };
    }
    if (!stat.isFile() || !stat.size) return { ok: false, error: '文件是空的' };
    if (stat.size > 24 * 1024 * 1024) return { ok: false, error: '图片超过 24 MB' };
    try {
      const buf = fs.readFileSync(file);
      /* BMP 浏览器能解但不能内联，交给渲染进程转成 PNG */
      const mime = ext === 'jpg' ? 'jpeg' : ext;
      return { ok: true, name: path.basename(file), dataUrl: `data:image/${mime};base64,${buf.toString('base64')}` };
    } catch (_) {
      return { ok: false, error: '读取失败' };
    }
  });

  /* 剪贴板等场景拿不到本地路径时，渲染进程把内容递过来，落盘成临时文件再走上传 */
  ipcMain.handle('file:stash', (_e, payload) => {
    const name = String(payload?.name || 'file');
    const bytes = payload?.bytes;
    if (!bytes || !bytes.byteLength) return { ok: false, error: '内容为空' };
    try {
      const dir = path.join(DATA_ROOT, 'inbox', `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
      fs.mkdirSync(dir, { recursive: true });
      const safe = (name.replace(/[\\/:*?"<>|\r\n]/g, '_').replace(/^\.+$/, '') || 'file').slice(0, 120);
      const target = path.join(dir, safe);
      fs.writeFileSync(target, Buffer.from(bytes));
      return { ok: true, path: target, name: safe, size: bytes.byteLength };
    } catch (err) {
      return { ok: false, error: err.message || '写入临时文件失败' };
    }
  });
}

/* ---------- 生命周期 ---------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    /* 上次运行遗留的暂存文件（粘贴/拖拽时落盘的）直接清掉 */
    try {
      fs.rmSync(path.join(DATA_ROOT, 'inbox'), { recursive: true, force: true });
    } catch (_) {
      /* 没有就算了 */
    }

    /* 上次运行可能留下没人引用的图片（比如上传失败、会话被删） */
    const orphans = gcImages();

    if (!holidayKnown(Date.now())) {
      console.log(' 节假日表未覆盖今年：峰谷费用按工作日规则估算（更新 src/holidays.json 可修正）');
    }

    registerHotkeys();
    if (process.platform === 'win32') app.setAppUserModelId('com.deepseek.quick');
    createWindow();
    createTray();
    registerIpc();

    console.log('========================================');
    store.migrate();
    const boot = store.load();
    if (boot.startFullscreen) setFullscreen(true);
    console.log(` ${brand.NAME}  (model: ${boot.model}, effort: ${boot.effort})`);
    console.log(` 热键注册结果: ${activeHotkey || '失败 —— 两个候选键均被占用'}`);
    console.log(` 数据目录: ${DATA_ROOT}`);
    console.log(` 配置: ${store.configPath()}`);
    console.log(` 会话: ${sessionsStore.filePath()} (已有 ${sessionsStore.list().length} 个)`);
    if (orphans) console.log(` 清理孤儿图片: ${orphans} 张`);
    console.log('========================================');

    if (!boot.apiKey) {
      setTimeout(() => {
        showWindow();
        win.webContents.send('ui:open-settings');
      }, 400);
    }
  });

  app.on('before-quit', () => {
    /* 系统关机 / 外部 app.quit() 时也要允许窗口真正关闭 */
    quitting = true;
  });

  app.on('window-all-closed', () => {
    /* 常驻托盘，不退出 */
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });
}
