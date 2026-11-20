'use strict';

/* npm start 的统一入口：
   优先用应用名硬链接启动（任务管理器显示 DeepSeek Quick），
   没有链接时退回 electron.exe；运行时缺失则先尝试补齐。 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const brand = require('../src/brand');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'node_modules', 'electron', 'dist');
const renamed = path.join(dist, `${brand.NAME}.exe`);
const fallback = path.join(dist, 'electron.exe');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

function findExe() {
  if (fs.existsSync(renamed)) return renamed;
  if (fs.existsSync(fallback)) return fallback;
  return null;
}

let exe = findExe();
if (!exe) {
  console.log('[runtime] Electron 运行时缺失，准备中…');
  spawnSync(process.execPath, [path.join(__dirname, 'prepare-runtime.js')], {
    cwd: root,
    stdio: 'inherit',
    env,
  });
  exe = findExe();
}

if (!exe) {
  console.error('Electron runtime not found. Run: npm install');
  process.exit(1);
}

const child = spawn(exe, [root], {
  cwd: root,
  detached: true,
  stdio: 'ignore',
  env,
});

child.on('error', (err) => {
  console.error(`启动失败：${err.message}`);
  process.exit(1);
});
child.unref();
