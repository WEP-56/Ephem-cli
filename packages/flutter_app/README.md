# Ephem · Flutter 客户端

> Android / iOS 端的 Ephem 客户端，与官方 `ephem-cli` 协议互通。

## 截图说明

底部双 Tab 设计：

- **连接 Tab**：输入房间码 + 用户名，一键加入房间
- **设置 Tab**：后端地址（带"在浏览器打开"按钮跳转 Admin 页面）、默认用户名、代理设置

## 环境要求

- Flutter ≥ 3.10（Dart ≥ 3.0）
- Android Studio / VS Code
- Android SDK（构建 APK 需要）

## 首次运行

```bash
cd packages/flutter_app

# 1. 安装依赖
flutter pub get

# 2. 跑起来（连接模拟器或真机）
flutter run
```

## 构建 Release APK

```bash
# Android APK
flutter build apk --release

# 产物在 build/app/outputs/flutter-apk/app-release.apk
```

如果只想要特定架构的拆分 APK（体积更小）：

```bash
flutter build apk --release --split-per-abi
```

## 与 CLI 互通测试

1. 用 Admin 页面（设置 Tab 里点跳转按钮）或 CLI 创建一个房间
2. CLI 端：`ephem --server wss://ephem-backend.xxx.workers.dev --room <房间码> --username alice`
3. Flutter 端：填同样的后端地址 + 房间码，用户名填 bob，点加入
4. 双向互发消息，应能正常加解密显示

**关键验证点**：Flutter 加密的消息 CLI 必须能解密，反之亦然。通过了说明加密实现正确。

## 项目结构

```
lib/
├── main.dart                       # 入口
├── app.dart                        # MaterialApp + 底部导航
├── crypto/
│   └── ephem_crypto.dart           # HKDF + AES-256-GCM（与 CLI 字节级互通）
├── services/
│   ├── storage_service.dart        # SharedPreferences 持久化
│   ├── ephem_client.dart           # WebSocket 客户端（心跳/错误识别）
│   └── chat_controller.dart        # 会话协调（密钥派生+收发+解密）
└── pages/
    ├── connect_page.dart           # 连接 Tab：房间码+用户名
    ├── chat_page.dart              # 聊天界面：消息列表+输入+倒计时
    └── settings_page.dart          # 设置 Tab：后端地址+用户名+代理
```

## 实现要点

### 加密互通

`lib/crypto/ephem_crypto.dart` 严格按 [API.md](../../API.md) 第 6 章实现：
- HKDF-SHA256 派生 32 字节密钥，salt/info 字符串字面量与 CLI 一致
- AES-256-GCM：12 字节随机 nonce，16 字节 authTag 拼在密文末尾，整体 base64

### 安全

- 房间码不写磁盘
- 派生的 `SecretKey` 仅存内存，退出聊天页随 `ChatController.dispose()` 释放
- 明文消息只在内存 `_messages` 列表里，退出即丢失（这是 ephem 的设计意图）

### WebSocket 错误处理

握手失败时从错误信息里识别 HTTP 状态码 → 友好提示：
- 403 `room_full` → 房间人数已满
- 404 `room_not_found` → 房间不存在或已销毁
- 410 `room_expired` → 房间已过期
- 429 `rate_limited` → 连接过于频繁

## 代理设置说明

设置页的代理字段是**实验性**功能：
- `web_socket_channel` 包本身不直接支持代理参数
- 想真正走代理需要：
  1. 用 `HttpClient` 设置 `findProxyFromEnvironment` 或 `findProxy`
  2. 手动实现 WS 握手（较复杂）
- **推荐做法**：用系统级 VPN（如 Clash for Android）而不是应用内代理

设置页保留这个字段是为了 UI 完整性 + 后续扩展，当前版本启用代理后不会生效。

## 待办 / 扩展点

- [ ] 真正的代理实现（自定义 WebSocket transport）
- [ ] 房间码二维码扫描（移动端体验更佳）
- [ ] 消息已读状态、输入中提示
- [ ] 多主题切换
- [ ] 国际化（i18n）
