import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../services/storage_service.dart';
import 'chat_page.dart';

class ConnectPage extends StatefulWidget {
  final StorageService storage;
  final String server;
  final String username;
  final VoidCallback onSettingsTap;

  const ConnectPage({
    super.key,
    required this.storage,
    required this.server,
    required this.username,
    required this.onSettingsTap,
  });

  @override
  State<ConnectPage> createState() => _ConnectPageState();
}

class _ConnectPageState extends State<ConnectPage> {
  final _roomCodeCtrl = TextEditingController();
  final _usernameCtrl = TextEditingController();
  bool _connecting = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _usernameCtrl.text = widget.username;
  }

  @override
  void didUpdateWidget(ConnectPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.username != oldWidget.username && _usernameCtrl.text.isEmpty) {
      _usernameCtrl.text = widget.username;
    }
  }

  @override
  void dispose() {
    _roomCodeCtrl.dispose();
    _usernameCtrl.dispose();
    super.dispose();
  }

  Future<void> _connect() async {
    // 后端地址未配置：引导用户去设置
    if (widget.server.isEmpty) {
      setState(() => _error = '请先在设置里填写后端地址');
      return;
    }

    final room = _roomCodeCtrl.text.trim().toLowerCase();
    final user =
        _usernameCtrl.text.trim().isEmpty ? '匿名' : _usernameCtrl.text.trim();

    if (room.isEmpty) {
      setState(() => _error = '请输入房间码');
      return;
    }
    if (!RegExp(r'^[a-z]+-[a-z]+-[a-z]+$').hasMatch(room)) {
      setState(() => _error = '房间码格式应为 三段单词，例如 correct-horse-battery');
      return;
    }

    // 保存用户名
    await widget.storage.setUsername(user);

    setState(() {
      _connecting = true;
      _error = null;
    });

    if (!mounted) return;
    // 进入聊天页，由它负责 WS 连接
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => ChatPage(
          server: widget.server,
          roomCode: room,
          username: user,
        ),
      ),
    );

    if (!mounted) return;
    setState(() => _connecting = false);
    _roomCodeCtrl.clear();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Ephem'),
        actions: [
          IconButton(
            icon: const Icon(Icons.settings),
            onPressed: widget.onSettingsTap,
            tooltip: '设置',
          ),
        ],
      ),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const SizedBox(height: 16),
            Icon(Icons.lock_outline,
                size: 56, color: Theme.of(context).colorScheme.primary),
            const SizedBox(height: 12),
            Text(
              '临时加密聊天室',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 4),
            Text(
              '端到端加密 · 房间到期自动销毁',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: 32),

            // 房间码
            TextField(
              controller: _roomCodeCtrl,
              decoration: const InputDecoration(
                labelText: '房间码',
                hintText: 'correct-horse-battery',
                border: OutlineInputBorder(),
                prefixIcon: Icon(Icons.vpn_key_outlined),
              ),
              textInputAction: TextInputAction.next,
              inputFormatters: [
                LowerCaseTextFormatter(),
              ],
            ),
            const SizedBox(height: 16),

            // 用户名
            TextField(
              controller: _usernameCtrl,
              decoration: const InputDecoration(
                labelText: '用户名',
                hintText: '留空则显示"匿名"',
                border: OutlineInputBorder(),
                prefixIcon: Icon(Icons.person_outline),
              ),
              maxLength: 32,
            ),
            const SizedBox(height: 8),

            // 后端地址显示（点击跳转设置）
            InkWell(
              onTap: widget.onSettingsTap,
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: Row(
                  children: [
                    Icon(Icons.dns_outlined,
                        size: 16,
                        color: Theme.of(context).colorScheme.secondary),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        widget.server.isEmpty ? '点此设置后端地址 →' : widget.server,
                        style: widget.server.isEmpty
                            ? Theme.of(context).textTheme.bodySmall?.copyWith(
                                  color: Theme.of(context).colorScheme.error,
                                )
                            : Theme.of(context).textTheme.bodySmall,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    Icon(Icons.chevron_right,
                        size: 18,
                        color: Theme.of(context).colorScheme.secondary),
                  ],
                ),
              ),
            ),

            if (_error != null) ...[
              const SizedBox(height: 8),
              Text(_error!, style: const TextStyle(color: Colors.redAccent)),
            ],

            const Spacer(),
            FilledButton.icon(
              onPressed: _connecting ? null : _connect,
              icon: _connecting
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.login),
              label: Text(_connecting ? '连接中…' : '加入房间'),
            ),
            const SizedBox(height: 16),
          ],
        ),
      ),
    );
  }
}

/// 强制小写输入格式器
class LowerCaseTextFormatter extends TextInputFormatter {
  @override
  TextEditingValue formatEditUpdate(
      TextEditingValue oldValue, TextEditingValue newValue) {
    return TextEditingValue(
      text: newValue.text.toLowerCase(),
      selection: newValue.selection,
    );
  }
}
