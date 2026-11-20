'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),
  testKey: (apiKey) => ipcRenderer.invoke('config:test', apiKey),

  send: (payload) => ipcRenderer.invoke('chat:send', payload),
  abort: () => ipcRenderer.invoke('chat:abort'),

  listSessions: () => ipcRenderer.invoke('session:list'),
  createSession: () => ipcRenderer.invoke('session:create'),
  switchSession: (id) => ipcRenderer.invoke('session:switch', id),
  deleteSession: (id) => ipcRenderer.invoke('session:delete', id),
  clearSessions: () => ipcRenderer.invoke('session:clear'),

  hide: () => ipcRenderer.invoke('window:hide'),
  setFullscreen: (value) => ipcRenderer.invoke('window:set-fullscreen', value),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  stashFile: (payload) => ipcRenderer.invoke('file:stash', payload),
  readImage: (filePath) => ipcRenderer.invoke('file:read-image', filePath),
  readStoredImage: (file) => ipcRenderer.invoke('image:read', file),
  pickFiles: () => ipcRenderer.invoke('dialog:pick-files'),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

  onDelta: (cb) => {
    const handler = (_e, delta) => cb(delta);
    ipcRenderer.on('chat:delta', handler);
    return () => ipcRenderer.removeListener('chat:delta', handler);
  },
  onTool: (cb) => {
    const handler = (_e, evt) => cb(evt);
    ipcRenderer.on('chat:tool', handler);
    return () => ipcRenderer.removeListener('chat:tool', handler);
  },
  onReset: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('chat:reset', handler);
    return () => ipcRenderer.removeListener('chat:reset', handler);
  },
  onLocalRead: (cb) => {
    const handler = (_e, pages) => cb(pages);
    ipcRenderer.on('chat:local-read', handler);
    return () => ipcRenderer.removeListener('chat:local-read', handler);
  },
  onUpload: (cb) => {
    const handler = (_e, info) => cb(info);
    ipcRenderer.on('chat:upload', handler);
    return () => ipcRenderer.removeListener('chat:upload', handler);
  },
  onNotice: (cb) => {
    const handler = (_e, info) => cb(info);
    ipcRenderer.on('chat:notice', handler);
    return () => ipcRenderer.removeListener('chat:notice', handler);
  },
  onShown: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('ui:shown', handler);
    return () => ipcRenderer.removeListener('ui:shown', handler);
  },
  onOpenSettings: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('ui:open-settings', handler);
    return () => ipcRenderer.removeListener('ui:open-settings', handler);
  },
  onFullscreen: (cb) => {
    const handler = (_e, value) => cb(value);
    ipcRenderer.on('ui:fullscreen', handler);
    return () => ipcRenderer.removeListener('ui:fullscreen', handler);
  },
  onSessionCreated: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('ui:session-created', handler);
    return () => ipcRenderer.removeListener('ui:session-created', handler);
  },
});
