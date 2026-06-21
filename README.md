# Ephem · 临时加密聊天室

> 端到端加密的命令行聊天室。创建房间 → 拿到房间码 → 双方在 CLI 里输入即可对话。

**房间到期或人数耗尽后自动销毁，不留持久化记录。后端只转发密文，看不到任何聊天内容。**

![CI](https://github.com/WEP-56/Ephem-cli/actions/workflows/ci.yml/badge.svg)
![Release](https://github.com/WEP-56/Ephem-cli/actions/workflows/release.yml/badge.svg)

```
ephem · correct-horse-battery  2/2 人                          ⏳ 00:57:47
输入消息回车发送 · Ctrl+C 退出

已加入房间  correct-horse-battery（2/2 人）
20:12 test: hi
20:12 test: 牛逼
20:12 123: 牛逼吧
20:12 123: glm5.2确实好用
20:12 test: 确实，我觉得也是，这么快做出来了
20:12 test: 而且很好用

> 输入消息...
```

## 快速开始

### 安装

```bash
# 全局安装（推荐）
npm install -g ephem-cli

# 或者用 npx 直接跑
npx ephem-cli
```

### 使用

```bash
ephem
# 按提示依次输入：
#   1. 后端地址（回车使用默认值 / 设 EPHEM_SERVER 环境变量跳过）
#   2. 房间码（从 Admin 页面获取）
#   3. 你的名字

# 也可以一行命令直连（适合脚本场景）
ephem --server wss://your-worker.workers.dev --room correct-horse-battery --username taoran
```

**安全提示**：通过 `--room` 传入的房间码可能被记录到 shell 历史。建议优先交互式输入。

## 架构

```
┌──────────────┐     WSS (加密消息)    ┌──────────────────────┐
│  ephem CLI A │ ──────────────────▶  │                      │
│  Node + ink  │ ◀──────────────────  │  Cloudflare Workers   │
└──────────────┘                       │  + Durable Objects   │
                                       │                      │
┌──────────────┐     WSS (加密消息)    │  - 房间状态管理       │
│  ephem CLI B │ ──────────────────▶  │  - 消息中转(密文)      │
│  Node + ink  │ ◀──────────────────  │  - TTL/人数控制       │
└──────────────┘                      └──────────┬───────────┘
                                               │ HTTPS (REST)
                                      ┌────────▼───────────┐
                                      │     Admin 页面      │
                                      │  创建/管理房间      │
                                      └────────────────────┘
```

## 安全设计

- **端到端加密**：AES-256-GCM，密钥由房间码经 HKDF(SHA-256) 在本地派生
- **零知识后端**：只看到密文 + 房间哈希，不解密、不存储任何消息内容
- **房间码不落盘**：后端只存 SHA-256 哈希，即使数据库被拖库也不暴露房间码
- **自动销毁**：TTL 到期 / 所有成员离开超时 / 管理员手动 → DO 状态彻底清空
- **连接限流**：单 IP 每分钟最多 15 次连接尝试（防暴力枚举）

## 部署

### Cloudflare Workers（推荐）

详见 [DEPLOY.md](./DEPLOY.md)

```bash
cd packages/backend-cloudflare
npm install
npx wrangler login          # 首次登录 Cloudflare 账号
npx wrangler secret put ADMIN_PASSWORD   # 设置管理员密码
npx wrangler deploy         # 一键部署
```

部署成功后拿到 `https://ephem-backend.<subdomain>.workers.dev` 地址，
CLI 用 `--server wss://...` 连接即可。

### Hugging Face Spaces（备选）

详见 [DEPLOY.md](./DEPLOY.md) 的备选方案章节。

## 第三方客户端接入

后端是标准 HTTP + WebSocket 接口，任何平台都能对接。完整协议规范见 **[API.md](./API.md)**：

- [Flutter / Android / iOS](./API.md#8-flutter-客户端实现指引)（含 Dart 加密示例代码）
- Web 浏览器（已计划）
- 桌面应用

加房间码 → 派生密钥 → WSS 连接 → 收发密文，按文档走就能和官方 `ephem-cli` 互通。

## npm 发布

详见 [PUBLISH.md](./PUBLISH.md)

## 项目结构

```
ephem/
├── packages/
│   ├── cli/                        # CLI 包（发布到 npm 的 ephem-cli）
│   │   ├── src/
│   │   │   ├── index.ts            # 入口 & 参数解析
│   │   │   ├── ui/                 # ink TUI 组件
│   │   │   │   ├── App.tsx         # 根组件（setup/chat/error 切换）
│   │   │   │   ├── SetupWizard.tsx # 三步问答（地址/房间码/用户名）
│   │   │   │   └── ChatRoom.tsx    # 聊天室主界面
│   │   │   ├── crypto/             # 加密模块
│   │   │   │   ├── deriveKey.ts    # HKDF 密钥派生
│   │   │   └── cipher.ts          # AES-256-GCM 加解密
│   │   │   └── ws/client.ts        # WS 客户端（心跳/重连）
│   │   └── package.json            # name: "ephem-cli"
│   │
│   └── backend-cloudflare/         # Cloudflare Worker 后端
│       ├── src/
│       │   ├── index.ts            # Worker 入口（路由分发）
│       │   ├── RoomObject.ts       # Durable Object（房间状态+WS处理）
│       │   ├── admin.ts            # Admin REST API
│       │   ├── roomCode.ts         # 房间码生成与哈希
│       │   ├── wordlist.ts         # BIP39 词表
│       │   └── rateLimit.ts        # 滑动窗口限流器
│       ├── public/                 # Admin 静态页面
│       └── wrangler.toml           # CF 配置
│
├── DEPLOY.md                       # 部署指南
├── PUBLISH.md                      # npm 发布指南
├── ephem-implementation-guide.md   # 完整实现文档
└── README.md
```

## 技术栈

| 组件 | 技术 |
|------|------|
| CLI 运行时 | Node.js ≥ 18 |
| TUI 框架 | [ink](https://github.com/vadimdemedes/ink) (React for CLI) |
| 加密 | Node 内置 `crypto` (HKDF-SHA256 + AES-256-GCM) |
| WebSocket | `ws` 库 |
| 参数解析 | `commander` |
| 移动端 | [Flutter](https://flutter.dev/) (Android/iOS) |
| 后端运行时 | [Cloudflare Workers](https://workers.cloudflare.com/) |
| 有状态存储 | [Durable Objects](https://developers.cloudflare.com/durable-objects/) |
| 构建 | [tsup](https://tsup.egoist.dev/) |
| CI/CD | [GitHub Actions](./.github/workflows/README.md) |

## 持续集成与发布

三个 GitHub Actions 工作流自动处理构建、测试、发布：

- **CI**（每次提交）：类型检查 + 集成测试 + Flutter 分析
- **Release NPM**（推 `v*` tag）：发布 `ephem-cli` 到 npm
- **Release Android**（推 `v*` tag）：构建 APK 并附到 GitHub Release

发版流程详见 [.github/workflows/README.md](./.github/workflows/README.md)。

## License

MIT

## Linux.do
[学ai，上L站！](https://linux.do/)