import { mkdirSync } from 'node:fs';

import { startQrLogin, waitForQrScan } from './wechat/login.js';
import { loadConfig, saveConfig } from './config.js';
import { logger } from './logger.js';
import { DATA_DIR } from './constants.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LoginCallbacks {
  onQrCode: (pngBuffer: Buffer, url: string) => void;
  onStatus: (status: string) => void;
  onNeedWorkDir: () => Promise<string>;
}

// ---------------------------------------------------------------------------
// Login flow
// ---------------------------------------------------------------------------

export async function startLogin(callbacks: LoginCallbacks): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });

  callbacks.onStatus('正在获取二维码...');

  while (true) {
    const { qrcodeUrl, qrcodeId } = await startQrLogin();

    const QRCode = await import('qrcode');
    const pngBuffer = await QRCode.toBuffer(qrcodeUrl, { type: 'png', width: 400, margin: 2 });

    callbacks.onQrCode(pngBuffer, qrcodeUrl);
    callbacks.onStatus('请用微信扫描二维码');

    try {
      await waitForQrScan(qrcodeId);
      callbacks.onStatus('绑定成功！');
      break;
    } catch (err: any) {
      if (err.message?.includes('expired')) {
        callbacks.onStatus('二维码已过期，正在刷新...');
        continue;
      }
      throw err;
    }
  }

  const workDir = await callbacks.onNeedWorkDir();
  const config = loadConfig();
  config.workingDirectory = workDir;
  saveConfig(config);

  callbacks.onStatus('设置完成');
}
