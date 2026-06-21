# Ephem 项目长期笔记

临时、端到端加密的命令行聊天室。后端 Cloudflare Workers + Durable Objects，CLI 用 Node + ink。

## 项目约定
- **包管理**：Windows 下 npm workspaces 符号链接会失败，两个包各自独立 `npm install`；根 package.json 用 `npm --prefix packages/xxx` 脚本串联。
- **Node 运行时**：用 22.22.2（managed）。
- **后端开发**：`npm run dev:backend` → wrangler dev，本地 :8787，改 src 自动热重载。
- **CLI 构建**：`npm run build:cli` → tsup 打包成单文件 `dist/index.js`（带 shebang）。

## 关键技术决策
- 房间码 = BIP39 三词；后端只存 SHA-256 哈希，DO name 即哈希。
- 加密：HKDF(SHA-256) 派生 AES-256-GCM 密钥，authTag 拼密文末尾。
- **workerder 坑**：DO 内 accept() 后立即发首条消息在并发连接时会丢，必须 `setTimeout(0)` 延迟到 Response 返回后再发。详见 2026-06-21 日志。
- Admin 鉴权：`X-Admin-Key` header 比对 `ADMIN_PASSWORD` 环境变量。

## 文件位置
- 实现文档：`ephem-implementation-guide.md`（项目根）
- 后端：`packages/backend-cloudflare/src/`（index.ts 路由 / RoomObject.ts DO / admin.ts API / roomCode.ts / wordlist.ts / rateLimit.ts）
- Admin 页面：`packages/backend-cloudflare/public/`
- CLI：`packages/cli/src/`（index.ts 入口 / ui/ ink组件 / crypto/ / ws/）
- 集成测试：`packages/cli/integration-test.mjs`（需后端运行，`NODE_PATH` 指向 cli/node_modules）
