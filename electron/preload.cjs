const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  login: () => ipcRenderer.invoke('login:start'),
  startDaemon: () => ipcRenderer.invoke('daemon:start'),
  stopDaemon: () => ipcRenderer.invoke('daemon:stop'),
  getStatus: () => ipcRenderer.invoke('daemon:status'),
  getLogs: () => ipcRenderer.invoke('logs:read'),
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
  changeCwd: (path) => ipcRenderer.invoke('daemon:changeCwd', path),

  onQrCode: (cb) => {
    ipcRenderer.on('qr-code', (_, data) => cb(data));
  },
  onLoginStatus: (cb) => {
    ipcRenderer.on('login-status', (_, data) => cb(data));
  },
  onStatusUpdate: (cb) => {
    ipcRenderer.on('status-update', (_, data) => cb(data));
  },
  onLog: (cb) => {
    ipcRenderer.on('log-entry', (_, data) => cb(data));
  },
});
