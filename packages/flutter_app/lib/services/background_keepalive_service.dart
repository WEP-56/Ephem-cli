import 'dart:io';
import 'package:flutter/services.dart';

class BackgroundKeepaliveService {
  static const _channel = MethodChannel('ephem/background');

  static Future<void> start({
    required String roomCode,
  }) async {
    if (!Platform.isAndroid) return;
    try {
      await _channel.invokeMethod<void>('start', {'roomCode': roomCode});
    } catch (_) {
      // 后台保活失败不应阻断聊天连接。
    }
  }

  static Future<void> stop() async {
    if (!Platform.isAndroid) return;
    try {
      await _channel.invokeMethod<void>('stop');
    } catch (_) {
      // ignore
    }
  }
}
