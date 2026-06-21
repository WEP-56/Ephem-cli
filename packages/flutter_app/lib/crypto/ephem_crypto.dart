// Ephem 端到端加密模块
//
// 与官方 ephem-cli 完全互通，遵循 API.md 第 6 章字节级规范：
//   1. HKDF-SHA256 派生 32 字节密钥
//      ikm  = roomCode (UTF-8)
//      salt = "ephem-v1-room-salt" (UTF-8)
//      info = "ephem-room-encryption-key" (UTF-8)
//   2. AES-256-GCM 加密
//      nonce = 12 字节随机
//      authTag = 16 字节，拼接在密文末尾
//      传输时整体 base64 编码

import 'dart:convert';
import 'package:cryptography/cryptography.dart';

class EphemCrypto {
  static const String _salt = 'ephem-v1-room-salt';
  static const String _info = 'ephem-room-encryption-key';
  static const int _keyLength = 32; // AES-256
  static const int _tagLength = 16; // GCM 默认

  /// 从房间码派生房间加密密钥（32 字节）。
  /// 全程在内存中完成，房间码本身不因此通过网络发给后端。
  static Future<SecretKey> deriveRoomKey(String roomCode) async {
    final hkdf = Hkdf(
      hmac: Hmac.sha256(),
      outputLength: _keyLength,
    );
    final secretKey = SecretKey(utf8.encode(roomCode));
    return hkdf.deriveKey(
      secretKey: secretKey,
      // cryptography 包里 nonce 字段即 HKDF 标准里的 salt
      nonce: utf8.encode(_salt),
      info: utf8.encode(_info),
    );
  }

  /// 加密一条文本消息，返回 base64 编码的 ciphertext 与 nonce。
  static Future<EncryptedPayload> encrypt(
    SecretKey roomKey,
    String plaintext,
  ) async {
    final algorithm = AesGcm.with256bits();
    final nonce = algorithm.newNonce(); // 12 字节 crypto-secure random
    final secretBox = await algorithm.encrypt(
      utf8.encode(plaintext),
      secretKey: roomKey,
      nonce: nonce,
    );
    // 拼接 [cipherText || authTag]，与 CLI 一致
    final combined = <int>[...secretBox.cipherText, ...secretBox.mac.bytes];
    return EncryptedPayload(
      ciphertext: base64.encode(combined),
      nonce: base64.encode(nonce),
    );
  }

  /// 解密一条消息。authTag 校验失败会抛 SecretBoxAuthenticationError。
  static Future<String> decrypt(
    SecretKey roomKey,
    EncryptedPayload payload,
  ) async {
    final combined = base64.decode(payload.ciphertext);
    final nonce = base64.decode(payload.nonce);
    if (combined.length < _tagLength + 1) {
      throw const FormatException('密文长度异常');
    }
    // 末尾 16 字节是 authTag
    final macBytes = combined.sublist(combined.length - _tagLength);
    final cipherBytes = combined.sublist(0, combined.length - _tagLength);

    final algorithm = AesGcm.with256bits();
    final secretBox = SecretBox(
      cipherBytes,
      nonce: nonce,
      mac: Mac(macBytes),
    );
    final plainBytes = await algorithm.decrypt(
      secretBox,
      secretKey: roomKey,
    );
    return utf8.decode(plainBytes);
  }
}

/// 加密后的消息载荷，对应 WS 协议中的 payload.ciphertext / payload.nonce
class EncryptedPayload {
  final String ciphertext; // base64(密文 || authTag)
  final String nonce; // base64(12 字节 nonce)

  const EncryptedPayload({required this.ciphertext, required this.nonce});

  Map<String, dynamic> toJson() => {
        'ciphertext': ciphertext,
        'nonce': nonce,
      };
}
