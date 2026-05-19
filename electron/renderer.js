const $ = (sel) => document.querySelector(sel);

const btnLogin = $('#btnLogin');
const btnStart = $('#btnStart');
const btnStop = $('#btnStop');
const btnRefreshStatus = $('#btnRefreshStatus');
const btnLoadLogs = $('#btnLoadLogs');
const statusDot = $('#statusDot');
const statusText = $('#statusText');
const qrSection = $('#qrSection');
const qrImage = $('#qrImage');
const qrHint = $('#qrHint');
const logContainer = $('#logContainer');
const infoAccountId = $('#infoAccountId');
const infoSessionState = $('#infoSessionState');
const infoCwd = $('#infoCwd');
const btnChangeCwd = $('#btnChangeCwd');

let isRunning = false;

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function setStatus(running, text) {
  isRunning = running;
  statusDot.className = 'status-indicator ' + (running ? 'running' : 'stopped');
  statusText.textContent = text || (running ? '运行中' : '已停止');
  btnStart.disabled = running;
  btnStop.disabled = !running;
}

function appendLog(msg) {
  const placeholder = logContainer.querySelector('.log-placeholder');
  if (placeholder) placeholder.remove();

  const entry = document.createElement('div');
  entry.className = 'log-entry';
  const time = new Date().toLocaleTimeString();
  entry.textContent = `[${time}] ${msg}`;
  logContainer.appendChild(entry);
  logContainer.scrollTop = logContainer.scrollHeight;

  // Keep last 200 entries
  while (logContainer.children.length > 200) {
    logContainer.removeChild(logContainer.firstChild);
  }
}

// ---------------------------------------------------------------------------
// Button handlers
// ---------------------------------------------------------------------------

btnLogin.addEventListener('click', async () => {
  btnLogin.disabled = true;
  qrSection.style.display = 'block';
  qrHint.textContent = '正在获取二维码...';
  appendLog('开始扫码登录...');

  const result = await window.api.login();

  if (result.success) {
    qrSection.style.display = 'none';
    appendLog('登录成功！');
  } else {
    qrHint.textContent = '登录失败: ' + (result.error || '未知错误');
    appendLog('登录失败: ' + (result.error || '未知错误'));
  }

  btnLogin.disabled = false;
});

btnStart.addEventListener('click', async () => {
  btnStart.disabled = true;
  appendLog('正在启动服务...');

  const result = await window.api.startDaemon();

  if (result.success) {
    setStatus(true, '运行中');
    appendLog('服务启动成功');
  } else {
    setStatus(false, '启动失败');
    appendLog('启动失败: ' + (result.error || '未知错误'));
    btnStart.disabled = false;
  }
});

btnStop.addEventListener('click', async () => {
  appendLog('正在停止服务...');

  const result = await window.api.stopDaemon();

  if (result.success) {
    setStatus(false, '已停止');
    appendLog('服务已停止');
  } else {
    appendLog('停止失败: ' + (result.error || ''));
  }
});

btnRefreshStatus.addEventListener('click', async () => {
  const status = await window.api.getStatus();
  setStatus(status.running, status.running ? '运行中' : '未启动');
  infoAccountId.textContent = status.accountId || '-';
  infoSessionState.textContent = status.sessionState || '-';
  if (status.workingDirectory) {
    infoCwd.textContent = status.workingDirectory;
    infoCwd.title = status.workingDirectory;
  }
  appendLog('状态已刷新');
});

btnChangeCwd.addEventListener('click', async () => {
  const folder = await window.api.selectFolder();
  if (!folder) return;
  const result = await window.api.changeCwd(folder);
  if (result.success) {
    infoCwd.textContent = folder;
    infoCwd.title = folder;
    appendLog(`工作目录已切换: ${folder}`);
  } else {
    appendLog('切换目录失败: ' + (result.error || ''));
  }
});

btnLoadLogs.addEventListener('click', async () => {
  const logs = await window.api.getLogs();
  if (logs) {
    const placeholder = logContainer.querySelector('.log-placeholder');
    if (placeholder) placeholder.remove();
    logContainer.innerHTML = '';
    const lines = logs.split('\n').filter(Boolean).slice(-50);
    for (const line of lines) {
      const entry = document.createElement('div');
      entry.className = 'log-entry';
      entry.textContent = line;
      logContainer.appendChild(entry);
    }
    logContainer.scrollTop = logContainer.scrollHeight;
  }
});

// ---------------------------------------------------------------------------
// IPC event listeners
// ---------------------------------------------------------------------------

window.api.onQrCode((data) => {
  qrSection.style.display = 'block';
  qrImage.src = 'data:image/png;base64,' + data.base64;
  qrHint.textContent = '请用微信扫描二维码';
});

window.api.onLoginStatus((status) => {
  qrHint.textContent = status;
  appendLog(status);
});

window.api.onStatusUpdate((data) => {
  if (data.type === 'daemon-status') {
    const running = data.status === 'running';
    setStatus(running, running ? '运行中' : '已停止');
  } else if (data.type === 'session-expired') {
    setStatus(false, '会话过期');
    appendLog('微信会话已过期，请重新扫码登录');
  } else if (data.type === 'daemon-error') {
    setStatus(false, '出错');
    appendLog('服务错误: ' + data.error);
  }
});

window.api.onLog((msg) => {
  appendLog(msg);
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

(async () => {
  const status = await window.api.getStatus();
  setStatus(status.running, status.running ? '运行中' : '未启动');
  if (status.accountId) infoAccountId.textContent = status.accountId;
  if (status.sessionState) infoSessionState.textContent = status.sessionState;
  if (status.workingDirectory) {
    infoCwd.textContent = status.workingDirectory;
    infoCwd.title = status.workingDirectory;
  }
})();
