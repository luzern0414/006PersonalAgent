'use strict';
// 渲染进程唯一可用的桥：白名单 IPC
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const listen = (ch) => (fn) => {
  const h = (_e, d) => fn(d);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('pa', {
  reportError: (payload) => ipcRenderer.send('diagnostics:renderer', payload),
  api: (method, ...args) => ipcRenderer.invoke('api', method, ...args),
  chat: (payload) => ipcRenderer.invoke('chat:send', payload),
  confirm: (id, ok) => ipcRenderer.invoke('chat:confirm', id, ok),
  pathForFile: (file) => webUtils.getPathForFile(file),
  on: (ch, fn) => {
    const allowed = ['chat:event', 'panel:navigate', 'data.changed', 'settings.changed', 'kb:progress', 'focus.changed', 'task.completed', 'pet:cursor', 'pet:state', 'pet:bubble', 'pet:scale', 'pet:focus'];
    if (!allowed.includes(ch)) throw new Error('channel not allowed: ' + ch);
    return listen(ch)(fn);
  },
  pet: {
    hitRects: (r) => ipcRenderer.send('pet:hit-rects', r),
    dragStart: () => ipcRenderer.send('pet:drag-start'),
    dragEnd: () => ipcRenderer.send('pet:drag-end'),
    menu: () => ipcRenderer.send('pet:menu'),
    bubbleAction: (a) => ipcRenderer.send('pet:bubble-action', a),
    drop: (paths) => ipcRenderer.send('pet:drop', paths),
    dropText: (t) => ipcRenderer.send('pet:drop-text', t),
  },
});
