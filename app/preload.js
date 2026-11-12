const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const handler = (_e, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('bird', {
  // 공통
  getState: () => ipcRenderer.invoke('state:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  sendNote: (n) => ipcRenderer.invoke('note:send', n),
  markRead: (id) => ipcRenderer.invoke('note:read', id),
  replayNote: (id) => ipcRenderer.invoke('note:replay', id),
  deleteNote: (id) => ipcRenderer.invoke('note:delete', id),
  onState: on('state'),
  onCompose: on('compose'),

  // 파랑새 오버레이 전용
  setClickable: (v) => ipcRenderer.send('overlay:clickable', v),
  overlayDone: (completed) => ipcRenderer.send('overlay:done', completed),
  reply: (note) => ipcRenderer.send('note:reply', note),
  onFly: on('fly'),
});
