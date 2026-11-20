'use strict';

/* npm start / start.vbs 的统一入口：
   优先用应用名硬链接启动（任务管理器显示 DeepSeek Quick），
   没有链接时退回 electron.exe。 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const brand = require('../src/brand');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'node_modules', 'electron', 'dist');
const renamed = path.join(dist, `${brand.NAME}.exe`);
const fallback = path.join(dist, 'electron.exe');
const exe = fs.existsSync(renamed) ? renamed : fallback;

if (!fs.existsSync(exe)) {
  console.error('Electron runtime not found. Run: npm install');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

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
