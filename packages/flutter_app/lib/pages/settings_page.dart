import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../services/storage_service.dart';

class SettingsPage extends StatefulWidget {
  final StorageService storage;
  final VoidCallback onChanged;

  const SettingsPage({
    super.key,
    required this.storage,
    required this.onChanged,
  });

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  final _serverCtrl = TextEditingController();
  final _usernameCtrl = TextEditingController();
  final _proxyCtrl = TextEditingController();
  bool _proxyEnabled = false;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    _serverCtrl.text = await widget.storage.getServer();
    _usernameCtrl.text = await widget.storage.getUsername();
    _proxyCtrl.text = await widget.storage.getProxy();
    _proxyEnabled = await widget.storage.isProxyEnabled();
    setState(() => _loading = false);
  }

  Future<void> _save() async {
    await widget.storage.setServer(_serverCtrl.text);
    await widget.storage.setUsername(_usernameCtrl.text);
    await widget.storage.setProxy(_proxyCtrl.text);
    await widget.storage.setProxyEnabled(_proxyEnabled);
    widget.onChanged();
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('已保存')),
    );
  }

  Future<void> _openInBrowser() async {
    final url = _serverCtrl.text.trim();
    if (url.isEmpty) return;
    // 把 wss:// 换成 https:// 才能在浏览器打开
    var https = url;
    if (https.startsWith('wss://')) https = 'https://${https.substring(6)}';
    if (https.startsWith('ws://')) https = 'http://${https.substring(5)}';
    final uri = Uri.parse(https);
    if (await canLaunchUrl(uri)) {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } else {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('无法打开浏览器')),
      );
    }
  }

  @override
  void dispose() {
    _serverCtrl.dispose();
    _usernameCtrl.dispose();
    _proxyCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    return Scaffold(
      appBar: AppBar(title: const Text('设置')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // ── 后端地址 ──────────────────────────
          Text('连接', style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(height: 8),
          TextField(
            controller: _serverCtrl,
            decoration: InputDecoration(
              labelText: '后端地址',
              hintText: 'wss://your-worker.workers.dev',
              border: const OutlineInputBorder(),
              prefixIcon: const Icon(Icons.dns_outlined),
              suffixIcon: IconButton(
                icon: const Icon(Icons.open_in_new),
                onPressed: _openInBrowser,
                tooltip: '在浏览器中打开（Admin 页面）',
              ),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _usernameCtrl,
            decoration: const InputDecoration(
              labelText: '默认用户名',
              hintText: '留空则每次手动输入',
              border: OutlineInputBorder(),
              prefixIcon: Icon(Icons.person_outline),
            ),
            maxLength: 32,
          ),

          const SizedBox(height: 24),

          // ── 代理 ──────────────────────────────
          Text('代理', style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(height: 8),
          SwitchListTile(
            title: const Text('启用代理'),
            subtitle: const Text('实验性 · 仅对 WebSocket 握手生效'),
            value: _proxyEnabled,
            onChanged: (v) => setState(() => _proxyEnabled = v),
          ),
          if (_proxyEnabled)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: TextField(
                controller: _proxyCtrl,
                decoration: const InputDecoration(
                  labelText: '代理地址',
                  hintText: '127.0.0.1:7890',
                  border: OutlineInputBorder(),
                  prefixIcon: Icon(Icons.swap_horiz),
                ),
              ),
            ),
          const SizedBox(height: 4),
          Text(
            '提示：大多数情况下建议用系统级 VPN 而非应用内代理。',
            style: Theme.of(context).textTheme.bodySmall,
          ),

          const SizedBox(height: 32),
          FilledButton.icon(
            onPressed: _save,
            icon: const Icon(Icons.save),
            label: const Text('保存'),
          ),

          const SizedBox(height: 24),
          Text(
            'Ephem · 临时加密聊天室\n'
            '与 ephem-cli 协议互通 · 端到端加密',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
      ),
    );
  }
}
