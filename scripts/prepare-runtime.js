'use strict';

/* Windows 运行时品牌化：
   1. 在 node_modules/electron/dist 里创建 "DeepSeek Quick.exe" 硬链接
   2. 用 rcedit 写入应用图标、产品名和文件描述
   这样任务管理器里的进程名、图标、描述都显示 DeepSeek Quick，而不是 Electron。

   硬链接不占额外空间；rcedit 可能替换文件本身，所以改完再互链一次。 */

const fs = require('fs');
const path = require('path');
const brand = require('../src/brand');
const pkg = require('../package.json');

if (process.platform !== 'win32') process.exit(0);

const dist = path.join(__dirname, '..', 'node_modules', 'electron', 'dist');
const electronExe = path.join(dist, 'electron.exe');
const appExe = path.join(dist, `${brand.NAME}.exe`);
const icon = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'app.ico');

function sameFile(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.ino === sb.ino && sa.dev === sb.dev;
  } catch (_) {
    return false;
  }
}

function linkAppName() {
  if (!fs.existsSync(electronExe)) return false;

  if (!fs.existsSync(appExe)) {
    fs.linkSync(electronExe, appExe);
    return true;
  }

  if (sameFile(appExe, electronExe)) return true;

  fs.unlinkSync(appExe);
  fs.linkSync(electronExe, appExe);
  return true;
}

async function brandResources() {
  if (!fs.existsSync(appExe)) return;

  let rcedit;
  try {
    ({ rcedit } = await import('rcedit'));
  } catch (err) {
    console.warn(`[runtime] 未安装 rcedit，跳过图标/描述：${err.message}`);
    return;
  }

  const options = {
    'version-string': {
      ProductName: brand.NAME,
      FileDescription: brand.NAME,
      CompanyName: brand.NAME,
      InternalName: brand.NAME,
      OriginalFilename: `${brand.NAME}.exe`,
    },
    'file-version': pkg.version,
    'product-version': pkg.version,
  };
  if (fs.existsSync(icon)) options.icon = icon;

  try {
    await rcedit(appExe, options);
    console.log('[runtime] 已写入应用图标与版本信息');
  } catch (err) {
    /* 运行时正在占用时 rcedit 会失败；先保留旧资源，下次安装/手动执行再补 */
    console.warn(`[runtime] 写入图标/描述失败（程序可能正在运行）：${err.message}`);
    return;
  }

  /* rcedit 可能替换了 appExe，确保 electron.exe 与它仍是同一份文件 */
  if (fs.existsSync(electronExe) && !sameFile(appExe, electronExe)) {
    try {
      fs.unlinkSync(electronExe);
      fs.linkSync(appExe, electronExe);
    } catch (err) {
      console.warn(`[runtime] 重新链接 electron.exe 失败：${err.message}`);
    }
  }
}

(async () => {
  try {
    if (!linkAppName()) {
      console.warn('[runtime] 未找到 electron.exe，跳过运行时品牌化');
      return;
    }
    await brandResources();
    console.log(`[runtime] 就绪：${path.basename(appExe)}`);
  } catch (err) {
    console.warn(`[runtime] 准备失败：${err.message}`);
  }
})();
