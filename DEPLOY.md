# Ephem 后端部署指南

> 两种方式把 Ephem 后端部署到 Cloudflare，任选其一。
>
> - **方式 A（推荐）**：Wrangler 命令行一键部署——最快，适合开发者
> - **方式 B**：Cloudflare 控制台手动部署——不装任何工具，适合纯网页操作

部署完成后你会得到一个 `https://ephem-backend.<你的子域>.workers.dev` 地址，
CLI 和 Android 客户端填这个地址即可连接。

---

## 前置条件

- 一个 [Cloudflare 账号](https://dash.cloudflare.com/sign-up)（**免费**，注册不需要信用卡）
- 免费额度对本项目绰绰有余：10 万次请求/天 + 100 万次 DO 调用/月

---

## 方式 A：Wrangler 命令行部署（推荐）

### 第 1 步：安装 Wrangler

```bash
# 方式一：全局安装（推荐）
npm install -g wrangler

# 方式二：用项目自带的（已包含在 devDependencies）
cd packages/backend-cloudflare
npx wrangler --version
```

确认能跑：`wrangler x.x.x`。

### 第 2 步：登录 Cloudflare

```bash
wrangler login
```

浏览器会自动打开授权页面，点 "Allow" 即可。终端显示：

```
✅  Successfully logged into your Cloudflare account!
```

> **Windows 如果浏览器没自动打开**：终端会打印一个链接，复制到浏览器手动完成授权。

### 第 3 步：本地测试（可选但推荐）

```bash
cd packages/backend-cloudflare
wrangler dev
```

看到 `Ready on http://127.0.0.1:8787` 就说明能跑。此时：
- 浏览器开 `http://127.0.0.1:8787` → Admin 页面（密码随便输一个，本地 dev 不校验）
- 另开终端 `node packages/cli/dist/index.js --server ws://127.0.0.1:8787` 测试连接

`Ctrl+C` 停止。

### 第 4 步：设置管理员密码（Secret）

生产环境**必须**设置密码，用 `secret` 命令加密存储：

```bash
cd packages/backend-cloudflare
wrangler secret put ADMIN_PASSWORD
```

它会提示输入值。输入一个强密码（你自己记住，用于 Admin 页面和 API 鉴权）：

```
? Enter a secret value: ********************************
```

> 这个值加密存在 Cloudflare Secrets 里，代码通过 `env.ADMIN_PASSWORD` 读取，
> **不会出现在源码、wrangler.toml 或日志中**。
>
> ⚠️ **不要**在 `wrangler.toml` 的 `[vars]` 里写密码——明文 vars 会覆盖 secret！

### 第 5 步：部署

```bash
cd packages/backend-cloudflare
wrangler deploy
```

几十秒后看到：

```
 Published ephem-backend (x.xx)
  https://ephem-backend.<你的子域>.workers.dev
  Duration: Xms
```

**记下这个 URL！** 这就是你的后端地址。

### 第 6 步：验证

```bash
# 1. 浏览器打开 URL → 应该看到 Admin 页面
# 2. 命令行测试 API
curl -X POST https://ephem-backend.<子域>.workers.dev/api/rooms \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: 你刚才设置的密码" \
  -d '{"maxMembers":2,"ttlSeconds":3600}'

# 返回：{"roomCode":"correct-horse-battery","expiresAt":...}

# 3. 用 CLI 连接
ephem --server wss://ephem-backend.<子域>.workers.dev \
      --room correct-horse-battery \
      --username alice
```

两个终端各用一个用户名，就能聊天了！

### ✅ 方式 A 完成

---

## 方式 B：Cloudflare 控制台手动部署

> 适合不想装 Node/Wrangler 的用户，全程在浏览器里操作。
>
> **限制**：手动部署需要先在本地把 TypeScript 编译成单文件 JS。
> 如果完全不想装任何工具，请找人帮你跑一次 `npm run build` 产出 `dist/worker.js`，
> 或者直接用方式 A。

### 第 1 步：构建 Worker 脚本

Wrangler 部署时会自动编译 TypeScript，但控制台只接受单个 JS 文件。
所以需要先在本地构建：

```bash
cd packages/backend-cloudflare
npm install
npx wrangler deploy --dry-run --outdir dist-build
```

这会在 `dist-build/` 下生成编译好的 `index.js`（单文件，包含所有代码）。

> 如果本地没装 Node，找一台装了的机器跑这一步，把产出的 `index.js` 复制出来即可。

### 第 2 步：进入 Cloudflare 控制台

1. 打开 [dash.cloudflare.com](https://dash.cloudflare.com)
2. 登录你的账号
3. 左侧菜单点 **Workers & Pages**

### 第 3 步：创建 Worker

1. 点 **Create application**
2. 点 **Create Worker**
3. 给 Worker 起个名字，比如 `ephem-backend`
4. 点 **Deploy**

此时会生成一个 `ephem-backend.<你的子域>.workers.dev` 地址，但代码还是默认的 Hello World 模板。

### 第 4 步：粘贴代码

1. 刚部署完的页面点 **Edit code**（编辑代码）
2. 把左侧编辑器里的默认内容**全部删除**
3. 打开你第 1 步构建出的 `dist-build/index.js`，**全选复制**
4. 粘贴到编辑器里
5. 右上角点 **Deploy**

### 第 5 步：创建 Durable Object 命名空间

Ephem 后端依赖 Durable Objects 存储房间状态，必须手动创建绑定：

1. 回到 Worker 详情页（不是编辑器，是 overview）
2. 点 **Settings** 标签
3. 找到 **Bindings** 区域，点 **Add binding**
4. 选 **Durable Object namespace**
5. 操作：
   - **Variable name**：填 `ROOM`（必须和代码里一致）
   - **Durable object namespace**：点 **Create new namespace**，名字填 `ROOM_STORE`
   - 点 **Deploy** 保存

### 第 6 步：设置管理员密码

1. 仍在 **Settings** 标签
2. 找到 **Variables and Secrets** 区域
3. 点 **Add variable**
4. 操作：
   - **Variable name**：填 `ADMIN_PASSWORD`
   - **Value**：输入你的管理员密码
   - **Type**：选 **Secret**（加密存储，不是明文 Plaintext）
   - 点 **Deploy** 保存

> ⚠️ 密码一定要选 **Secret** 类型，不要选 **Plaintext**——Plaintext 会在仪表盘里明文可见。

### 第 7 步：上传 Admin 静态页面（可选）

Ephem 后端自带一个 Admin 管理页面（`packages/backend-cloudflare/public/`）。
Wrangler 部署会自动托管，但控制台手动部署需要额外操作：

**如果不需要 Admin 网页**（只用 CLI 和 API）：跳过这步，后端 API 照常工作。

**如果需要 Admin 网页**：
1. 把 `packages/backend-cloudflare/public/` 里的 `index.html` 和 `app.js` 内容记下来
2. 控制台不支持直接托管静态资源到 Worker——这种情况**强烈建议改用方式 A（Wrangler 部署）**

### 第 8 步：验证

同方式 A 的第 6 步——浏览器开 URL、curl 测 API、CLI 连接测试。

### ✅ 方式 B 完成

---

## 后续管理

### 更新部署

**方式 A（Wrangler）**：改了代码后重新 deploy 即可
```bash
cd packages/backend-cloudflare
wrangler deploy
```

**方式 B（控制台）**：重新构建 `index.js` → Worker 详情页 → Edit code → 粘贴新代码 → Deploy

### 查看实时日志

```bash
wrangler tail                    # 实时请求日志
wrangler tail --format json      # JSON 格式，方便过滤
wrangler tail --status error     # 只看错误
```

> 控制台用户：Worker 详情页 → **Logs** 标签 → **Begin log stream**

### 修改管理员密码

```bash
wrangler secret put ADMIN_PASSWORD    # 重新输入新值，立即生效
```

> 控制台用户：Settings → Variables and Secrets → 编辑 `ADMIN_PASSWORD` → Deploy

### 查看用量

[Cloudflare Dashboard](https://dash.cloudflare.com) → Workers & Pages → 你的 Worker → **Analytics**

---

## 自定义域名（可选）

如果你有域名且托管在 Cloudflare：

### 方式 A：改 wrangler.toml

```toml
routes = [
  { pattern = "chat.yourdomain.com/*", zone_name = "yourdomain.com" }
]
```

然后 `wrangler deploy`，Cloudflare 自动配好 DNS + SSL。
地址变成 `wss://chat.yourdomain.com`。

### 方式 B：控制台

Worker 详情页 → **Settings** → **Triggers** → **Custom Domains** → 添加域名。
Cloudflare 会自动加 DNS 记录和 SSL 证书。

---

## 常见问题

**Q: `wrangler login` 报错 / 浏览器打不开？**
A: 确保 Node.js ≥ 18。代理问题就设 `HTTPS_PROXY` 环境变量或关代理重试。

**Q: 部署后访问返回 403 Forbidden？**
A: `ADMIN_PASSWORD` secret 没设，或设成了 Plaintext 而非 Secret。重新用 `wrangler secret put` 设置。

**Q: 控制台部署后 WebSocket 连不上？**
A: 检查 Durable Object 绑定的 Variable name 是否严格是 `ROOM`（大写）。bindings 区分大小写。

**Q: 免费额度够用吗？**
A: 够。2 人聊 1 小时大约几百次请求，远低于 10 万/天。Durable Object 100 万次/月也基本用不完。

**Q: 怎么换管理员密码？**
A: `wrangler secret put ADMIN_PASSWORD` 再输一次新值，立即生效，不用重新部署。

**Q: 部署后怎么改房间 TTL / 人数上限？**
A: 这些参数在创建房间时通过 API 传（`ttlSeconds`、`maxMembers`），不是后端全局配置。Admin 页面建房时可以填。
