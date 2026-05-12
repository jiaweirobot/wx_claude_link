import { homedir } from 'node:os';

import { WeChatApi } from './wechat/api.js';
import { loadLatestAccount, type AccountData } from './wechat/accounts.js';
import { createMonitor, type MonitorCallbacks } from './wechat/monitor.js';
import { createSender } from './wechat/send.js';
import { downloadImage, extractText, extractFirstImageUrl } from './wechat/media.js';
import { createSessionStore, type Session } from './session.js';
import { createPermissionBroker } from './permission.js';
import { routeCommand, type CommandContext, type CommandResult } from './commands/router.js';
import { claudeQuery, type QueryOptions } from './claude/provider.js';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { MessageType, type WeixinMessage } from './wechat/types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DaemonEvents {
  onStatusChange?: (status: 'idle' | 'running' | 'stopped' | 'error') => void;
  onLog?: (message: string) => void;
  onSessionExpired?: () => void;
}

export interface DaemonStatus {
  running: boolean;
  accountId?: string;
  sessionState?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_MESSAGE_LENGTH = 2048;

function splitMessage(text: string, maxLen: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx < maxLen * 0.3) {
      splitIdx = maxLen;
    }
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n+/, '');
  }
  return chunks;
}

function extractTextFromItems(items: NonNullable<WeixinMessage['item_list']>): string {
  return items.map((item) => extractText(item)).filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// DaemonController
// ---------------------------------------------------------------------------

export function createDaemon(events?: DaemonEvents) {
  let running = false;
  let monitor: ReturnType<typeof createMonitor> | null = null;
  let currentAccountId: string | undefined;
  let currentSession: Session | undefined;

  function emit(msg: string) {
    events?.onLog?.(msg);
  }

  async function start(): Promise<void> {
    if (running) {
      emit('Daemon is already running');
      return;
    }

    const config = loadConfig();
    const account = loadLatestAccount();

    if (!account) {
      events?.onStatusChange?.('error');
      throw new Error('未找到账号，请先扫码登录');
    }

    currentAccountId = account.accountId;

    const api = new WeChatApi(account.botToken, account.baseUrl);
    const sessionStore = createSessionStore();
    const session: Session = sessionStore.load(account.accountId);
    currentSession = session;

    if (config.workingDirectory && session.workingDirectory === process.cwd()) {
      session.workingDirectory = config.workingDirectory;
      sessionStore.save(account.accountId, session);
    }

    if (session.state !== 'idle') {
      logger.warn('Resetting stale session state on startup', { state: session.state });
      session.state = 'idle';
      sessionStore.save(account.accountId, session);
    }

    const sender = createSender(api, account.accountId);
    const sharedCtx = { lastContextToken: '' };
    const activeControllers = new Map<string, AbortController>();
    const permissionBroker = createPermissionBroker(async () => {
      try {
        await sender.sendText(account.userId ?? '', sharedCtx.lastContextToken, '⏰ 权限请求超时，已自动拒绝。');
      } catch {
        logger.warn('Failed to send permission timeout message');
      }
    });

    const callbacks: MonitorCallbacks = {
      onMessage: async (msg: WeixinMessage) => {
        await handleMessage(msg, account, session, sessionStore, permissionBroker, sender, config, sharedCtx, activeControllers);
      },
      onSessionExpired: () => {
        logger.warn('Session expired, will keep retrying...');
        emit('微信会话已过期，请重新扫码绑定');
        events?.onSessionExpired?.();
      },
    };

    monitor = createMonitor(api, callbacks);
    running = true;
    events?.onStatusChange?.('running');
    emit(`已启动 (账号: ${account.accountId})`);
    logger.info('Daemon started', { accountId: account.accountId });

    try {
      await monitor.run();
    } finally {
      running = false;
      events?.onStatusChange?.('stopped');
    }
  }

  function stop(): void {
    if (monitor) {
      logger.info('Shutting down...');
      monitor.stop();
      monitor = null;
      running = false;
      events?.onStatusChange?.('stopped');
      emit('服务已停止');
    }
  }

  function getStatus(): DaemonStatus {
    return {
      running,
      accountId: currentAccountId,
      sessionState: currentSession?.state,
    };
  }

  return { start, stop, getStatus };
}

// ---------------------------------------------------------------------------
// Message handling (moved from main.ts, unchanged logic)
// ---------------------------------------------------------------------------

async function handleMessage(
  msg: WeixinMessage,
  account: AccountData,
  session: Session,
  sessionStore: ReturnType<typeof createSessionStore>,
  permissionBroker: ReturnType<typeof createPermissionBroker>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
  sharedCtx: { lastContextToken: string },
  activeControllers: Map<string, AbortController>,
): Promise<void> {
  if (msg.message_type !== MessageType.USER) return;
  if (!msg.from_user_id || !msg.item_list) return;

  const contextToken = msg.context_token ?? '';
  const fromUserId = msg.from_user_id;
  sharedCtx.lastContextToken = contextToken;

  const userText = extractTextFromItems(msg.item_list);
  const imageItem = extractFirstImageUrl(msg.item_list);

  if (session.state === 'processing') {
    if (userText.startsWith('/clear')) {
      const ctrl = activeControllers.get(account.accountId);
      if (ctrl) { ctrl.abort(); activeControllers.delete(account.accountId); }
      session.state = 'idle';
      sessionStore.save(account.accountId, session);
    } else if (!userText.startsWith('/')) {
      const ctrl = activeControllers.get(account.accountId);
      if (ctrl) { ctrl.abort(); activeControllers.delete(account.accountId); }
      session.state = 'idle';
      sessionStore.save(account.accountId, session);
    } else if (!userText.startsWith('/status') && !userText.startsWith('/help')) {
      return;
    }
  }

  if (session.state === 'idle' && permissionBroker.isTimedOut(account.accountId)) {
    const lower = userText.toLowerCase();
    if (lower === 'y' || lower === 'yes' || lower === 'n' || lower === 'no') {
      permissionBroker.clearTimedOut(account.accountId);
      await sender.sendText(fromUserId, contextToken, '⏰ 权限请求已超时，请重新发送你的请求。');
      return;
    }
  }

  if (session.state === 'waiting_permission') {
    const pendingPerm = permissionBroker.getPending(account.accountId);
    if (!pendingPerm) {
      session.state = 'idle';
      sessionStore.save(account.accountId, session);
      await sender.sendText(fromUserId, contextToken, '⚠️ 权限请求已失效（可能因服务重启），请重新发送你的请求。');
      return;
    }

    const lower = userText.toLowerCase();
    if (lower === 'y' || lower === 'yes') {
      const resolved = permissionBroker.resolvePermission(account.accountId, true);
      await sender.sendText(fromUserId, contextToken, resolved ? '✅ 已允许' : '⚠️ 权限请求处理失败，可能已超时');
    } else if (lower === 'n' || lower === 'no') {
      const resolved = permissionBroker.resolvePermission(account.accountId, false);
      await sender.sendText(fromUserId, contextToken, resolved ? '❌ 已拒绝' : '⚠️ 权限请求处理失败，可能已超时');
    } else {
      await sender.sendText(fromUserId, contextToken, '正在等待权限审批，请回复 y 或 n。');
    }
    return;
  }

  if (userText.startsWith('/')) {
    const updateSession = (partial: Partial<Session>) => {
      Object.assign(session, partial);
      sessionStore.save(account.accountId, session);
    };

    const ctx: CommandContext = {
      accountId: account.accountId,
      session,
      updateSession,
      clearSession: () => sessionStore.clear(account.accountId),
      getChatHistoryText: (limit?: number) => sessionStore.getChatHistoryText(session, limit),
      rejectPendingPermission: () => permissionBroker.rejectPending(account.accountId),
      text: userText,
    };

    const result: CommandResult = routeCommand(ctx);

    if (result.handled && result.reply) {
      await sender.sendText(fromUserId, contextToken, result.reply);
      return;
    }

    if (result.handled && result.claudePrompt) {
      await sendToClaude(
        result.claudePrompt, imageItem, fromUserId, contextToken,
        account, session, sessionStore, permissionBroker, sender, config, activeControllers,
      );
      return;
    }

    if (result.handled) return;
  }

  if (!userText && !imageItem) {
    await sender.sendText(fromUserId, contextToken, '暂不支持此类型消息，请发送文字或图片');
    return;
  }

  await sendToClaude(
    userText, imageItem, fromUserId, contextToken,
    account, session, sessionStore, permissionBroker, sender, config, activeControllers,
  );
}

async function sendToClaude(
  userText: string,
  imageItem: ReturnType<typeof extractFirstImageUrl>,
  fromUserId: string,
  contextToken: string,
  account: AccountData,
  session: Session,
  sessionStore: ReturnType<typeof createSessionStore>,
  permissionBroker: ReturnType<typeof createPermissionBroker>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
  activeControllers: Map<string, AbortController>,
): Promise<void> {
  session.state = 'processing';
  sessionStore.save(account.accountId, session);

  const abortController = new AbortController();
  activeControllers.set(account.accountId, abortController);

  sessionStore.addChatMessage(session, 'user', userText || '(图片)');

  try {
    let images: QueryOptions['images'];
    if (imageItem) {
      const base64DataUri = await downloadImage(imageItem);
      if (base64DataUri) {
        const matches = base64DataUri.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          images = [{
            type: 'image',
            source: { type: 'base64', media_type: matches[1], data: matches[2] },
          }];
        }
      }
    }

    const effectivePermissionMode = session.permissionMode ?? config.permissionMode;
    const isAutoPermission = effectivePermissionMode === 'auto';
    const sdkPermissionMode = isAutoPermission ? 'bypassPermissions' : effectivePermissionMode;

    let pendingBuffer = '';
    let anySent = false;
    let lastSendTime = Date.now();
    const SEND_INTERVAL_MS = 36_000;

    async function trySend(force = false): Promise<void> {
      if (!pendingBuffer.trim()) return;
      const now = Date.now();
      if (!force && now - lastSendTime < SEND_INTERVAL_MS) return;
      const toSend = pendingBuffer.trim();
      pendingBuffer = '';
      const chunks = splitMessage(toSend);
      for (const chunk of chunks) {
        lastSendTime = Date.now();
        anySent = true;
        await sender.sendText(fromUserId, contextToken, chunk);
      }
    }

    const queryOptions: QueryOptions = {
      prompt: userText || '请分析这张图片',
      cwd: (session.workingDirectory || config.workingDirectory).replace(/^~/, process.env.HOME || process.env.USERPROFILE || homedir()),
      resume: session.sdkSessionId,
      model: session.model,
      systemPrompt: config.systemPrompt,
      permissionMode: sdkPermissionMode,
      abortController,
      images,
      onText: async (delta: string) => {
        pendingBuffer += delta;
        await trySend();
      },
      onThinking: async (summary: string) => {
        pendingBuffer += (pendingBuffer ? '\n' : '') + summary;
        await trySend();
      },
      onPermissionRequest: isAutoPermission
        ? async () => true
        : async (toolName: string, toolInput: string) => {
            session.state = 'waiting_permission';
            sessionStore.save(account.accountId, session);

            const permissionPromise = permissionBroker.createPending(account.accountId, toolName, toolInput);

            const perm = permissionBroker.getPending(account.accountId);
            if (perm) {
              const permMsg = permissionBroker.formatPendingMessage(perm);
              await sender.sendText(fromUserId, contextToken, permMsg);
            }

            const allowed = await permissionPromise;

            session.state = 'processing';
            sessionStore.save(account.accountId, session);

            return allowed;
          },
    };

    let result = await claudeQuery(queryOptions);

    if (result.error && queryOptions.resume) {
      logger.warn('Resume failed, retrying without resume', { error: result.error, sessionId: queryOptions.resume });
      queryOptions.resume = undefined;
      session.sdkSessionId = undefined;
      sessionStore.save(account.accountId, session);
      const retryResult = await claudeQuery(queryOptions);
      Object.assign(result, retryResult);
    }

    await trySend(true);

    if (result.text) {
      if (result.error) {
        logger.warn('Claude query had error but returned text, using text', { error: result.error });
      }
      sessionStore.addChatMessage(session, 'assistant', result.text);
      if (!anySent) {
        const chunks = splitMessage(result.text);
        for (const chunk of chunks) {
          await sender.sendText(fromUserId, contextToken, chunk);
        }
      }
    } else if (result.error) {
      logger.error('Claude query error', { error: result.error });
      await sender.sendText(fromUserId, contextToken, '⚠️ Claude 处理请求时出错，请稍后重试。');
    } else if (!anySent) {
      await sender.sendText(fromUserId, contextToken, 'ℹ️ Claude 无返回内容（可能因权限被拒而终止）');
    }

    session.sdkSessionId = result.sessionId || undefined;
    session.state = 'idle';
    sessionStore.save(account.accountId, session);
  } catch (err) {
    const isAbort = err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort'));
    if (isAbort) {
      logger.info('Claude query aborted by new message');
    } else {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('Error in sendToClaude', { error: errorMsg });
      await sender.sendText(fromUserId, contextToken, '⚠️ 处理消息时出错，请稍后重试。');
    }
    session.state = 'idle';
    sessionStore.save(account.accountId, session);
  } finally {
    if (activeControllers.get(account.accountId) === abortController) {
      activeControllers.delete(account.accountId);
    }
  }
}
