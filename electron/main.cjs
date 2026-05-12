// Electron 42+: node_modules/electron/index.js shadows the built-in 'electron'
// module. Patch _resolveFilename so require('electron') hits the built-in _load hook.
const Module = require('module');
const origResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'electron') return 'electron';
  return origResolveFilename.call(this, request, parent, isMain, options);
};

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DATA_DIR = process.env.WCC_DATA_DIR || path.join(os.homedir(), '.wechat-claude-code');
const LOG_DIR = path.join(DATA_DIR, 'logs');

let mainWindow = null;
let daemon = null;
let daemonPromise = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 600,
    minHeight: 450,
    title: 'WeChat Claude Code',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.setMenuBarVisibility(false);
}

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

async function loadModules() {
  const { createDaemon } = await import('../dist/daemon.js');
  const { startLogin } = await import('../dist/login-flow.js');
  return { createDaemon, startLogin };
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

ipcMain.handle('login:start', async () => {
  try {
    const { startLogin } = await loadModules();

    await startLogin({
      onQrCode: (pngBuffer, url) => {
        const base64 = pngBuffer.toString('base64');
        sendToRenderer('qr-code', { base64, url });
      },
      onStatus: (status) => {
        sendToRenderer('login-status', status);
      },
      onNeedWorkDir: async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
          title: '选择工作目录',
          properties: ['openDirectory'],
          defaultPath: process.cwd(),
        });
        if (result.canceled || !result.filePaths.length) {
          return process.cwd();
        }
        return result.filePaths[0];
      },
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('daemon:start', async () => {
  if (daemon && daemon.getStatus().running) {
    return { success: false, error: '服务已在运行中' };
  }

  try {
    const { createDaemon } = await loadModules();

    daemon = createDaemon({
      onStatusChange: (status) => {
        sendToRenderer('status-update', { type: 'daemon-status', status });
      },
      onLog: (msg) => {
        sendToRenderer('log-entry', msg);
      },
      onSessionExpired: () => {
        sendToRenderer('status-update', { type: 'session-expired' });
      },
    });

    daemonPromise = daemon.start().catch((err) => {
      sendToRenderer('status-update', { type: 'daemon-error', error: err.message });
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('daemon:stop', async () => {
  if (daemon) {
    daemon.stop();
    daemon = null;
    daemonPromise = null;
    return { success: true };
  }
  return { success: false, error: '服务未在运行' };
});

ipcMain.handle('daemon:status', async () => {
  if (daemon) {
    return daemon.getStatus();
  }
  return { running: false };
});

ipcMain.handle('logs:read', async () => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const logFile = path.join(LOG_DIR, `bridge-${today}.log`);
    if (!fs.existsSync(logFile)) return '';
    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.split('\n');
    return lines.slice(-100).join('\n');
  } catch {
    return '';
  }
});

ipcMain.handle('dialog:selectFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择工作目录',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (daemon) daemon.stop();
  app.quit();
});

app.on('before-quit', () => {
  if (daemon) daemon.stop();
});
