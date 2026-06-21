// Ephem WebSocket 客户端
//
// 实现 API.md 第 5 章协议：
//   - 连接 wss://server/room/:code?username=
//   - 收发 JSON 消息
//   - 25 秒心跳
//   - 错误码识别（room_full / room_not_found / room_expired / rate_limited）
//
// 注意：本类不做加密。加密由 EphemCrypto + ChatController 协作完成。
// 后端只看到密文，本类原样收发。

import 'dart:async';
import 'dart:convert';
import 'package:web_socket_channel/web_socket_channel.dart';

/// 服务端 → 客户端 消息（已解析）
class ServerMessage {
  final String type;
  final Map<String, dynamic> payload;

  ServerMessage(this.type, this.payload);

  factory ServerMessage.fromJson(Map<String, dynamic> json) =>
      ServerMessage(json['type'] as String, json['payload'] as Map<String, dynamic>? ?? {});
}

/// 连接被服务端拒绝的详细信息
class ConnectRejectedException implements Exception {
  final int httpStatus;
  final String code;
  final String message;
  ConnectRejectedException(this.httpStatus, this.code, this.message);

  @override
  String toString() => '[$httpStatus] $code: $message';
}

class EphemClient {
  final String server;
  final String roomCode;
  final String username;

  WebSocketChannel? _channel;
  StreamSubscription? _sub;
  Timer? _pingTimer;
  bool _manuallyClosed = false;

  /// 收到服务端消息的广播流
  final _messageController = StreamController<ServerMessage>.broadcast();
  Stream<ServerMessage> get messages => _messageController.stream;

  /// 连接彻底关闭
  final _closeController = StreamController<void>.broadcast();
  Stream<void> get closed => _closeController.stream;

  EphemClient({
    required this.server,
    required this.roomCode,
    required this.username,
  });

  /// 建立 WS 连接。失败抛 ConnectRejectedException。
  Future<void> connect() async {
    final url = '${_normalizeWs(server)}/room/${Uri.encodeComponent(roomCode)}'
        '?username=${Uri.encodeComponent(username)}';

    final uri = Uri.parse(url);
    WebSocketChannel ch;
    try {
      ch = WebSocketChannel.connect(uri);
    } catch (e) {
      throw ConnectRejectedException(0, 'connect_failed', e.toString());
    }
    _channel = ch;

    // 监听 stream。web_socket_channel 在握手失败时会触发 onError，
    // 但具体 HTTP 状态码需要从错误信息里解析（平台相关）。
    _sub = ch.stream.listen(
      (data) {
        if (data is String) {
          try {
            final json = jsonDecode(data) as Map<String, dynamic>;
            _messageController.add(ServerMessage.fromJson(json));
          } catch (_) {
            // 忽略无法解析的消息
          }
        }
      },
      onError: (e) {
        // 握手失败或运行时错误。把原始错误透传给上层。
        final msg = e.toString();
        // 尝试从错误消息里识别常见错误码
        if (msg.contains('403') || msg.contains('room_full')) {
          _messageController.addError(
              ConnectRejectedException(403, 'room_full', '房间人数已满'));
        } else if (msg.contains('404') || msg.contains('room_not_found')) {
          _messageController.addError(
              ConnectRejectedException(404, 'room_not_found', '房间不存在或已销毁'));
        } else if (msg.contains('410') || msg.contains('room_expired')) {
          _messageController.addError(
              ConnectRejectedException(410, 'room_expired', '房间已过期'));
        } else if (msg.contains('429') || msg.contains('rate_limited')) {
          _messageController.addError(
              ConnectRejectedException(429, 'rate_limited', '连接过于频繁，请稍后再试'));
        } else {
          _messageController.addError(
              ConnectRejectedException(0, 'unknown', msg));
        }
      },
      onDone: () {
        _stopPing();
        _closeController.add(null);
      },
    );

    // 启动心跳（即使还没收到 joined，定时器先开着，发不出去会自然丢弃）
    _startPing();
  }

  /// 发送一条已加密的消息（密文 + nonce，都是 base64 字符串）
  void sendMessage(String ciphertext, String nonce) {
    _channel?.sink.add(jsonEncode({
      'type': 'message',
      'payload': {'ciphertext': ciphertext, 'nonce': nonce},
    }));
  }

  /// 主动关闭连接（不触发重连）
  void close() {
    _manuallyClosed = true;
    _stopPing();
    _sub?.cancel();
    _channel?.sink.close();
  }

  bool get isManuallyClosed => _manuallyClosed;

  void _startPing() {
    _stopPing();
    _pingTimer = Timer.periodic(const Duration(seconds: 25), (_) {
      try {
        _channel?.sink.add(jsonEncode({'type': 'ping'}));
      } catch (_) {
        /* 连接可能已关闭 */
      }
    });
  }

  void _stopPing() {
    _pingTimer?.cancel();
    _pingTimer = null;
  }

  /// 把任意形式的地址规范化成 ws/wss 基础 URL（去尾部斜杠）
  static String _normalizeWs(String server) {
    var s = server.trim().replaceAll(RegExp(r'/+$'), '');
    if (s.startsWith('https://')) {
      s = 'wss://${s.substring('https://'.length)}';
    } else if (s.startsWith('http://')) {
      s = 'ws://${s.substring('http://'.length)}';
    } else if (!s.startsWith('ws://') && !s.startsWith('wss://')) {
      s = 'wss://$s';
    }
    return s;
  }
}
