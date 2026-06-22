import 'dart:convert';
import 'dart:io';

class CreateRoomResult {
  final String roomCode;
  final int expiresAt;
  final int maxMembers;
  final int ttlSeconds;

  const CreateRoomResult({
    required this.roomCode,
    required this.expiresAt,
    required this.maxMembers,
    required this.ttlSeconds,
  });

  factory CreateRoomResult.fromJson(Map<String, dynamic> json) =>
      CreateRoomResult(
        roomCode: json['roomCode'] as String,
        expiresAt: (json['expiresAt'] as num).toInt(),
        maxMembers: (json['maxMembers'] as num).toInt(),
        ttlSeconds: (json['ttlSeconds'] as num).toInt(),
      );
}

class RoomStatusResult {
  final bool alive;
  final int? currentMembers;
  final int? maxMembers;
  final int? createdAt;
  final int? expiresAt;
  final String? error;

  const RoomStatusResult({
    required this.alive,
    this.currentMembers,
    this.maxMembers,
    this.createdAt,
    this.expiresAt,
    this.error,
  });

  factory RoomStatusResult.fromJson(Map<String, dynamic> json) =>
      RoomStatusResult(
        alive: json['alive'] == true,
        currentMembers: (json['currentMembers'] as num?)?.toInt(),
        maxMembers: (json['maxMembers'] as num?)?.toInt(),
        createdAt: (json['createdAt'] as num?)?.toInt(),
        expiresAt: (json['expiresAt'] as num?)?.toInt(),
        error: json['error']?.toString(),
      );
}

class AdminApiException implements Exception {
  final int statusCode;
  final String message;
  const AdminApiException(this.statusCode, this.message);

  @override
  String toString() => '[$statusCode] $message';
}

class AdminApiService {
  final String server;
  final String adminKey;
  final bool proxyEnabled;
  final String proxy;

  const AdminApiService({
    required this.server,
    required this.adminKey,
    this.proxyEnabled = false,
    this.proxy = '',
  });

  Future<CreateRoomResult> createRoom({
    required int maxMembers,
    required int ttlSeconds,
  }) async {
    final json = await _request(
      'POST',
      '/api/rooms',
      body: {
        'maxMembers': maxMembers,
        'ttlSeconds': ttlSeconds,
      },
    );
    return CreateRoomResult.fromJson(json);
  }

  Future<RoomStatusResult> roomStatus(String roomCode) async {
    final json = await _request(
      'GET',
      '/api/rooms/${Uri.encodeComponent(roomCode)}'
          '/status',
    );
    return RoomStatusResult.fromJson(json);
  }

  Future<void> destroyRoom(String roomCode) async {
    await _request(
      'DELETE',
      '/api/rooms/${Uri.encodeComponent(roomCode)}',
    );
  }

  Future<Map<String, dynamic>> _request(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    final client = HttpClient();
    if (proxyEnabled && proxy.trim().isNotEmpty) {
      client.findProxy = (_) => 'PROXY ${_normalizeProxy(proxy)}';
    }
    try {
      final uri = Uri.parse('${_normalizeHttp(server)}$path');
      final req = await client.openUrl(method, uri);
      req.headers.set(HttpHeaders.contentTypeHeader, 'application/json');
      req.headers.set('X-Admin-Key', adminKey);
      if (body != null) {
        req.write(jsonEncode(body));
      }
      final res = await req.close();
      final text = await utf8.decodeStream(res);
      Map<String, dynamic> data = {};
      if (text.isNotEmpty) {
        data = jsonDecode(text) as Map<String, dynamic>;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw AdminApiException(
          res.statusCode,
          data['error']?.toString() ?? '请求失败',
        );
      }
      return data;
    } on AdminApiException {
      rethrow;
    } catch (e) {
      throw AdminApiException(0, e.toString());
    } finally {
      client.close(force: true);
    }
  }

  String _normalizeHttp(String raw) {
    var s = raw.trim().replaceAll(RegExp(r'/+$'), '');
    if (s.startsWith('wss://')) return 'https://${s.substring(6)}';
    if (s.startsWith('ws://')) return 'http://${s.substring(5)}';
    if (!s.startsWith('https://') && !s.startsWith('http://')) {
      return 'https://$s';
    }
    return s;
  }

  String _normalizeProxy(String raw) {
    var s = raw.trim();
    if (s.startsWith('http://')) s = s.substring(7);
    if (s.startsWith('https://')) s = s.substring(8);
    return s;
  }
}
