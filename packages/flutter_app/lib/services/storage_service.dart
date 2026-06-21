// 设置持久化服务（SharedPreferences 封装）
// 安全提示：只存"后端地址/默认用户名/代理"，绝不存房间码或密钥。

import 'package:shared_preferences/shared_preferences.dart';

class StorageService {
  static const _kServer = 'ephem.server';
  static const _kUsername = 'ephem.username';
  static const _kProxy = 'ephem.proxy'; // 形如 host:port，留空表示不使用
  static const _kProxyEnabled = 'ephem.proxyEnabled';

  /// 默认后端地址（用户首次安装时给个参考值）
  static const defaultServer = 'wss://ephem-backend.pan2222qqcom.workers.dev';

  Future<String> getServer() async =>
      (await SharedPreferences.getInstance()).getString(_kServer) ?? defaultServer;
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
}
