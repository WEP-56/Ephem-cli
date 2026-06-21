# Ephem 实现文档

> 临时、端到端加密的命令行聊天室。后端零成本部署，CLI 包名 `ephem-cli`，命令名 `ephem`。

---

## 1. 项目概述

### 1.1 目标

- 提供一个轻量聊天室：创建房间 → 拿到房间码 → 双方各自在 CLI 里输入房间码即可对话。
- 后端完全跑在免费额度内（Cloudflare Workers / Vercel / Hugging Face Spaces 三选一）。
- 消息端到端加密，后端只转发密文，看不到聊天内容。
- 房间到期或人数耗尽后自动销毁，不留持久化记录。

### 1.2 非目标

- 不做用户账号体系、不做历史消息漫游、不做多房间持久化存储。
- 不做媒体文件传输（首版只做文本）。
- 不追求高并发，目标场景是 2 人或小群（≤ 8 人）短时通信。

### 1.3 核心体验流程

```
管理员侧:
  打开 admin 页面 → 创建房间(人数上限, 存活时长) → 拿到房间码

用户侧 (CLI):
  npx ephem-cli (或全局安装后 `ephem`)
    → 输入后端地址 (可预设默认值/环境变量跳过)
    → 输入房间码
    → 输入用户名
    → 进入 TUI 聊天界面
```

---

## 2. 整体架构

```
┌─────────────────┐        WSS (加密消息)        ┌──────────────────────┐
│   ephem CLI A    │ ───────────────────────────▶ │                       │
│  (Node + ink)    │ ◀─────────────────────────── │   后端 Relay 服务      │
└─────────────────┘                              │  (Cloudflare Worker   │
                                                  │   + Durable Object)   │
┌─────────────────┐        WSS (加密消息)        │                       │
│   ephem CLI B    │ ───────────────────────────▶ │  - 房间状态管理        │
│  (Node + ink)    │ ◀─────────────────────────── │  - 消息中转(密文)      │
└─────────────────┘                              │  - TTL/人数控制        │
                                                  └───────────┬───────────┘
                                                              │ HTTPS (REST)
                                                  ┌───────────▼───────────┐
                                                  │     Admin 页面         │
                                                  │  创建房间/设置参数      │
                                                  └────────────────────────┘
```

**关键设计原则**：后端只看到密文 + 房间元数据（人数、TTL、房间码哈希），看不到任何聊天内容。即使部署平台的运营方想审查，也无从下手。

---

## 3. 后端设计

### 3.1 技术选型对比

| 平台 | WebSocket 支持 | 有状态能力 | 免费额度 | 推荐度 |
|---|---|---|---|---|
| **Cloudflare Workers + Durable Objects** | 原生支持，长连接无压力 | Durable Object 自带存储 + alarm 定时器，房间状态天然契合 | 10万请求/天，DO 100万次调用/月 | ⭐⭐⭐⭐⭐ 首选 |
| Vercel | Serverless 函数不适合长连接 WebSocket（有执行时长限制） | 无原生有状态能力，需接 KV/Redis | Hobby 计划够用 | ⭐⭐ 仅适合做 Admin API，不适合做 WS relay |
| Hugging Face Spaces | 支持常驻进程，可以跑普通 Node/Python WS 服务 | 进程内内存即可，但 Space 可能因不活跃被休眠 | 免费 CPU Space | ⭐⭐⭐ 备选，适合不想用 Cloudflare 的场景 |

**结论**：主推 Cloudflare Workers + Durable Objects 一套方案做完整后端（WS relay + Admin API）。Vercel/HF Spaces 作为文档里提供的"备选部署目标"，用同一套核心逻辑改一层适配。

### 3.2 数据模型

每个房间对应一个 Durable Object 实例，实例内存（或其绑定的存储）保存：

```ts
interface RoomState {
  roomCode: string;          // 房间码，同时作为 DO 的 name
  roomCodeHash: string;      // 实际存储的是哈希，不存明文（即使后端被拖库也不暴露房间码）
  maxMembers: number;        // 人数上限
  createdAt: number;         // 创建时间戳
  expiresAt: number;         // 销毁时间戳 (createdAt + TTL)
  members: Map<string, {
    username: string;
    wsConnectionId: string;
    joinedAt: number;
  }>;
  // 注意：不存储任何消息内容，消息只做内存转发，不落盘
}
```

### 3.3 房间生命周期

1. **创建**：Admin 页面调用 `POST /api/rooms`，传入 `maxMembers`、`ttlSeconds`。后端生成房间码（见 3.5），创建对应 Durable Object，写入初始状态，设置一个 **alarm**（Cloudflare DO 的定时任务机制）在 `ttlSeconds` 后触发自毁。
2. **加入**：CLI 通过 WS 连接 `wss://<backend>/room/<roomCode>`，握手时校验房间码哈希、当前人数 < maxMembers、房间未过期。
3. **通信**：成员发送的消息（已经是客户端加密好的密文）原样广播给房间内其他成员，后端不解密、不留存。
4. **销毁**：满足以下任一条件即销毁（清空 DO 状态、断开所有连接、DO 自身可以保留壳但状态清零）：
   - 到达 `expiresAt`（alarm 触发）
   - 所有成员都断开连接超过一定宽限期（比如 5 分钟，避免误判网络抖动）
   - 管理员手动调用销毁 API

### 3.4 API 设计

**Admin REST API**（部署在 Worker 的 HTTP 路由上）：

```
POST /api/rooms
  body: { maxMembers: number, ttlSeconds: number }
  → { roomCode: string, expiresAt: number }

GET /api/rooms/:roomCode/status     # 仅返回人数/剩余时间等元信息，不返回内容
  → { currentMembers: number, maxMembers: number, expiresAt: number, alive: boolean }

DELETE /api/rooms/:roomCode          # 手动销毁
  → { success: true }
```

**CLI 用 WebSocket API**：

```
连接: wss://<backend>/room/:roomCode?username=<username>

服务端 → 客户端 消息类型:
  { type: "joined", payload: { username, currentMembers, maxMembers } }
  { type: "peer_joined", payload: { username } }
  { type: "peer_left", payload: { username } }
  { type: "message", payload: { from: username, ciphertext, nonce, timestamp } }
  { type: "room_closing", payload: { reason: "ttl_expired" | "manual" | "empty" } }
  { type: "error", payload: { code, message } }

客户端 → 服务端 消息类型:
  { type: "message", payload: { ciphertext, nonce } }
  { type: "ping" }  // 心跳
```

### 3.5 房间码设计

- 不用纯随机字符串（手敲容易出错），用类似 BIP39 词表的方案：从一个几千词的英文常用词词表中随机抽 3 个词组成，例如 `correct-horse-battery`。
- 房间码本身**同时承担"密钥种子"的职责**（见第 4 章），所以长度和随机性要足够：3 个词从 2048 词表中选，组合空间约 2048³ ≈ 85亿，对于"短时存活的临时房间"这个场景，足够防止暴力枚举（尤其配合后端限流和房间 TTL）。
- 后端只存房间码的哈希（如 SHA-256），不存明文，进一步降低后端被攻破后房间码泄露的风险。

---

## 4. 加密方案

### 4.1 设计目标

- 后端（包括部署平台运营方）任何时候看不到消息明文。
- 房间码本身就是双方唯一需要"线下"（口头/当面）同步的秘密，不依赖额外的密钥交换基础设施。
- 不需要做复杂的密钥分发，因为房间码已经是双方共享的秘密。

### 4.2 密钥派生

房间码 → 对称密钥，使用 **HKDF**（基于 SHA-256）从房间码派生出 AES-256-GCM 的密钥：

```
roomKey = HKDF(
  ikm = roomCode,                     // 输入密钥材料
  salt = "ephem-v1-room-salt",        // 固定 salt（也可以用房间创建时间戳增加变化性）
  info = "ephem-room-encryption-key",
  length = 32 bytes
)
```

> 这里采用的是"共享密码派生密钥"模式，类似 PAKE 的简化版（不追求抵抗在线字典攻击，因为攻击者必须先能连上某个具体房间码对应的 WS 端点才能验证猜测，而后端可以对单房间码的失败连接次数做限流）。如果要更严谨，可以后续升级成基于 SPAKE2 的真正 PAKE 协议，但对于"两个学生临时聊天"的场景，HKDF 派生 + 限流已经足够。

### 4.3 消息加密

每条消息用 AES-256-GCM 加密：

```
nonce = random(12 bytes)   // 每条消息独立随机 nonce
ciphertext, authTag = AES-256-GCM-Encrypt(roomKey, nonce, plaintext)
```

客户端发送 `{ ciphertext, nonce }`（authTag 可以拼在 ciphertext 末尾，标准做法），后端原样转发，接收方用同样的 `roomKey` + 收到的 `nonce` 解密。

### 4.4 前向保密的取舍

首版不做每条消息轮换密钥（即不做完整的双棘轮协议如 Signal Protocol），因为：

- 房间本身生命周期就短（分钟到几小时级别），泄露窗口本身有限。
- 实现复杂度对这个场景不成比例。

如果未来想加强，可以在 v2 引入简化棘轮：每条消息后用 HKDF 把 `roomKey` 向前推进一次（`roomKey_n+1 = HKDF(roomKey_n, ...)`），实现单向前向保密（旧密钥泄露不影响后续消息，但不能反向推导历史密钥）。文档先在此留一个扩展点。

### 4.5 客户端侧实现要点

- 加密/解密逻辑用 Node 内置 `crypto` 模块（`crypto.subtle` 或 `crypto.createCipheriv`），不需要额外依赖。
- **房间码绝不通过网络以明文发送给后端用于密钥用途**——后端拿到的房间码只用于路由（找到对应 Durable Object）和做哈希校验，真正的加密密钥派生全程在客户端本地完成。

---

## 5. CLI 工具设计 (`ephem-cli`)

### 5.1 技术选型

- 运行时：Node.js（≥ 18，用原生 `fetch` 和 `crypto`）
- TUI 框架：[`ink`](https://github.com/vadimdemedes/ink)（React 范式写 CLI 界面，组件化、好维护，社区成熟）
- WebSocket 客户端：`ws` 库
- CLI 参数解析：`commander` 或 `yargs`（用于支持 `--server`、`--room` 等可选的非交互式参数，方便脚本化/跳过交互）

### 5.2 交互流程

```
$ npx ephem-cli
┌─────────────────────────────────┐
│  Ephem · 临时加密聊天室            │
└─────────────────────────────────┘

? 后端地址: (回车使用默认值，或读取 EPHEM_SERVER 环境变量)
  > wss://your-worker.workers.dev

? 房间码:
  > correct-horse-battery

? 用户名:
  > taoran

  正在连接...
  ✓ 已加入房间 (2/2 人)

┌─ correct-horse-battery ─────────────────────┐
│ taoran 加入了房间                             │
│ 小弟: 在吗                                    │
│ taoran: 在的                                  │
│                                              │
├──────────────────────────────────────────────┤
│ > 输入消息...                                  │
└──────────────────────────────────────────────┘
  Ctrl+C 退出 · 房间将在 02:14:33 后销毁
```

### 5.3 命令行参数（跳过交互的快捷方式）

```bash
ephem --server wss://your-worker.workers.dev --room correct-horse-battery --username taoran
ephem connect   # 等价于不带参数，走完整交互式问答
```

环境变量支持，方便固定后端地址后不用每次输入：

```bash
export EPHEM_SERVER=wss://your-worker.workers.dev
ephem  # 自动跳过"后端地址"这一步
```

### 5.4 TUI 组件拆解（ink 组件树）

```
<App>
  ├─ <SetupWizard>          // 三步问答：地址/房间码/用户名，未完成连接前显示
  │   ├─ <ServerInput />
  │   ├─ <RoomCodeInput />
  │   └─ <UsernameInput />
  └─ <ChatRoom>              // 连接成功后渲染
      ├─ <Header />          // 房间码、人数、倒计时
      ├─ <MessageList />     // 滚动消息列表
      ├─ <SystemNotice />    // "xxx 加入了房间" 之类的系统提示
      └─ <InputBar />        // 底部输入框
```

### 5.5 关键边界处理

- **断线重连**：WS 断开后自动重试（指数退避），重连成功后用同一房间码 + 用户名重新握手。
- **房间销毁提醒**：收到 `room_closing` 后，TUI 顶部用倒计时/提示告知用户，给个几秒钟的"即将断开"窗口而不是直接闪退。
- **人数已满 / 房间码错误 / 房间已过期**：在 Setup 阶段给出清晰的错误提示并允许重新输入，不要直接崩溃退出。

---

## 6. Admin 页面设计

简单的单页 Web 应用即可，跟后端同源部署（Cloudflare Worker 直接 serve 静态资源，或者用 Cloudflare Pages 单独挂一个静态站指向同一个 Worker API）。

### 6.1 页面功能

- 表单：人数上限（默认 2，可调）、存活时长（下拉：15分钟 / 1小时 / 6小时 / 24小时，或自定义）
- 提交后展示房间码（大字体，方便截图/口头转告）+ 二维码（可选，扫码直接带参数打开，但考虑到目标用户是 CLI 使用场景，二维码优先级不高）
- 房间列表（如果要支持管理员同时管理多个房间）：显示房间码、当前人数/上限、剩余存活时间、手动销毁按钮

### 6.2 鉴权

最简方案：Admin 页面本身设置一个固定的访问密码（环境变量 `ADMIN_PASSWORD`），所有 `/api/rooms` 的写操作（创建/销毁）都要带这个密码（Header 里传，比如 `X-Admin-Key`）。不需要做完整的用户账号系统。

---

## 7. 项目目录结构

```
ephem/
├── packages/
│   ├── cli/                      # 发布到 npm 的 ephem-cli 包
│   │   ├── src/
│   │   │   ├── index.ts          # 入口，解析参数，决定走交互式或直连
│   │   │   ├── ui/
│   │   │   │   ├── App.tsx
│   │   │   │   ├── SetupWizard.tsx
│   │   │   │   └── ChatRoom.tsx
│   │   │   ├── crypto/
│   │   │   │   ├── deriveKey.ts  # HKDF 房间码 → 密钥
│   │   │   │   └── cipher.ts     # AES-256-GCM 加解密封装
│   │   │   └── ws/
│   │   │       └── client.ts     # WS 连接 + 重连逻辑
│   │   ├── package.json          # name: "ephem-cli", bin: { "ephem": "./dist/index.js" }
│   │   └── tsconfig.json
│   │
│   ├── backend-cloudflare/        # Cloudflare Worker + Durable Object
│   │   ├── src/
│   │   │   ├── index.ts          # Worker 入口，路由分发
│   │   │   ├── RoomObject.ts     # Durable Object 类，房间状态/WS 处理/alarm
│   │   │   └── admin.ts          # Admin REST API handler
│   │   └── wrangler.toml
│   │
│   ├── backend-hf-space/          # Hugging Face Spaces 备选部署（Node + ws）
│   │   ├── server.js
│   │   └── Dockerfile
│   │
│   └── admin-web/                 # Admin 静态页面
│       ├── index.html
│       └── app.js
│
├── docs/
│   └── ephem-implementation-guide.md   # 本文档
└── README.md
```

---

## 8. 部署指南

### 8.1 Cloudflare Workers（主方案）

```bash
cd packages/backend-cloudflare
npm install
npx wrangler login
npx wrangler deploy
```

`wrangler.toml` 关键配置：

```toml
name = "ephem-backend"
main = "src/index.ts"
compatibility_date = "2026-01-01"

[[durable_objects.bindings]]
name = "ROOM"
class_name = "RoomObject"

[[migrations]]
tag = "v1"
new_classes = ["RoomObject"]
```

部署成功后会拿到形如 `https://ephem-backend.<your-subdomain>.workers.dev` 的地址，WebSocket 用 `wss://` 替换协议头即可。

### 8.2 Hugging Face Spaces（备选）

- 新建一个 Space，SDK 选 Docker。
- `Dockerfile` 跑一个最简单的 Node + `ws` 常驻服务，房间状态存内存 Map（单实例够用，HF 免费 Space 本身也只给单实例）。
- 注意：免费 Space 不活跃一段时间会休眠，重新唤醒有延迟，且唤醒会清空内存状态（房间全部丢失）。这点要在 README 里提前告知用户，建议作为"备选"而非主推方案。

### 8.3 Vercel（仅 Admin API，不建议跑 WS）

如果偏好 Vercel 生态，可以把 Admin 的 REST API 部署成 Vercel Serverless Function，房间状态存 Vercel KV 或 Upstash Redis（都有免费额度）。但 WS relay 部分仍建议用 Cloudflare，两者可以混搭（Admin 用 Vercel，WS relay 用 Cloudflare Worker）。

---

## 9. 实现优先级建议

按这个顺序实现，每一步都能跑出可演示的东西：

1. **最小后端**：Cloudflare Worker + 一个 Durable Object，只支持创建房间、WS 连接、明文广播消息（先不加密，验证链路通）。
2. **CLI 最小版**：用 `readline` 写一个最简单的命令行问答 + 收发消息（不做 TUI），验证端到端链路。
3. **加入加密层**：客户端实现 HKDF 派生 + AES-256-GCM，后端改造成只转发密文。
4. **TUI 升级**：把 CLI 从 `readline` 换成 `ink` 组件化界面。
5. **房间生命周期完善**：TTL 自毁（alarm）、人数上限校验、断线重连、房间码哈希校验。
6. **Admin 页面**：创建房间表单 + 房间列表 + 手动销毁。
7. **打磨**：错误提示、心跳保活、`npm publish` 发布 `ephem-cli`。

---

## 10. 安全考量清单

- [ ] 房间码只存哈希，不存明文
- [ ] 消息全程端到端加密，后端只转发密文
- [ ] 加密密钥派生全程在客户端本地完成，房间码不作为"密钥用途"通过网络传输给后端
- [ ] 房间到期/人数耗尽/手动销毁后，Durable Object 状态彻底清空（不留内存残留）
- [ ] 对单房间码的连接尝试做限流（防止暴力枚举房间码）
- [ ] Admin API 鉴权（固定密码/Header Key），避免任何人都能创建/销毁房间
- [ ] WS 连接走 `wss://`（TLS），避免明文密文之外的元数据（如房间码本身）被中间人窥探
- [ ] CLI 不在任何日志/历史文件里留存房间码或消息明文（注意 shell history 如果用命令行参数传房间码会被记录到 `~/.bash_history`，文档里应提醒用户优先用交互式输入而非命令行参数传房间码）

---

## 11. 后续可扩展方向（非首版范围）

- 完整 PAKE（如 SPAKE2）替代 HKDF 派生方案，进一步提升抗暴力破解能力
- 双棘轮机制实现真正的前向保密
- 多设备支持（同一用户名在多端同步，目前设计是单连接单用户名）
- 文件/图片传输（加密后分块传输）
- 房间内消息已读状态、输入中提示等社交细节
- fultter移动端制作