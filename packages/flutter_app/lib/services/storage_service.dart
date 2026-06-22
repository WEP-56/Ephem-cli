// 设置持久化服务（SharedPreferences 封装）
// 安全提示：只存"后端地址/默认用户名/代理/本机创建的管理房间记录"，绝不存房间密钥或管理员密码。

import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';

class ManagedRoomRecord {
  final String code;
  final int createdAt;
  final int expiresAt;
  final int maxMembers;
  final int ttlSeconds;

  const ManagedRoomRecord({
    required this.code,
    required this.createdAt,
    required this.expiresAt,
    required this.maxMembers,
    required this.ttlSeconds,
  });

  factory ManagedRoomRecord.fromJson(Map<String, dynamic> json) =>
      ManagedRoomRecord(
        code: json['code']?.toString() ?? '',
        createdAt: (json['createdAt'] as num?)?.toInt() ?? 0,
        expiresAt: (json['expiresAt'] as num?)?.toInt() ?? 0,
        maxMembers: (json['maxMembers'] as num?)?.toInt() ?? 2,
        ttlSeconds: (json['ttlSeconds'] as num?)?.toInt() ?? 3600,
      );

  Map<String, dynamic> toJson() => {
        'code': code,
        'createdAt': createdAt,
        'expiresAt': expiresAt,
        'maxMembers': maxMembers,
        'ttlSeconds': ttlSeconds,
      };
}

class StorageService {
  static const _kServer = 'ephem.server';
  static const _kUsername = 'ephem.username';
  static const _kProxy = 'ephem.proxy'; // 形如 host:port，留空表示不使用
  static const _kProxyEnabled = 'ephem.proxyEnabled';
  static const _kManagedRooms = 'ephem.managedRooms';

  /// 默认后端地址（空字符串：开源项目，不预设作者私有后端，
  /// 用户首次进入需到设置页填写自己的后端地址）
  static const defaultServer = '';

  Future<String> getServer() async =>
      (await SharedPreferences.getInstance()).getString(_kServer) ??
      defaultServer;
  Future<void> setServer(String v) async =>
      (await SharedPreferences.getInstance()).setString(_kServer, v.trim());

  Future<String> getUsername() async =>
      (await SharedPreferences.getInstance()).getString(_kUsername) ?? '';
  Future<void> setUsername(String v) async =>
      (await SharedPreferences.getInstance()).setString(_kUsername, v.trim());

  Future<bool> isProxyEnabled() async =>
      (await SharedPreferences.getInstance()).getBool(_kProxyEnabled) ?? false;
  Future<void> setProxyEnabled(bool v) async =>
      (await SharedPreferences.getInstance()).setBool(_kProxyEnabled, v);

  Future<String> getProxy() async =>
      (await SharedPreferences.getInstance()).getString(_kProxy) ?? '';
  Future<void> setProxy(String v) async =>
      (await SharedPreferences.getInstance()).setString(_kProxy, v.trim());

  Future<List<ManagedRoomRecord>> getManagedRooms() async {
    final raw =
        (await SharedPreferences.getInstance()).getString(_kManagedRooms);
    if (raw == null || raw.isEmpty) return [];
    try {
      final list = jsonDecode(raw) as List<dynamic>;
      return list
          .whereType<Map<String, dynamic>>()
          .map(ManagedRoomRecord.fromJson)
          .where((room) => room.code.isNotEmpty)
          .take(50)
          .toList();
    } catch (_) {
      return [];
    }
  }

  Future<void> setManagedRooms(List<ManagedRoomRecord> rooms) async {
    final data = rooms.take(50).map((room) => room.toJson()).toList();
    await (await SharedPreferences.getInstance())
        .setString(_kManagedRooms, jsonEncode(data));
  }

  Future<void> rememberManagedRoom(ManagedRoomRecord room) async {
    final rooms = await getManagedRooms();
    final next = [
      room,
      ...rooms.where((item) => item.code != room.code),
    ].take(50).toList();
    await setManagedRooms(next);
  }
}
