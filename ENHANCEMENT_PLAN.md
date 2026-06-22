# Ephem 强化更新设计文档

本文档记录下一阶段强化更新的实现规格与落地顺序，覆盖 Web 聊天端、图片发送协议、Flutter Windows/macOS 桌面端支持与 TUI 美化。目标是在保持 Ephem 当前核心安全模型的前提下扩展体验：

- 后端仍然只转发密文，不解密、不存储消息明文。
- 房间码仍然是用户加入房间与本地派生密钥的唯一共享秘密。
- 文本、图片、未来附件统一走同一条端到端加密消息通道。

## 1. Web 聊天端

### 1.1 路由

新增 Web 聊天页面：

```text
https://<后端地址>/chat
```

Admin 页面继续保留在：

```text
https://<后端地址>/
```

WebSocket 协议不变，Web 端加入房间后连接：

```text
wss://<后端地址>/room/:roomCode?username=:username
```

### 1.2 认证与加入方式

Web 聊天端不使用 Admin 密码，不创建账号。认证方式与 CLI/Flutter 相同：

1. 用户打开 `/chat`。
2. 输入后端地址当前页面已隐含，不需要再填。
3. 输入房间码。
4. 输入用户名，留空则使用 `匿名`。
5. 前端用房间码本地派生 AES-256-GCM 密钥。
6. 建立 WebSocket 连接。
7. 收到 `joined` 后进入聊天界面。

房间码不得写入 localStorage、sessionStorage、IndexedDB 或日志。用户名可以选择记住，但默认不记住房间码。

### 1.3 Web 端技术约束

Web 端需要使用浏览器原生能力，避免引入大型构建链：

- 加密：Web Crypto API。
- WebSocket：浏览器原生 `WebSocket`。
- 文件选择：`<input type="file" accept="image/*">`。
- 静态资源：继续由 Cloudflare Workers `[assets]` 托管。

首版可以是无构建的静态页面：

```text
packages/backend-cloudflare/public/chat.html
packages/backend-cloudflare/public/chat.js
packages/backend-cloudflare/public/chat.css
```

Worker 路由需要确保 `/chat` 返回聊天页面。可以通过新增 `chat.html` 并在 Worker 里对 `/chat` 做静态跳转/兜底，也可以让 assets 直接托管 `/chat.html` 后再由 `/chat` 重写。

### 1.4 Web 端功能清单

首版必须具备：

- 输入房间码和用户名。
- 加入房间。
- 文本收发。
- 图片收发。
- 显示系统事件：加入、离开、房间关闭、无法解密。
- 显示房间人数和 TTL 倒计时。
- 断线提示与异常断线重连。
- 移动端浏览器可用，输入栏不被软键盘遮挡。

首版不做：

- Admin 创建房间入口内嵌到聊天页。
- 消息历史持久化。
- 账号体系。
- 服务端保存图片。

## 2. 图片发送协议

### 2.1 设计原则

图片必须保持端到端加密。后端只看到：

```json
{
  "type": "message",
  "payload": {
    "ciphertext": "<base64>",
    "nonce": "<base64>"
  }
}
```

后端不新增图片专用明文字段，不解析 MIME、不存储文件。图片消息的类型、文件名、尺寸、缩略图、图片数据都必须放在加密明文里。

### 2.2 加密明文格式

现有文本消息明文是普通字符串。为了兼容旧客户端，新客户端采用“结构化消息优先，纯文本兜底”的解析策略。

新客户端发送文本时，加密以下 JSON：

```json
{
  "v": 1,
  "kind": "text",
  "text": "你好"
}
```

新客户端发送图片时，加密以下 JSON：

```json
{
  "v": 1,
  "kind": "image",
  "mime": "image/jpeg",
  "name": "photo.jpg",
  "size": 123456,
  "width": 1280,
  "height": 720,
  "data": "<base64 image bytes>",
  "thumb": {
    "mime": "image/jpeg",
    "width": 320,
    "height": 180,
    "data": "<base64 thumbnail bytes>"
  }
}
```

字段说明：

| 字段 | 必填 | 说明 |
|------|------|------|
| `v` | 是 | 结构化消息版本，首版为 `1` |
| `kind` | 是 | `text` 或 `image` |
| `mime` | 图片必填 | 允许 `image/jpeg`、`image/png`、`image/webp`、`image/gif` |
| `name` | 否 | 原始文件名，展示用，不可信 |
| `size` | 图片必填 | 原始图片字节数 |
| `width` / `height` | 建议 | 图片像素尺寸，用于预留布局 |
| `data` | 图片必填 | 原始图片字节 base64 |
| `thumb` | 建议 | 缩略图，优先用于聊天气泡预览 |

接收端解密后：

1. 尝试 `JSON.parse(plaintext)`。
2. 若是 `{ v: 1, kind: "text" }`，按文本消息展示。
3. 若是 `{ v: 1, kind: "image" }`，按图片消息展示。
4. 若解析失败，按旧版纯文本展示。

这样旧 CLI 仍会显示 JSON 字符串，新客户端之间可以显示富消息。后续如果需要避免旧客户端显示 JSON，可以通过协议版本协商解决，但首版不引入协商复杂度。

### 2.3 大小限制

首版图片采用加密内联传输，不引入对象存储。限制必须保守：

- 原图上限：`1 MiB`。
- 发送前压缩长边到不超过 `1600 px`。
- 缩略图长边不超过 `360 px`。
- 单条加密后 WebSocket 文本帧建议不超过 `1.5 MiB`。

超过限制时客户端应提示用户压缩失败或文件过大，不发送。

原因：

- Cloudflare Workers 和浏览器 WebSocket 都不适合承载超大单帧。
- base64 会增加约 33% 体积。
- AES-GCM 还会附加 16 字节 auth tag，JSON 也有少量开销。

### 2.4 MIME 与安全校验

发送端：

- 只允许图片 MIME：`image/jpeg`、`image/png`、`image/webp`、`image/gif`。
- 读取文件头或浏览器/平台提供的 MIME 作为参考，但不要只信文件扩展名。
- 默认重新编码 JPEG/WebP 以压缩体积。PNG 可在过大时提示或转 JPEG/WebP。

接收端：

- 不执行图片中携带的任何脚本或 HTML。
- Web 端用 `Blob` + `URL.createObjectURL` 渲染，不把不可信内容写入 `innerHTML`。
- Flutter 端用内存字节渲染，不落盘。
- CLI/TUI 端首版只显示图片消息摘要，例如：`[图片 photo.jpg · 384 KB]`，后续可支持保存或终端图片协议。

### 2.5 未来升级：分块与 R2

如果需要发送大图或文件，后续引入 v2 附件协议：

- 客户端本地生成随机附件密钥。
- 图片用附件密钥加密成 blob。
- blob 上传到 R2 或临时对象存储。
- 聊天消息只加密传输附件元数据和下载 URL。
- 对象 TTL 与房间 TTL 绑定。

首版不做这条路径，避免引入存储、清理、配额和泄漏面。

## 3. Flutter Windows/macOS 桌面端支持

### 3.1 目标平台

Flutter 端当前阶段从 Android-only 扩展到：

- Android APK。
- Windows。
- macOS。

仓库应纳入对应平台目录：

```text
packages/flutter_app/android/
packages/flutter_app/windows/
packages/flutter_app/macos/
```

本地设备 Flutter 环境不稳定，因此构建与打包主要依赖 GitHub Actions。开发时本地只要求能跑 Dart 分析和单元测试；真实产物由 CI 生成后下载测试。

### 3.2 基线修复

当前 Flutter 测试缺少 `flutter_test` 依赖。需要先修复：

```yaml
dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: ^3.0.0
```

CI 中 `flutter analyze` 当前 `continue-on-error: true`。桌面端改造完成后，应改为硬门禁：

```yaml
continue-on-error: false
```

### 3.3 平台生成策略

使用 Flutter 官方脚手架生成缺失平台：

```bash
cd packages/flutter_app
flutter create . --platforms=windows,macos
```

注意：

- 不应覆盖已定制的 Android Manifest，尤其是 `INTERNET` 权限。
- 生成后检查 `.metadata`、平台包名、应用名、图标、权限。
- macOS 需要确认网络 client entitlement 和用户选择文件读取权限。生产建议只允许 `wss://`；开发可临时允许 `ws://localhost`。

### 3.4 跨平台依赖检查

当前依赖：

| 依赖 | 用途 | 全平台风险 |
|------|------|------------|
| `web_socket_channel` | WS 通信 | Web/桌面可用，但握手错误细节各平台不同 |
| `cryptography` | HKDF + AES-GCM | 纯 Dart，适合全平台 |
| `shared_preferences` | 设置持久化 | 支持主流平台，需要确认 Web/桌面插件注册 |
| `url_launcher` | 打开 Admin 页面 | 支持主流平台，版本较旧 |

新增图片功能建议依赖：

| 依赖 | 用途 |
|------|------|
| `file_picker` | 桌面/移动选择图片 |
| `image` | 纯 Dart 图片解码、缩放、压缩 |
| 可选 `mime` | MIME/扩展名辅助判断 |

避免依赖只支持 Android/iOS 的图片压缩插件，否则会破坏桌面端目标。

### 3.5 UI 适配要求

Flutter UI 需要按窗口宽度分层：

- 手机窄屏：单列聊天布局。
- 平板/桌面宽屏：居中聊天面板，最大宽度约 `920 px`。
- Web/桌面：输入框支持 Enter 发送，Shift+Enter 换行。
- 图片气泡：预留宽高，避免图片加载后布局跳动。
- 设置页：宽屏下不要把表单拉满整屏。

### 3.6 GitHub Actions 打包

CI 分两类：

1. Pull Request / push 到 main：
   - `flutter pub get`
   - `flutter analyze`
   - `flutter test`
   - `flutter build web --release`

2. tag 或手动 release：
   - Android split APK。
   - Windows zip。
   - macOS artifact。

建议 workflow 矩阵：

| Job | Runner | 命令 |
|-----|--------|------|
| `flutter-check` | `ubuntu-latest` | analyze/test |
| `build-android` | `ubuntu-latest` | `flutter build apk --release --split-per-abi` |
| `build-windows` | `windows-latest` | `flutter build windows --release` |
| `build-macos` | `macos-latest` | `flutter build macos --release` |

## 4. TUI 美化

### 4.1 当前问题

CLI 当前可用，但界面偏基础：

- 消息区只是按终端高度截断，没有边框和视觉层级。
- 系统消息、自己消息、他人消息区分较弱。
- 长文本没有明确换行策略。
- 断线重连状态没有持续展示。
- SetupWizard 只是步骤列表，缺少输入校验和连接预检反馈。
- 图片消息首版只能显示文本摘要，需要设计专门样式。

### 4.2 美化目标

保持命令行轻量，不引入过重交互。重点提升可读性：

- 顶部状态栏：房间码、人数、连接状态、TTL。
- 中间消息面板：边框、时间、发送者、消息内容。
- 底部输入栏：固定高度，提示当前模式。
- 系统事件：居中或弱化显示。
- 错误/重连：醒目但不刷屏。
- 小终端兼容：高度不足时退化为紧凑模式。

### 4.3 建议组件拆分

当前 `ChatRoom.tsx` 可以拆为：

```text
src/ui/
  ChatRoom.tsx
  components/
    HeaderBar.tsx
    MessageList.tsx
    MessageLine.tsx
    InputBar.tsx
    StatusNotice.tsx
```

消息模型扩展为：

```ts
type ChatLine =
  | { kind: "system"; id: number; text: string; level?: "info" | "warn" | "error" }
  | { kind: "text"; id: number; from: string; text: string; self: boolean; time: string }
  | { kind: "image"; id: number; from: string; name?: string; size: number; self: boolean; time: string };
```

### 4.4 图片消息在 TUI 的首版表现

终端首版不直接渲染图片，只展示摘要：

```text
12:30 alice  [图片 photo.jpg · 384 KB · image/jpeg]
```

后续增强可选：

- 支持 iTerm2 / Kitty / WezTerm 图片协议。
- 支持保存图片到用户指定路径。
- 支持打开系统默认图片查看器。

首版不自动落盘，避免破坏“临时、不留记录”的产品定位。

### 4.5 交互细节

建议快捷键：

| 快捷键 | 行为 |
|--------|------|
| Enter | 发送 |
| Ctrl+C | 退出 |
| Ctrl+L | 清屏 |
| Ctrl+R | 手动重连 |
| Ctrl+I | 选择图片，若终端环境支持 |

是否实现 `Ctrl+I` 取决于 Node 端文件选择方案。首版 CLI 图片发送可以先支持命令式输入：

```text
/image C:\Users\me\Pictures\a.jpg
```

然后读取、压缩、加密发送。

## 5. 推荐实施顺序

### 阶段 1：协议与基线

- 修复 Flutter `flutter_test` 依赖。
- 更新 API 文档，加入结构化消息与图片消息格式。
- CLI/Flutter/Web 共用同一套结构化消息解析规则。
- 保持后端 `RoomObject` 不改或只增加单帧大小保护。

### 阶段 2：Web 聊天端

- 新增 `/chat` 页面。
- 用 Web Crypto 实现 HKDF + AES-GCM。
- 实现文本聊天。
- 接入图片选择、压缩、加密发送、预览展示。

### 阶段 3：Flutter Windows/macOS 桌面端

- 生成并提交 Windows/macOS 平台目录。
- 增加 CI analyze/test 和 Windows/macOS build。
- 增加 release Windows/macOS artifacts。
- 用 `file_picker` + `image` 实现图片发送。

### 阶段 4：TUI 美化与 CLI 图片

- 拆分 Ink 组件。
- 重做状态栏、消息列表、输入栏。
- 支持结构化消息解析。
- 首版显示图片摘要。
- 可选实现 `/image <path>` 发送图片。

## 6. 兼容性策略

旧客户端只知道纯文本明文。新客户端收到旧文本时按纯文本显示；旧客户端收到新结构化 JSON 时会显示 JSON 字符串。这是可接受的临时兼容状态。

如果后续需要更强兼容，可在 `joined` 后增加客户端能力通告：

```json
{
  "type": "hello",
  "payload": {
    "client": "ephem-flutter",
    "supports": ["structured-v1", "image-inline-v1"]
  }
}
```

但该方案需要后端维护会话能力表，超出首版图片发送范围，暂不采用。
