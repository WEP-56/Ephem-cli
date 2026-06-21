// 聊天会话控制器：协调 WS 客户端 + 加密 + UI 状态
//
// 职责：
//   - 用房间码派生密钥（内存中，退出即销毁）
//   - 监听 WS 消息流，解密 message，转发为 ChatEvent
//   - 暴露 send() 方法给 UI
//   - 管理房间元信息（人数/上限/到期时间）

import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:cryptography/cryptography.dart';
import '../crypto/ephem_crypto.dart';
import '../services/ephem_client.dart';

/// 房间信息（来自 joined 消息）
class RoomInfo {
  final String username;
  final int currentMembers;
  final int maxMembers;
  final int expiresAt;
  RoomInfo(this.username, this.currentMembers, this.maxMembers, this.expiresAt);
}

/// UI 关心的事件
sealed class ChatEvent {}
class JoinedEvent extends ChatEvent { final RoomInfo info; JoinedEvent(this.info); }
class PeerJoinedEvent extends ChatEvent { final String username; PeerJoinedEvent(this.username); }
class PeerLeftEvent extends ChatEvent { final String username; PeerLeftEvent(this.username); }
class MessageEvent extends ChatEvent {
  final String from;
  final String text; // 已解密的明文
  final int timestamp;
  MessageEvent(this.from, this.text, this.timestamp);
}
class DecryptFailedEvent extends ChatEvent {
  final String from;
  DecryptFailedEvent(this.from);
}
class RoomClosingEvent extends ChatEvent {
  final String reason; // ttl_expired / empty / manual
  RoomClosingEvent(this.reason);
}
class ErrorEvent extends ChatEvent {
  final String code;
  final String message;
  ErrorEvent(this.code, this.message);
}

class ChatController extends ChangeNotifier {
  final EphemClient _client;
  SecretKey? _roomKey;
  StreamSubscription<ServerMessage>? _sub;
  StreamSubscription? _errSub;
  StreamSubscription? _closeSub;

  RoomInfo? info;
  bool isClosing = false;
  String? lastError;

  final _eventController = StreamController<ChatEvent>.broadcast();
  Stream<ChatEvent> get events => _eventController.stream;

  ChatController({
    required String server,
    required String roomCode,
    required String username,
  }) : _client = EphemClient(server: server, roomCode: roomCode, username: username);

  /// 连接并派生密钥
  Future<void> start(String roomCode) async {
    _roomKey = await EphemCrypto.deriveRoomKey(roomCode);

    _errSub = _client.messages.listen(null, onError: (e) {
      if (e is ConnectRejectedException) {
        lastError = e.message;
        _eventController.add(ErrorEvent(e.code, e.message));
      }
    });

    _sub = _client.messages.listen((msg) {
      switch (msg.type) {
        case 'joined':
          final p = msg.payload;
          info = RoomInfo(
            p['username'] as String,
            p['currentMembers'] as int,
            p['maxMembers'] as int,
            p['expiresAt'] as int,
          );
          _eventController.add(JoinedEvent(info!));
          break;
        case 'peer_joined':
          _eventController.add(PeerJoinedEvent(msg.payload['username'] as String));
          break;
        case 'peer_left':
          _eventController.add(PeerLeftEvent(msg.payload['username'] as String));
          break;
        case 'message':
          _handleMessage(msg.payload);
          break;
        case 'room_closing':
          isClosing = true;
          _eventController.add(RoomClosingEvent(msg.payload['reason'] as String));
          break;
        case 'error':
          final p = msg.payload;
          _eventController.add(ErrorEvent(
            p['code']?.toString() ?? 'unknown',
            p['message']?.toString() ?? '',
          ));
          break;
      }
    });

    _closeSub = _client.closed.listen((_) {
      // 连接关闭，UI 自行决定是否重连
    });

    await _client.connect();
  }

  Future<void> _handleMessage(Map<String, dynamic> payload) async {
    final from = payload['from'] as String? ?? '未知';
    final ciphertext = payload['ciphertext'] as String?;
    final nonce = payload['nonce'] as String?;
    final timestamp = payload['timestamp'] as int? ?? 0;
    if (ciphertext == null || nonce == null || _roomKey == null) {
      _eventController.add(DecryptFailedEvent(from));
      return;
    }
    try {
      final text = await EphemCrypto.decrypt(
        _roomKey!,
        EncryptedPayload(ciphertext: ciphertext, nonce: nonce),
      );
      _eventController.add(MessageEvent(from, text, timestamp));
    } catch (e) {
      _eventController.add(DecryptFailedEvent(from));
    }
  }

  /// 发送一条消息（会自动加密）。返回 false 表示加密失败。
  Future<bool> send(String text) async {
    if (_roomKey == null) return false;
    try {
      final payload = await EphemCrypto.encrypt(_roomKey!, text);
      _client.sendMessage(payload.ciphertext, payload.nonce);
      return true;
    } catch (e) {
      return false;
    }
  }

  @override
  void dispose() {
    _sub?.cancel();
    _errSub?.cancel();
    _closeSub?.cancel();
    _eventController.close();
    _client.close();
    // 注意：SecretKey 没有显式销毁方法，依赖 GC 回收
    super.dispose();
  }
}
