# wechat-claude-code

[![GitHub Release](https://img.shields.io/github/v/release/jiaweirobot/wx_claude_link?style=flat-square)](https://github.com/jiaweirobot/wx_claude_link/releases/latest)
[![Build](https://img.shields.io/github/actions/workflow/status/jiaweirobot/wx_claude_link/build.yml?style=flat-square)](https://github.com/jiaweirobot/wx_claude_link/actions/workflows/build.yml)
[![License](https://img.shields.io/github/license/jiaweirobot/wx_claude_link?style=flat-square)](LICENSE)

[English](README.md) | **中文**

将个人微信桥接到本地 Claude Code 的工具。通过手机微信与 Claude 对话——文字、图片、权限审批、斜杠命令，全部支持。提供 CLI 和 **Electron 桌面 GUI** 两种运行模式。

## 下载安装

| 平台 | 下载 | 说明 |
|------|------|------|
| Windows (x64) | [**最新版本**](https://github.com/jiaweirobot/wx_claude_link/releases/latest) | `.exe` 安装包 |

> macOS 和 Linux 支持即将推出。

也可以在 [Releases](https://github.com/jiaweirobot/wx_claude_link/releases) 页面下载历史版本。

## 界面截图

![WeChat Claude Code - Windows 桌面版](docs/image.png)

## 功能特性

- **桌面 GUI** — Electron 应用，一键扫码登录、启停服务、查看状态和日志
- **实时进度推送** — 实时查看 Claude 的工具调用（🔧 Bash、📖 Read、🔍 Glob…）
- **思考预览** — 每次工具调用前展示 💭 Claude 的推理摘要（前 300 字）
- **中断支持** — 在 Claude 处理中发送新消息可打断当前任务
- **系统提示词** — 通过 `/prompt` 设置持久化提示词（如"用中文回答"）
- 通过微信与 Claude Code 进行文字对话
- 图片识别——发送照片让 Claude 分析
- 权限审批——在微信中回复 `y`/`n` 控制工具执行
- 斜杠命令——`/help`、`/clear`、`/model`、`/prompt`、`/status`、`/skills` 等
- 在微信中触发任意已安装的 Claude Code Skill
- 跨平台——**Windows**、macOS、Linux
- 会话持久化——跨消息恢复上下文
- 限频保护——微信 API 限频时自动指数退避重试

## 前置条件

- Node.js >= 18
- 个人微信账号（需扫码绑定）
- 已安装 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)（含 `@anthropic-ai/claude-agent-sdk`）
  > **注意：** 该 SDK 支持第三方 API 提供商（如 OpenRouter、AWS Bedrock、自定义 OpenAI 兼容接口）——按需设置 `ANTHROPIC_BASE_URL` 与 `ANTHROPIC_API_KEY` 即可。

## 安装

```bash
git clone https://github.com/jiaweirobot/wx_claude_link.git
cd wx_claude_link
npm install
```

`postinstall` 脚本会自动编译 TypeScript。

## 快速开始

### 方式 A：桌面 GUI（推荐）

```bash
npm run electron
```

点击 **"扫码登录"** 扫描二维码，然后点击 **"启动服务"** 即可。

### 方式 B：命令行

#### 1. 首次设置

```bash
npm run setup
```

会自动弹出二维码图片，用微信扫码后配置工作目录。

#### 2. 启动服务

```bash
# 前台运行
node dist/main.js start

# 后台守护进程
node scripts/daemon.js start
```

#### 3. 管理服务

```bash
node scripts/daemon.js status    # 查看运行状态
node scripts/daemon.js stop      # 停止服务
node scripts/daemon.js restart   # 重启服务
node scripts/daemon.js logs      # 查看最近日志
```

## 微信端命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助 |
| `/clear` | 清除当前会话（重新开始） |
| `/reset` | 完全重置（包括工作目录等设置） |
| `/model <名称>` | 切换 Claude 模型 |
| `/permission <模式>` | 切换权限模式 |
| `/prompt [内容]` | 查看或设置系统提示词（全局生效） |
| `/status` | 查看当前会话状态 |
| `/cwd [路径]` | 查看或切换工作目录 |
| `/skills` | 列出已安装的 Claude Code Skill |
| `/history [数量]` | 查看最近 N 条对话记录 |
| `/compact` | 压缩上下文（开始新 SDK 会话，保留历史） |
| `/undo [数量]` | 撤销最近 N 条对话 |
| `/<skill> [参数]` | 触发任意已安装的 Skill |

## 权限审批

当 Claude 请求执行工具时，微信会收到权限请求：

- 回复 `y` 或 `yes` 允许
- 回复 `n` 或 `no` 拒绝
- 120 秒未回复自动拒绝

通过 `/permission <模式>` 切换权限模式：

| 模式 | 说明 |
|------|------|
| `default` | 每次工具使用需手动审批 |
| `acceptEdits` | 自动批准文件编辑，其他需审批 |
| `plan` | 只读模式，不允许任何工具 |
| `auto` | 自动批准所有工具（危险模式） |

## 工作原理

```
微信（手机） ←→ ilink bot API ←→ Node.js 桥接服务 ←→ Claude Code SDK（本地）
                                       ↑
                            CLI 或 Electron 桌面 GUI
```

- 桥接服务通过长轮询监听微信 ilink bot API 的新消息
- 消息通过 `@anthropic-ai/claude-agent-sdk` 转发给 Claude Code
- 工具调用和思考摘要在 Claude 工作时实时推送
- 回复发送回微信，限频时自动重试
- 桌面 GUI 提供可视化控制（登录、启停、状态、日志）

## 项目结构

```
src/
├── daemon.ts            # 核心守护进程控制器 (start/stop/getStatus)
├── login-flow.ts        # QR 扫码登录流程（与 UI 解耦）
├── main.ts              # CLI 入口
├── session.ts           # 会话状态持久化
├── permission.ts        # 权限代理（y/n 审批 + 超时）
├── config.ts            # 配置文件管理
├── claude/
│   ├── provider.ts      # Claude Agent SDK 封装（流式响应、权限桥接）
│   └── skill-scanner.ts # 扫描已安装的 Skill
├── commands/
│   ├── router.ts        # 斜杠命令分发器
│   └── handlers.ts      # 命令实现
└── wechat/
    ├── api.ts           # ilink bot HTTP 客户端
    ├── monitor.ts       # 长轮询消息循环
    ├── send.ts          # 消息发送
    ├── login.ts         # QR 码登录协议
    ├── media.ts         # 图片下载 + 解密
    └── ...              # 类型定义、加密、CDN、账号存储

electron/
├── main.cjs             # Electron 主进程（IPC 处理）
├── preload.cjs          # 安全 IPC 桥接
├── index.html           # 桌面 UI
├── renderer.js          # 前端逻辑
└── styles.css           # 微信绿色主题样式
```

## 数据目录

所有数据存储在 `~/.wechat-claude-code/`：

```
~/.wechat-claude-code/
├── accounts/       # 微信账号凭证（每个账号一个 JSON）
├── config.env      # 全局配置（工作目录、模型、权限模式、系统提示词）
├── sessions/       # 会话数据（每个账号一个 JSON）
├── get_updates_buf # 消息轮询同步缓冲
└── logs/           # 运行日志（每日轮转，保留 30 天）
```

## 架构文档

详细的运行逻辑、消息流程图和模块依赖分析见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 开发

```bash
npm run dev       # 监听模式——TypeScript 文件变更时自动编译
npm run build     # 编译 TypeScript
npm run electron  # 启动桌面应用
```

## License

[MIT](LICENSE)
