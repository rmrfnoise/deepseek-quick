'use strict';

/* 首帧前应用主题，避免浅色模式启动时先闪一下深色。
   这里只是缓存的副本，真正的配置在 data/config.json，app.js 启动后再以配置为准。 */
(() => {
  let choice = 'dark';
  try {
    choice = localStorage.getItem('dsq-theme') || 'dark';
  } catch (_) {
    /* localStorage 不可用时按默认深色 */
  }

  const resolved =
    choice === 'light' || choice === 'dark'
      ? choice
      : window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark';

  document.documentElement.dataset.theme = resolved;
})();
