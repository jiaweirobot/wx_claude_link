import { createInterface } from 'node:readline';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { unlinkSync, writeFileSync } from 'node:fs';

import { createDaemon } from './daemon.js';
import { startLogin } from './login-flow.js';
import { logger } from './logger.js';
import { DATA_DIR } from './constants.js';

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

function promptUser(question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const display = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    rl.question(display, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

function openFile(filePath: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];

  if (platform === 'darwin') {
    cmd = 'open';
    args = [filePath];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', filePath];
  } else {
    cmd = 'xdg-open';
    args = [filePath];
  }

  const result = spawnSync(cmd, args, { stdio: 'ignore' });
  if (result.error) {
    logger.warn('Failed to open file', { cmd, filePath, error: result.error.message });
  }
}

// ---------------------------------------------------------------------------
// Setup (CLI mode)
// ---------------------------------------------------------------------------

async function runSetup(): Promise<void> {
  const QR_PATH = join(DATA_DIR, 'qrcode.png');

  console.log('正在设置...\n');

  await startLogin({
    onQrCode: (pngBuffer, _url) => {
      const isHeadlessLinux = process.platform === 'linux' &&
        !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

      if (isHeadlessLinux) {
        import('qrcode-terminal').then((qrt) => {
          console.log('请用微信扫描下方二维码：\n');
          qrt.default.generate(_url, { small: true });
          console.log('\n二维码链接：', _url);
        }).catch(() => {
          console.log('请访问链接扫码：', _url);
        });
      } else {
        writeFileSync(QR_PATH, pngBuffer);
        openFile(QR_PATH);
        console.log('已打开二维码图片，请用微信扫描：');
        console.log(`图片路径: ${QR_PATH}\n`);
      }
    },
    onStatus: (status) => {
      console.log(status);
    },
    onNeedWorkDir: async () => {
      const dir = await promptUser('请输入工作目录', process.cwd());
      return dir;
    },
  });

  try { unlinkSync(QR_PATH); } catch { /* ignore */ }
  console.log('运行 npm run daemon -- start 启动服务');
}

// ---------------------------------------------------------------------------
// Daemon (CLI mode)
// ---------------------------------------------------------------------------

async function runDaemon(): Promise<void> {
  const daemon = createDaemon({
    onStatusChange: (status) => {
      if (status === 'error') console.error('服务出错');
    },
    onLog: (msg) => console.log(msg),
    onSessionExpired: () => {
      console.error('⚠️ 微信会话已过期，请重新运行 setup 扫码绑定');
    },
  });

  function shutdown(): void {
    daemon.stop();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  if (process.platform === 'win32') {
    process.on('SIGBREAK', shutdown);
  }

  await daemon.start();
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const command = process.argv[2];

if (command === 'setup') {
  runSetup().catch((err) => {
    logger.error('Setup failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('设置失败:', err);
    process.exit(1);
  });
} else {
  runDaemon().catch((err) => {
    logger.error('Daemon start failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('启动失败:', err);
    process.exit(1);
  });
}
