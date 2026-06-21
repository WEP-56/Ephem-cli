// Ephem 加密模块往返测试
//
// 验证 AES-256-GCM 加解密能正确还原原文，并且不同次加密产生不同 nonce。
// 与官方 ephem-cli 字节级兼容（HKDF-SHA256 + AES-256-GCM，authTag 拼在密文末尾）。

import 'package:flutter_test/flutter_test.dart';
import 'package:ephem_flutter/crypto/ephem_crypto.dart';

void main() {
  group('EphemCrypto', () {
    test('加密后能正确解密还原原文', () async {
      const roomCode = 'apple banana cherry';
      const plaintext = 'hello ephem 👋';

      final roomKey = await EphemCrypto.deriveRoomKey(roomCode);
      final payload = await EphemCrypto.encrypt(roomKey, plaintext);
      final decrypted = await EphemCrypto.decrypt(roomKey, payload);

      expect(decrypted, equals(plaintext));
    });

    test('同一明文两次加密应产生不同 nonce（随机 nonce）', () async {
      const roomCode = 'test room code';
      const plaintext = 'same message';

      final roomKey = await EphemCrypto.deriveRoomKey(roomCode);
      final a = await EphemCrypto.encrypt(roomKey, plaintext);
      final b = await EphemCrypto.encrypt(roomKey, plaintext);

      expect(a.nonce, isNot(equals(b.nonce)));
      expect(a.ciphertext, isNot(equals(b.ciphertext)));
    });

    test('不同房间码派生出的密钥不同，无法互相解密', () async {
      const plaintext = 'secret';

      final keyA = await EphemCrypto.deriveRoomKey('room one code');
      final keyB = await EphemCrypto.deriveRoomKey('room two code');

      final payload = await EphemCrypto.encrypt(keyA, plaintext);

      // 用错误的密钥解密应抛出认证错误
      expect(
        () => EphemCrypto.decrypt(keyB, payload),
        throwsA(isA<Object>()),
      );
    });
  });
}
