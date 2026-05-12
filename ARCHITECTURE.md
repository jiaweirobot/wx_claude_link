# WeChat Claude Code - 运行逻辑文档

## 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                     入口层 (二选一)                               │
│  ┌──────────────────┐         ┌──────────────────────────────┐  │
│  │ CLI (main.ts)    │         │ Electron (electron/main.cjs) │  │
│  │ node dist/main.js│         │ npx electron .               │  │
│  └────────┬─────────┘         └──────────────┬───────────────┘  │
├───────────┼──────────────────────────────────┼──────────────────┤
│           │          编排层                    │                  │
│  ┌────────▼──────────────────────────────────▼───────────────┐  │
│  │ daemon.ts          createDaemon() → { start, stop, ... }  │  │
│  │ login-flow.ts      startLogin(callbacks) → QR → 扫码      │  │
│  └────────┬───────────────────────────────────────────────┬──┘  │
├───────────┼───────────────────────────────────────────────┼─────┤
│           │          业务逻辑层                             │     │
│  ┌────────▼──────┐  ┌──────────────┐  ┌──────────────────▼──┐  │
│  │ claude/       │  │ commands/    │  │ permission.ts       │  │
│  │ provider.ts   │  │ router.ts    │  │ session.ts          │  │
│  │ (Agent SDK)   │  │ handlers.ts  │  │ config.ts           │  │
│  └───────────────┘  └──────────────┘  └─────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│                     微信协议层                                   │
│  ┌──────────┐ ┌───────────┐ ┌────────┐ ┌────────┐ ┌─────────┐ │
│  │ api.ts   │ │monitor.ts │ │send.ts │ │login.ts│ │media.ts │ │
│  │ HTTP客户端│ │长轮询循环  │ │消息发送 │ │扫码登录│ │图片处理  │ │
│  └──────────┘ └───────────┘ └────────┘ └────────┘ └────┬────┘ │
│                                                         │      │
│                                          ┌──────────────▼────┐ │
│                                          │cdn.ts → crypto.ts │ │
│                                          │AES-128-ECB 解密   │ │
│                                          └───────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│                     基础设施层                                   │
│  ┌────────────┐  ┌──────────┐  ┌───────────┐  ┌────────────┐  │
│  │constants.ts│  │logger.ts │  │ store.ts  │  │accounts.ts │  │
│  │数据目录     │  │日志轮转   │  │JSON 持久化│  │账号存储     │  │
│  └────────────┘  └──────────┘  └───────────┘  └────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 模块说明

### 入口层

| 模块 | 说明 |
|------|------|
| `src/main.ts` | CLI 入口。`setup` 子命令触发扫码登录，默认启动守护进程。处理 SIGINT/SIGTERM/SIGBREAK 信号 |
| `electron/main.cjs` | Electron 主进程。创建窗口，注册 IPC 通道（`login:start`、`daemon:start/stop/status`、`logs:read`） |
| `electron/preload.cjs` | 通过 `contextBridge` 向渲染进程暴露 `window.api` 安全接口 |
| `electron/renderer.js` | 前端 UI 逻辑，绑定按钮事件，渲染状态和日志 |

### 编排层

| 模块 | 说明 |
|------|------|
| `src/daemon.ts` | **核心模块**。`createDaemon()` 工厂函数，组装所有协作对象（API 客户端、轮询器、发送器、权限代理、会话存储），提供 `start()`/`stop()`/`getStatus()` |
| `src/login-flow.ts` | `startLogin(callbacks)` 编排扫码流程。通过回调与上层解耦（QR 图片、状态、工作目录选择） |

### 业务逻辑层

| 模块 | 说明 |
|------|------|
| `src/claude/provider.ts` | 封装 `@anthropic-ai/claude-agent-sdk`。处理流式响应（text_delta、thinking_delta、tool_use）、权限桥接、会话恢复、5 分钟超时 |
| `src/claude/skill-scanner.ts` | 扫描 `~/.claude/skills/` 和插件目录下的 `SKILL.md` 文件，解析 YAML frontmatter |
| `src/commands/router.ts` | 斜杠命令分发器。支持 `/help`、`/clear`、`/model`、`/permission`、`/status`、`/skills` 等 14 个命令 |
| `src/commands/handlers.ts` | 各命令的具体实现。未识别的命令会尝试匹配已安装的 skill |
| `src/permission.ts` | 权限代理。当 Claude 需要使用工具时，创建 pending promise，等待用户 y/n 回复或 120 秒超时自动拒绝。超时后有 15 秒宽限期处理迟到回复 |
| `src/session.ts` | 会话状态持久化。管理 `sdkSessionId`（支持会话恢复）、`chatHistory`（上限 100 条）、`workingDirectory`、`model`、`permissionMode` |
| `src/config.ts` | 配置文件读写（`~/.wechat-claude-code/config.env`），支持 `workingDirectory`、`model`、`permissionMode`、`systemPrompt` |

### 微信协议层

| 模块 | 说明 |
|------|------|
| `src/wechat/api.ts` | HTTP 客户端。调用 `ilinkai.weixin.qq.com` 的 iLink Bot API。发送消息时自动重试（最多 3 次，指数退避 10s→60s） |
| `src/wechat/monitor.ts` | 长轮询循环。35 秒超时拉取，按 `message_id` 去重（缓存上限 1000），**fire-and-forget 分发**（不阻塞轮询） |
| `src/wechat/send.ts` | 消息发送。构造 `OutboundMessage`，生成 `wcc-{timestamp}-{counter}` 格式的 `client_id` |
| `src/wechat/login.ts` | 两阶段 QR 登录：获取二维码 → 每 3 秒轮询扫描状态（wait → scaned → confirmed / expired） |
| `src/wechat/media.ts` | 从消息中提取文本/图片，下载并解密 CDN 图片，转为 base64 data URI |
| `src/wechat/cdn.ts` | CDN 下载 + AES-128-ECB 解密。支持两种密钥编码格式 |
| `src/wechat/crypto.ts` | AES-128-ECB 加解密原语 |
| `src/wechat/types.ts` | 协议类型定义。`MessageType`（USER=1, BOT=2）、`MessageItemType`（TEXT=1, IMAGE=2, ...）等 |
| `src/wechat/sync-buf.ts` | 持久化轮询游标，重启后从正确位置恢复 |
| `src/wechat/accounts.ts` | 账号凭证存储（`botToken`、`accountId`、`baseUrl`），一个账号一个 JSON 文件 |

---

## 核心流程

### 1. 扫码登录流程

```
用户点击"扫码登录"
    │
    ▼
startLogin()
    │
    ├── GET /ilink/bot/get_bot_qrcode?bot_type=3
    │   返回 { qrcodeUrl, qrcodeId }
    │
    ├── 生成 QR 码 PNG (qrcode 库, 400px)
    │   ├── CLI: 写文件并用系统查看器打开 / 终端渲染
    │   └── Electron: base64 通过 IPC 发送到渲染进程显示
    │
    ├── 用户用微信扫码
    │
    ├── waitForQrScan() 每 3 秒轮询
    │   GET /ilink/bot/get_qrcode_status?qrcode={id}
    │   ├── wait    → 继续轮询
    │   ├── scaned  → 继续轮询
    │   ├── expired → 抛异常 → 循环回去重新获取二维码
    │   └── confirmed → 返回 bot_token + account_id
    │
    ├── saveAccount() → ~/.wechat-claude-code/accounts/{id}.json
    │
    ├── 用户选择工作目录
    │   ├── CLI: stdin 输入
    │   └── Electron: 原生文件夹选择对话框
    │
    └── saveConfig() → ~/.wechat-claude-code/config.env
```

### 2. 消息处理流程

```
微信用户发消息
    │
    ▼
WeChatApi.getUpdates()  ←── 长轮询 (35s 超时)
    │
    ▼
monitor.run()
    │ 去重 (message_id, 缓存上限 1000)
    │ 保存轮询游标 (sync-buf)
    │ fire-and-forget 分发 (不阻塞下次轮询)
    │
    ▼
handleMessage()
    │
    ├── 过滤: 只处理 MessageType.USER
    │
    ├── 如果正在处理中 (state=processing):
    │   ├── /clear → abort 当前查询 + 执行 clear
    │   ├── 普通文本 → abort 当前查询 + 处理新消息
    │   └── 其他命令 → 忽略 (除 /status, /help)
    │
    ├── 如果等待权限 (state=waiting_permission):
    │   ├── y/yes → resolvePermission(true) → "已允许"
    │   ├── n/no  → resolvePermission(false) → "已拒绝"
    │   └── 其他  → "请回复 y 或 n"
    │
    ├── 如果是斜杠命令 (/xxx):
    │   ├── routeCommand() 分发
    │   ├── 命令返回 reply → 直接回复
    │   ├── 命令返回 claudePrompt → 转发给 Claude
    │   └── 未识别 → 查找 skill → 找到则转发
    │
    └── 普通消息 → sendToClaude()
```

### 3. Claude 查询流程

```
sendToClaude()
    │
    ├── state = 'processing'
    ├── 创建 AbortController (支持被新消息取消)
    ├── 记录用户消息到 chatHistory
    │
    ├── 如果有图片:
    │   └── downloadImage()
    │       └── CDN 下载 → AES-128-ECB 解密 → base64 data URI
    │
    ├── 构建 QueryOptions
    │   ├── prompt, cwd, model, systemPrompt
    │   ├── resume (sdkSessionId, 支持会话续接)
    │   ├── permissionMode (default/acceptEdits/plan/bypassPermissions)
    │   └── 回调: onText, onThinking, onPermissionRequest
    │
    ├── claudeQuery() 调用 Agent SDK
    │   │
    │   ├── 流式事件处理:
    │   │   ├── text_delta → 累积到 pendingBuffer
    │   │   ├── thinking_delta → 截断 300 字符预览
    │   │   └── tool_use → 格式化摘要 (emoji + 工具名 + 参数)
    │   │
    │   ├── 权限请求 (非 auto 模式):
    │   │   ├── state = 'waiting_permission'
    │   │   ├── 发送权限消息到微信
    │   │   ├── 等待用户 y/n (120s 超时)
    │   │   └── state = 'processing' (恢复)
    │   │
    │   └── 5 分钟总超时
    │
    ├── 流式发送 (每 36 秒刷一次 buffer):
    │   ├── splitMessage() 按 2048 字符切分
    │   └── sender.sendText() → WeChatApi.sendMessage()
    │
    ├── 查询结束后强制刷新剩余 buffer
    │
    ├── 如果 resume 失败 → 清除 sessionId, 重试
    │
    ├── 记录助手回复到 chatHistory
    ├── 保存 sdkSessionId (下次可续接)
    └── state = 'idle'
```

---

## 关键参数一览

| 参数 | 值 | 位置 | 说明 |
|------|------|------|------|
| 消息最大长度 | 2048 字符 | daemon.ts | 超过则按换行符拆分 |
| 流式发送间隔 | 36 秒 | daemon.ts | 避免微信 API 限流 |
| 轮询超时 | 35 秒 | wechat/api.ts | getUpdates 长轮询 |
| 请求超时 | 15 秒 | wechat/api.ts | 普通 API 请求 |
| 发送重试 | 3 次 | wechat/api.ts | ret=-2 时指数退避 (10s→60s) |
| 权限超时 | 120 秒 | permission.ts | 自动拒绝 |
| 权限宽限期 | 15 秒 | permission.ts | 处理迟到的 y/n |
| Claude 查询超时 | 5 分钟 | claude/provider.ts | |
| thinking 预览 | 300 字符 | claude/provider.ts | 截断后加 "..." |
| 扫码轮询间隔 | 3 秒 | wechat/login.ts | |
| 去重缓存 | 1000 条 | wechat/monitor.ts | 超过后清除旧的一半 |
| 聊天记录上限 | 100 条 | session.ts | 超过自动清除最旧 |
| 日志保留 | 30 天 | logger.ts | 每日轮转 |
| Skill 缓存 | 60 秒 | commands/handlers.ts | |

---

## 数据目录结构

```
~/.wechat-claude-code/
├── accounts/                   # 微信账号凭证
│   └── {accountId}.json        #   botToken, accountId, baseUrl, userId
├── sessions/                   # 会话状态
│   └── {accountId}.json        #   sdkSessionId, chatHistory, model, state
├── config.env                  # 全局配置 (workingDirectory, model, permissionMode)
├── get_updates_buf             # 轮询游标 (重启后断点续传)
└── logs/                       # 运行日志
    └── bridge-YYYY-MM-DD.log   #   每日轮转, 敏感信息脱敏
```

---

## 两种运行模式

### CLI 模式

```bash
node dist/main.js setup     # 扫码登录
node dist/main.js start     # 前台运行
node scripts/daemon.js start  # 后台守护进程
```

### Electron 桌面模式

```bash
npm run build                # 编译 TypeScript
npx electron .               # 启动桌面应用
```

桌面应用通过 IPC 通道控制后端模块，共享同一套核心逻辑。
