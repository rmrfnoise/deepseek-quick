'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let cached = null;
let resolved = false;

/** 目录是否可写：能建目录、能落盘、能删除。 */
function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.wtest');
    fs.writeFileSync(probe, '1');
    fs.unlinkSync(probe);
    return true;
  } catch (_) {
    return false;
  }
}

function appRoot() {
  /* 开发时把 electron.exe 重命名成应用名后，Electron 会误判为已打包。
     真正的打包产物在 resources 下有 app 目录或 app.asar，用这个来区分。 */
  if (app.isPackaged) {
    try {
      const res = process.resourcesPath;
      if (fs.existsSync(path.join(res, 'app')) || fs.existsSync(path.join(res, 'app.asar'))) {
        return path.dirname(process.execPath);
      }
    } catch (_) {
      /* 读不到 resources 就按开发态处理 */
    }
  }
  return app.getAppPath();
}

/**
 * 纯便携模式：数据只允许放在程序所在目录，没有第二个位置，也不接受外部覆盖。
 * 该目录不可写即视为启动失败。
 */
function resolveDataDir() {
  if (resolved) return cached;
  resolved = true;

  const dir = path.join(appRoot(), 'data');
  if (writable(dir)) cached = dir;
  return cached;
}

/**
 * 把 Electron 自身的缓存、存储、单实例锁也从 C 盘搬到程序目录。
 * 必须在 app ready 之前、任何 userData 访问之前调用。
 */
function setupElectronPaths() {
  const dir = resolveDataDir();
  if (!dir) return null;

  const runtime = path.join(appRoot(), 'runtime');
  try {
    fs.mkdirSync(runtime, { recursive: true });
  } catch (_) {
    return null;
  }

  app.setPath('userData', runtime);
  app.setPath('sessionData', runtime);
  app.setPath('crashDumps', path.join(runtime, 'Crashpad'));
  return dir;
}

/** 业务层取数据目录；拿不到说明便携目录已失效，属于致命错误。 */
function dataDir() {
  const dir = resolveDataDir();
  if (!dir) throw new Error(`数据目录不可写：${path.join(appRoot(), 'data')}`);
  return dir;
}

module.exports = { dataDir, setupElectronPaths, appRoot };
