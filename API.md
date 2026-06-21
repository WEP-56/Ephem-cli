# Ephem API 文档

> 本文档面向第三方客户端开发者（Flutter / iOS / Android / Web / 桌面等）。
> 只要按本文档实现 HTTP 调用、WebSocket 连接和加密协议，就能接入 Ephem 网络，
> 与官方 `ephem-cli` 互通。

## 目录

- [1. 基础信息](#1-基础信息)
- [2. 鉴权模型](#2-鉴权模型)
- [3. 房间码格式](#3-房间码格式)
- [4. Admin REST API](#4-admin-rest-api)
  - [4.1 创建房间](#41-创建房间)
  - [4.2 查询房间状态](#42-查询房间状态)
  - [4.3 销毁房间](#43-销毁房间)
- [5. WebSocket 协议](#5-websocket-协议)
  - [5.1 连接](#51-连接)
  - [5.2 服务端 → 客户端 消息](#52-服务端--客户端-消息)
  - [5.3 客户端 → 服务端 消息](#53-客户端--服务端-消息)
  - [5.4 连接关闭与错误码](#54-连接关闭与错误码)
- [6. 端到端加密协议](#6-端到端加密协议)
  - [6.1 密钥派生（HKDF）](#61-密钥派生hkdf)
  - [6.2 消息加密（AES-256-GCM）](#62-消息加密aes-256-gcm)
  - [6.3 字节级规范](#63-字节级规范)
- [7. 完整交互流程](#7-完整交互流程)
- [8. Flutter 客户端实现指引](#8-flutter-客户端实现指引)
- [9. 限流与配额](#9-限流与配额)
- [10. 版本与兼容](#10-版本与兼容)

---

## 1. 基础信息

| 项目 | 值 |
|------|------|
| 后端实现 | Cloudflare Workers + Durable Objects |
| HTTP 协议 | HTTPS（TLS 1.2+） |
| WebSocket 协议 | WSS（TLS 1.2+） |
| 数据格式 | JSON（HTTP / WS 文本帧） |
| 字符编码 | UTF-8 |
| 加密算法 | HKDF-SHA256 + AES-256-GCM |

**Base URL**

```
https://ephem-backend.<your-subdomain>.workers.dev
```

WebSocket 把 `https://` 换成 `wss://`。

> 注：开源项目不预设后端，请按 [DEPLOY.md](./DEPLOY.md) 自行部署。

---

## 2. 鉴权模型

Ephem 有**两套独立鉴权**：

### 2.1 Admin 鉴权（HTTP API）

用于**创建/销毁房间、查询状态**。请求头带固定密钥：

```
X-Admin-Key: <ADMIN_PASSWORD>
```

`ADMIN_PASSWORD` 是部署者在 Cloudflare 上通过 `wrangler secret put ADMIN_PASSWORD` 设置的值。

- 没有 `X-Admin-Key` 或值不匹配 → 返回 `401 Unauthorized`
- 这是固定密钥鉴权，非 OAuth/JWT。适合单管理员场景。

### 2.2 用户鉴权（WebSocket 连接）

**没有账号体系**。用户凭房间码加入房间——房间码本身就是双方共享的秘密。

房间码同时承担：
1. **路由标识**：后端通过 `SHA-256(roomCode)` 找到对应 Durable Object
2. **加密密钥种子**：客户端用房间码派生 AES-256-GCM 密钥

房间码不通过网络传给后端做加密用途，仅用于路由。

---

## 3. 房间码格式

```
<word1>-<word2>-<word3>
```

- 3 个英文小写单词，用 `-` 连接
- 单词来自 [BIP39 英文词表](https://github.com/bitcoin/bips/blob/master/bip-0039/english.txt)（2048 词）
- 示例：`correct-horse-battery`、`swear-garment-segment`、`kiss-minute-love`
- 组合空间 2048³ ≈ 85 亿

**客户端校验**：连接前建议校验格式合法性（3 段、每段都在词表里），可减少无效请求。

---

## 4. Admin REST API

所有 `/api/*` 端点都需要 `X-Admin-Key` 头。

### 4.1 创建房间

```
POST /api/rooms
```

**请求头**

```
Content-Type: application/json
X-Admin-Key: <ADMIN_PASSWORD>
```

**请求体**

| 字段 | 类型 | 必填 | 默认 | 取值范围 | 说明 |
|------|------|------|------|----------|------|
| `maxMembers` | number | 否 | 2 | 2 ~ 32 | 房间人数上限 |
| `ttlSeconds` | number | 否 | 3600 | 60 ~ 86400 | 房间存活时长（秒） |

**请求示例**

```bash
curl -X POST https://ephem-backend.xxx.workers.dev/api/rooms \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: your-admin-password" \
  -d '{"maxMembers": 2, "ttlSeconds": 3600}'
```

**成功响应** `200 OK`

```json
{
  "roomCode": "correct-horse-battery",
  "expiresAt": 1782045811151,
  "maxMembers": 2,
  "ttlSeconds": 3600
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `roomCode` | string | 房间码（明文，仅此一次返回，需安全转告对方） |
| `expiresAt` | number | 销毁时间戳（毫秒，UTC） |
| `maxMembers` | number | 实际生效的房间人数上限（可能被 clamp） |
| `ttlSeconds` | number | 实际生效的存活时长（可能被 clamp） |

**错误响应**

| HTTP | body.error | 说明 |
|------|-----------|------|
| 400 | `bad_body` | 请求体不是合法 JSON |
| 401 | `unauthorized` | 缺少或错误的 `X-Admin-Key` |
| 503 | `room_code_conflict` | 房间码哈希冲突重试 5 次仍失败（极小概率） |

---

### 4.2 查询房间状态

```
GET /api/rooms/:roomCode/status
```

仅返回元信息，**不返回任何消息内容**（消息本来就不存储）。

**请求示例**

```bash
curl https://ephem-backend.xxx.workers.dev/api/rooms/correct-horse-battery/status \
  -H "X-Admin-Key: your-admin-password"
```

**成功响应** `200 OK`（房间存在）

```json
{
  "alive": true,
  "currentMembers": 2,
  "maxMembers": 2,
  "createdAt": 1782042211151,
  "expiresAt": 1782045811151
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `alive` | boolean | 房间是否仍存活（未过期） |
| `currentMembers` | number | 当前在线人数 |
| `maxMembers` | number | 人数上限 |
| `createdAt` | number | 创建时间戳（毫秒） |
| `expiresAt` | number | 销毁时间戳（毫秒） |

**房间不存在** `404 Not Found`

```json
{ "alive": false, "error": "not_found" }
```

---

### 4.3 销毁房间

```
DELETE /api/rooms/:roomCode
```

立即销毁房间：断开所有成员连接、清空 DO 状态、取消 alarm。

**请求示例**

```bash
curl -X DELETE https://ephem-backend.xxx.workers.dev/api/rooms/correct-horse-battery \
  -H "X-Admin-Key: your-admin-password"
```

**成功响应** `200 OK`

```json
{ "success": true }
```

**房间不存在** `404 Not Found`

```json
{ "success": false, "error": "not_found" }
```

---

## 5. WebSocket 协议

### 5.1 连接

```
GET wss://ephem-backend.xxx.workers.dev/room/:roomCode?username=<username>
```

**路径参数**

| 参数 | 说明 |
|------|------|
| `roomCode` | URL-encoded 房间码（如 `correct-horse-battery`） |

**Query 参数**

| 参数 | 必填 | 默认 | 长度限制 | 说明 |
|------|------|------|----------|------|
| `username` | 否 | `匿名` | 32 字符 | 显示名（超出会被截断） |

**握手响应**

- `101 Switching Protocols`：成功升级为 WebSocket
- 非 101 响应见 [5.4 错误码](#54-连接关闭与错误码)

**握手成功后**：服务端立即（可能在 `setTimeout(0)` 之后）发送 `joined` 消息，客户端应等待该消息确认加入成功。

---

### 5.2 服务端 → 客户端 消息

所有消息为 JSON 文本帧。通用结构：

```json
{ "type": "<type>", "payload": { ... } }
```

#### `joined` — 加入成功

连接成功后第一条消息。

```json
{
  "type": "joined",
  "payload": {
    "username": "alice",
    "currentMembers": 2,
    "maxMembers": 3,
    "expiresAt": 1782045811151
  }
}
```

#### `peer_joined` — 其他人加入

```json
{
  "type": "peer_joined",
  "payload": { "username": "bob" }
}
```

#### `peer_left` — 其他人离开

```json
{
  "type": "peer_left",
  "payload": { "username": "bob" }
}
```

#### `message` — 聊天消息（密文）

```json
{
  "type": "message",
  "payload": {
    "from": "alice",
    "ciphertext": "<base64>",
    "nonce": "<base64>",
    "timestamp": 1782042311151
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `from` | string | 发送者用户名 |
| `ciphertext` | string | 密文（base64 编码，含 authTag，见 [6.2](#62-消息加密aes-256-gcm)） |
| `nonce` | string | 12 字节随机 nonce（base64 编码） |
| `timestamp` | number | 服务端转发时的时间戳（毫秒） |

**注意**：`ciphertext` 和 `nonce` 都是密文相关字段，后端不解密、不校验、原样转发。客户端必须用房间码派生的密钥本地解密。

#### `room_closing` — 房间即将销毁

```json
{
  "type": "room_closing",
  "payload": { "reason": "ttl_expired" }
}
```

| `reason` 值 | 说明 |
|------------|------|
| `ttl_expired` | TTL 到期 |
| `empty` | 全员离开超 5 分钟 |
| `manual` | 管理员手动销毁 |

收到此消息后服务端会主动断开连接。客户端有约 1.5 秒的窗口可以显示提示、保存状态。

#### `error` — 协议错误

```json
{
  "type": "error",
  "payload": { "code": "bad_message", "message": "无法解析的消息" }
}
```

通常表示客户端发了无法解析的 JSON 或非法消息格式。连接不会因此断开。

---

### 5.3 客户端 → 服务端 消息

#### 发送消息（密文）

```json
{
  "type": "message",
  "payload": {
    "ciphertext": "<base64>",
    "nonce": "<base64>"
  }
}
```

加密方式见 [第 6 章](#6-端到端加密协议)。服务端收到后会：
1. 补上 `from`（你的用户名）和 `timestamp`（当前时间）
2. 原样广播给房间内**其他**成员（不会回传给你自己）

**注意**：客户端若想在 UI 显示自己发的消息，需在本地保存一份明文并自行渲染。

#### 心跳保活

```json
{ "type": "ping" }
```

- **用途**：防止代理/防火墙因长时间无流量断开 WS 连接
- **频率**：建议每 25 秒发一次
- **响应**：服务端不回包，有流量即可
- **不发的后果**：某些 NAT/CDN 可能在 30~60 秒无流量后断连，导致消息丢失

---

### 5.4 连接关闭与错误码

**HTTP 握手阶段失败**（非 101 响应）：

| HTTP | `body.error` | 说明 | 客户端应对 |
|------|-------------|------|-----------|
| 403 | `room_full` | 房间人数已满 | 提示用户房间已满，不可重试 |
| 404 | `room_not_found` | 房间不存在或已销毁 | 提示房间码错误或房间已过期，不可重试 |
| 410 | `room_expired` | 房间已过期 | 同上 |
| 429 | `rate_limited` | 连接过于频繁 | 等待 60 秒后重试 |
| 500 | - | 服务端内部错误 | 重试或反馈 |

错误响应体示例：

```json
{ "error": "room_not_found", "message": "房间不存在或已销毁" }
```

**WebSocket 连接建立后关闭**：

| Close Code | 说明 |
|-----------|------|
| 1000 | 正常关闭（含房间销毁后的主动关闭） |
| 1006 | 异常断开（网络中断、服务端重启等），可重连 |

**重连策略建议**：
- 1006（异常断开）：自动重连，指数退避（1s → 2s → 4s → ... → 30s 上限）
- 1000（正常关闭）：检查是否收到过 `room_closing`，是则不重连
- HTTP 握手 403/404/410：**不要重连**，提示用户

---

## 6. 端到端加密协议

> ⚠ **这是 Flutter 端最容易踩坑的部分。必须严格按本节规范实现，否则无法与官方 CLI 互通。**

### 6.1 密钥派生（HKDF）

从房间码派生 32 字节 AES-256 密钥。**所有客户端用相同参数**才能派生出相同密钥。

```
roomKey = HKDF-SHA256(
  ikm    = roomCode,                        // UTF-8 编码的字节
  salt   = "ephem-v1-room-salt",            // UTF-8 编码的字节
  info   = "ephem-room-encryption-key",     // UTF-8 编码的字节
  length = 32                               // 字节
)
```

**参数是固定的字符串字面量**，不要随机生成，不要拼接用户名或时间戳。

**伪代码**

```dart
// Dart 伪代码
import 'package:crypto/crypto.dart';

List<int> deriveRoomKey(String roomCode) {
  return hkdf(
    ikm: utf8.encode(roomCode),
    salt: utf8.encode('ephem-v1-room-salt'),
    info: utf8.encode('ephem-room-encryption-key'),
    length: 32,
  );
}
```

**Node 参考实现**（`packages/cli/src/crypto/deriveKey.ts`）

```js
const { hkdfSync } = require('node:crypto');
const key = hkdfSync('sha256',
  Buffer.from(roomCode, 'utf8'),         // ikm
  Buffer.from('ephem-v1-room-salt', 'utf8'),    // salt
  Buffer.from('ephem-room-encryption-key', 'utf8'), // info
  32);                                    // length
```

### 6.2 消息加密（AES-256-GCM）

每条消息独立加密，使用随机 12 字节 nonce。

**加密流程**

```
1. 生成 12 字节随机 nonce（crypto-secure random）
2. 用 roomKey + nonce 对 plaintext 做 AES-256-GCM 加密
   → 得到 ciphertext + authTag（16 字节）
3. 拼接：combined = ciphertext || authTag（authTag 在末尾）
4. base64 编码：
   - payload.ciphertext = base64(combined)
   - payload.nonce = base64(nonce)
```

**解密流程**

```
1. base64 解码：
   - combined = base64decode(payload.ciphertext)
   - nonce = base64decode(payload.nonce)
2. 拆分（combined 长度必然 ≥ 17）：
   - authTag = combined[末尾 16 字节]
   - ciphertext = combined[去掉末尾 16 字节]
3. 用 roomKey + nonce + authTag 校验并解密
   → 得到 plaintext（UTF-8）
```

**注意点**

- nonce **每条消息独立生成**，绝不能复用（复用会导致密钥泄露）
- authTag **必须校验**：校验失败说明密钥不对或密文被篡改，应丢弃消息
- authTag 拼接位置**必须在密文末尾**（不是开头，不是单独字段）

### 6.3 字节级规范

| 项 | 值 |
|----|----|
| 密钥长度 | 32 字节（AES-256） |
| nonce 长度 | 12 字节（GCM 标准） |
| authTag 长度 | 16 字节（GCM 默认） |
| 拼接顺序 | `ciphertext ‖ authTag` |
| 传输编码 | base64（标准 base64，带 padding） |
| 明文编码 | UTF-8 |

**测试向量**（用于验证实现正确性）

```
roomCode  = "correct-horse-battery"
roomKey   = HKDF-SHA256(ikm=roomCode, salt="ephem-v1-room-salt",
                        info="ephem-room-encryption-key", length=32)
          = <32 字节，可通过 Node 脚本生成对照>

plaintext = "你好，ephem！这是一条加密消息 🔐"
nonce     = <12 字节随机，每条消息不同>
ciphertext+authTag = AES-256-GCM-Encrypt(roomKey, nonce, plaintext)
```

互通验证方法：用官方 `ephem-cli` 发一条消息，Flutter 端能正确解密即说明加密实现正确。

---

## 7. 完整交互流程

```
┌─────────┐                ┌─────────┐                ┌─────────┐
│ Admin   │                │  后端   │                │ Client A │
│ (Web)   │                │ (Worker)│                │ (CLI/Flutter)│
└────┬────┘                └────┬────┘                └────┬────┘
     │  POST /api/rooms         │                          │
     │  X-Admin-Key: ***        │                          │
     │  {maxMembers, ttlSeconds}│                          │
     │─────────────────────────▶│                          │
     │                          │ 生成 roomCode            │
     │                          │ SHA-256(roomCode) → DO   │
     │                          │ DO.put('meta')           │
     │                          │ DO.setAlarm(expiresAt)   │
     │  {roomCode, expiresAt}   │                          │
     │◀─────────────────────────│                          │
     │                          │                          │
     │  （Admin 把 roomCode 口头/截图转告给 Client A 和 B）│
     │                          │                          │
     │                          │   WSS /room/:code?username=A
     │                          │◀─────────────────────────│
     │                          │ DO 校验+accept           │
     │                          │ ── joined ──────────────▶│
     │                          │                          │
     │                          │   WSS /room/:code?username=B
     │                          │◀─────────────────────────│  (Client B)
     │                          │ ── joined ──────────────▶│
     │                          │ ── peer_joined ─────────▶│ (to A)
     │                          │                          │
     │                          │  加密消息流（密文转发） │
     │                          │◀─ message {cipher,nonce}─│ (A 发)
     │                          │ ── message {cipher,nonce}─▶│ (to B)
     │                          │                          │
     │                          │  ... 循环双向聊天 ...    │
     │                          │                          │
     │                          │  到达 expiresAt          │
     │                          │  alarm 触发 destroyRoom  │
     │                          │ ── room_closing ────────▶│
     │                          │ ── room_closing ─────────▶│ (to B)
     │                          │ close(1000)              │
     │                          │ × 关闭所有连接           │
     │                          │ × deleteAll() 清空状态   │
```

---

## 8. Flutter 客户端实现指引

### 8.1 推荐依赖

```yaml
# pubspec.yaml
dependencies:
  web_socket_channel: ^2.4.0    # WebSocket 客户端
  cryptography: ^2.5.0          # HKDF + AES-256-GCM（推荐，纯 Dart 实现）
  # 或备选：
  # pointycastle: ^3.7.0        # 底层密码学库，更灵活但 API 繁琐
  http: ^1.1.0                  # Admin API 调用
```

**为什么推荐 `cryptography` 包**：API 简洁，HKDF 和 AES-GCM 都有现成封装，跨平台（Android/iOS/Web/桌面）行为一致，无需平台原生插件。

### 8.2 加密实现示例（Dart）

```dart
import 'package:cryptography/cryptography.dart';
import 'dart:convert';

class EphemCrypto {
  static const _salt = 'ephem-v1-room-salt';
  static const _info = 'ephem-room-encryption-key';

  /// 从房间码派生 32 字节密钥
  static Future<SecretKey> deriveRoomKey(String roomCode) async {
    final hkdf = Hkdf.sha256();
    final secretKey = SecretKey(utf8.encode(roomCode));
    return hkdf.deriveKey(
      secretKey: secretKey,
      nonce: utf8.encode(_salt),  // cryptography 包里 nonce 即 HKDF 的 salt
      info: utf8.encode(_info),
      outputLength: 32,
    );
  }

  /// 加密一条消息
  static Future<({String ciphertext, String nonce})> encrypt(
    SecretKey roomKey,
    String plaintext,
  ) async {
    final algorithm = AesGcm.with256bits();
    final nonce = algorithm.newNonce(); // 12 字节随机
    final secretBox = await algorithm.encrypt(
      utf8.encode(plaintext),
      secretKey: roomKey,
      nonce: nonce,
    );
    // cryptography 包里 secretBox.cipherText 和 secretBox.mac 是分开的，
    // 我们要拼成 [cipherText || mac] 的 base64
    final combined = [...secretBox.cipherText, ...secretBox.mac.bytes];
    return (
      ciphertext: base64.encode(combined),
      nonce: base64.encode(nonce),
    );
  }

  /// 解密一条消息
  static Future<String> decrypt(
    SecretKey roomKey,
    {required String ciphertext, required String nonce}) async {
    final combined = base64.decode(ciphertext);
    final nonceBytes = base64.decode(nonce);
    // 拆分：末尾 16 字节是 mac（authTag）
    final macBytes = combined.sublist(combined.length - 16);
    final cipherBytes = combined.sublist(0, combined.length - 16);
    final algorithm = AesGcm.with256bits();
    final secretBox = SecretBox(
      cipherBytes,
      nonce: nonceBytes,
      mac: Mac(macBytes),
    );
    final plainBytes = await algorithm.decrypt(
      secretBox,
      secretKey: roomKey,
    );
    return utf8.decode(plainBytes);
  }
}
```

**关键点**：
- `cryptography` 包的 `SecretBox.mac` 对应 GCM 的 authTag（16 字节）
- 传输时把 `cipherText` 和 `mac.bytes` 拼接后 base64 编码（mac 在末尾）
- 解密时反向拆分

### 8.3 WebSocket 客户端骨架

```dart
import 'package:web_socket_channel/web_socket_channel.dart';
import 'dart:convert';
import 'dart:async';

class EphemClient {
  final String server;
  final String roomCode;
  final String username;
  WebSocketChannel? _channel;
  Timer? _pingTimer;
  final _messageController = StreamController<Map<String, dynamic>>.broadcast();

  Stream<Map<String, dynamic>> get messages => _messageController.stream;

  EphemClient({
    required this.server,
    required this.roomCode,
    required this.username,
  });

  void connect() {
    final url = '${normalizeWs(server)}/room/$roomCode?username=$username';
    _channel = WebSocketChannel.connect(Uri.parse(url));

    _channel!.stream.listen(
      (data) {
        final msg = jsonDecode(data as String) as Map<String, dynamic>;
        _messageController.add(msg);
        if (msg['type'] == 'joined') {
          _startPing();
        }
      },
      onError: (e) => print('WS error: $e'),
      onDone: () {
        _pingTimer?.cancel();
        print('WS closed');
      },
    );
  }

  void sendMessage(String ciphertextB64, String nonceB64) {
    _channel?.sink.add(jsonEncode({
      'type': 'message',
      'payload': {'ciphertext': ciphertextB64, 'nonce': nonceB64},
    }));
  }

  void _startPing() {
    _pingTimer?.cancel();
    _pingTimer = Timer.periodic(Duration(seconds: 25), (_) {
      _channel?.sink.add(jsonEncode({'type': 'ping'}));
    });
  }

  void close() {
    _pingTimer?.cancel();
    _channel?.sink.close();
  }

  String normalizeWs(String s) {
    var url = s.trim().replaceAll(RegExp(r'/+$'), '');
    if (url.startsWith('https://')) url = 'wss://${url.substring(8)}';
    else if (url.startsWith('http://')) url = 'ws://${url.substring(7)}';
    else if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
      url = 'wss://$url';
    }
    return url;
  }
}
```

### 8.4 Flutter 端实现清单

- [ ] **加入房间流程**：用户输入房间码 + 用户名 → 调用 `WSS /room/:code?username=` → 等 `joined` 消息 → 显示聊天界面
- [ ] **加密**：进入房间后立即用 `EphemCrypto.deriveRoomKey(roomCode)` 派生密钥，缓存在内存（**不要写入磁盘**）
- [ ] **收消息**：监听 `message` 事件 → 用密钥解密 → 显示。解密失败（authTag 校验不过）显示"无法解密的消息"
- [ ] **发消息**：用户输入 → 加密 → `sendMessage(ciphertext, nonce)` → 本地立刻显示（不等回声，因为后端不回传给发送者）
- [ ] **系统事件**：`peer_joined` / `peer_left` 显示系统提示；`room_closing` 显示倒计时并准备退出
- [ ] **心跳**：连上后每 25 秒发 `ping`
- [ ] **断线重连**：异常断开用指数退避重连（1s/2s/4s/.../30s 上限）；收到 `room_closing` 不重连
- [ ] **错误处理**：HTTP 握手 403/404/410 时不要重连，显示对应提示

### 8.5 安全注意事项

- **房间码不要写入磁盘**：不要写日志、不要存 SharedPreferences、不要写 crash report
- **派生的密钥不要持久化**：仅在内存中使用，退出 app 时清空
- **明文消息不要持久化**：聊天记录只在内存里维护，退出即丢失（这是 ephem 的设计意图）
- **生产构建关闭日志**：发布版禁用 print 输出密文/明文
- **使用 `wss://`**：不要连 `ws://`（明文），中间人可看到密文之外的元数据

---

## 9. 限流与配额

| 限制 | 阈值 | 作用域 |
|------|------|--------|
| 单 IP 连接尝试 | 15 次/分钟 | 单个房间码 |
| Cloudflare Workers 请求 | 10 万次/天 | 整个 Worker |
| Durable Objects 调用 | 100 万次/月 | 整个账号 |

对于 2~8 人短时聊天场景绰绰有余。

---

## 10. 版本与兼容

当前协议版本：`v1`

- 加密 salt/info 字符串含 `v1` 标识，未来升级协议时会改为 `v2`，确保新老客户端不互通错乱
- 房间码格式（3 词 BIP39）目前固定，未来可能扩展为可配置词数
- 消息 JSON 结构会保持向后兼容：新增字段不破坏老客户端

**协议升级策略**：客户端可在 `joined` 消息后通过 `maxMembers` 等字段判断服务端版本，遇不兼容字段应优雅降级。

---

## 附录：消息类型速查表

| 方向 | type | 用途 |
|------|------|------|
| S→C | `joined` | 加入成功 |
| S→C | `peer_joined` | 其他人加入 |
| S→C | `peer_left` | 其他人离开 |
| S→C | `message` | 聊天消息（密文） |
| S→C | `room_closing` | 房间即将销毁 |
| S→C | `error` | 协议错误 |
| C→S | `message` | 发送消息（密文） |
| C→S | `ping` | 心跳保活 |

---

## 附录：错误码速查表

| 来源 | code / error | HTTP | 含义 |
|------|-------------|------|------|
| HTTP | `unauthorized` | 401 | 缺少或错误的 X-Admin-Key |
| HTTP | `bad_body` | 400 | 请求体不是合法 JSON |
| HTTP | `room_not_found` | 404 | 房间不存在或已销毁 |
| HTTP | `room_expired` | 410 | 房间已过期 |
| HTTP | `room_full` | 403 | 房间人数已满 |
| HTTP | `rate_limited` | 429 | 连接过于频繁 |
| HTTP | `room_code_conflict` | 503 | 房间码哈希冲突重试失败 |
| WS | `bad_message` | - | 客户端发了无法解析的消息 |
