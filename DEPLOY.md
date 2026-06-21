# Cloudflare Workers 部署指南

> 从零把 Ephem 后端部署到 Cloudflare，让任何人都能用你的服务。

## 前置条件

- 一个 [Cloudflare 账号](https://dash.cloudflare.com/sign-up)（免费）
- Node.js ≥ 18
- 已克隆本项目

## 第一步：安装 Wrangler

Wrangler 是 Cloudflare 官方的 CLI 工具，用来本地开发和一键部署 Worker。

```bash
# 全局安装（推荐）
npm install -g wrangler

# 或者只在项目里用（已包含在 devDependencies）
cd packages/backend-cloudflare
npx wrangler --version   # 确认能跑
```

## 第二步：登录 Cloudflare

```bash
wrangler login
```

这会自动打开浏览器，让你授权登录。授权成功后终端会显示：

```
✅  Successfully logged into your Cloudflare account!
```

> **Windows 注意**：如果浏览器没自动打开，终端会给你一个手动访问的链接。复制到浏览器完成授权即可。

## 第三步：配置管理员密码

生产环境**不要**使用默认密码。用 `secret` 命令安全地设置：

```bash
cd packages/backend-cloudflare
wrangler secret put ADMIN_PASSWORD
```

它会提示你输入一个新值。这个值会加密存储在 Cloudflare 的 Secrets 里，
代码里通过 `env.ADMIN_PASSWORD` 读取，**不会出现在源码或日志中**。

```bash
# 示例：设置一个强密码
# 输入后回车确认
my-super-secret-admin-password-2024
```

## 第四步：本地测试（可选但推荐）

先在本地跑一遍确保没问题：

```bash
cd packages/backend-cloudflare
wrangler dev
```

你会看到类似输出：

```
⛅️ wrangler x.x.x
Your worker has access to the following bindings:
- Durable Objects: ROOM (RoomObject)
- Vars: ADMIN_PASSWORD: ***

⎔ Starting local server...
[wrangler] Ready on http://127.0.0.1:8787
```

此时：
- 打开 `http://127.0.0.1:8787` → Admin 页面（输入刚才设置的密码）
- 另开终端运行 `ephem --server ws://127.0.0.1:8787` 测试连接

`Ctrl+C` 停止本地服务器。

## 第五步：一键部署

```bash
cd packages/backend-cloudflare
wrangler deploy
```

等待几十秒，看到类似输出就是成功了：

```
 Published ephem-backend (x.x)
  https://ephem-backend.<你的子域>.workers.dev
  [Date] Deployment created!
```

记下这个 URL！这就是你的 **后端地址**。

## 第六步：验证部署

### 验证 Admin 页面

浏览器打开 `https://ephem-backend.<你的子域>.workers.dev/`

你应该能看到 Admin 页面。输入你设置的密码，创建一个房间试试。

### 验证 API

```bash
# 创建房间（替换成你的地址）
curl -X POST https://ephem-backend.<子域>.workers.dev/api/rooms \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: 你设置的密码" \
  -d '{"maxMembers":2,"ttlSeconds":3600}'

# 返回示例：{"roomCode":"correct-horse-battery","expiresAt":...}
```

### 用 CLI 连接

```bash
ephem --server wss://ephem-backend.<子域>.workers.dev --room <房间码> --username test
```

开两个终端，各用一个用户名，就能聊天了！

## 后续管理

### 更新部署

每次改了 `src/` 下的代码或 `public/` 下的页面：

```bash
cd packages/backend-cloudflare
wrangler deploy    # 自动增量部署
```

### 查看日志

```bash
wrangler tail      # 实时查看请求日志（像 docker logs）
wrangler tail --format json  # JSON 格式，方便过滤
```

### 查看用量

登录 [Cloudflare Dashboard](https://dash.cloudflare.com) → Workers & Pages → 你的 Worker → Analytics

免费额度：
- 请求数：10 万次/天
- DO 调用：100 万次/月
- 对于 2~8 人临时聊天场景绰绰有余

## 自定义域名（可选）

如果你有自己的域名且托管在 Cloudflare：

```toml
# 在 wrangler.toml 里加一行：
routes = [
  { pattern = "chat.yourdomain.com/*", zone_name = "yourdomain.com" }
]
```

然后 `wrangler deploy`，Cloudflare 会自动帮你配好 DNS 和 SSL。

这样你的地址就变成 `wss://chat.yourdomain.com`，比 workers.dev 更好看。

---

## 常见问题

**Q: `wrangler login` 报错？**
A: 确保 Node.js ≥ 18。如果代理问题导致网络不通，设置 `HTTPS_PROXY` 或关掉代理再试。

**Q: 部署后 403 Forbidden？**
A: 可能是 `ADMIN_PASSWORD` secret 没设。重新执行 `wrangler secret put ADMIN_PASSWORD`。

**Q: 怎么换管理员密码？**
A: 再执行一次 `wrangler secret put ADMIN_PASSWORD` 输入新密码即可，立即生效无需重新部署。

**Q: 免费额度够用吗？**
A: 够的。每个房间大约消耗：建房(1次) + 加入(N次) + 消息(M次) + 心跳(每25秒1次)。2 人聊 1 小时大概几百次请求，远低于 10 万/天。
