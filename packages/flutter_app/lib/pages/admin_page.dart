import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../services/admin_api_service.dart';
import '../services/storage_service.dart';

class AdminPage extends StatefulWidget {
  final StorageService storage;
  final String server;
  final VoidCallback onChanged;

  const AdminPage({
    super.key,
    required this.storage,
    required this.server,
    required this.onChanged,
  });

  @override
  State<AdminPage> createState() => _AdminPageState();
}

class _AdminPageState extends State<AdminPage> {
  final _serverCtrl = TextEditingController();
  final _adminKeyCtrl = TextEditingController();
  final _maxMembersCtrl = TextEditingController(text: '2');
  final _ttlCtrl = TextEditingController(text: '3600');
  final _manualRoomCtrl = TextEditingController();

  bool _busy = false;
  bool _proxyEnabled = false;
  String _proxy = '';
  String? _error;
  CreateRoomResult? _lastCreated;
  List<ManagedRoomRecord> _rooms = [];
  final _statuses = <String, RoomStatusResult>{};

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(AdminPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.server != oldWidget.server && _serverCtrl.text.isEmpty) {
      _serverCtrl.text = widget.server;
    }
  }

  Future<void> _load() async {
    _serverCtrl.text = widget.server.isEmpty
        ? await widget.storage.getServer()
        : widget.server;
    _proxyEnabled = await widget.storage.isProxyEnabled();
    _proxy = await widget.storage.getProxy();
    _rooms = await widget.storage.getManagedRooms();
    if (mounted) setState(() {});
    await _refreshRooms();
  }

  AdminApiService _api() => AdminApiService(
        server: _serverCtrl.text.trim(),
        adminKey: _adminKeyCtrl.text,
        proxyEnabled: _proxyEnabled,
        proxy: _proxy,
      );

  Future<bool> _ensureReady() async {
    if (_serverCtrl.text.trim().isEmpty) {
      setState(() => _error = '请先填写后端地址');
      return false;
    }
    if (_adminKeyCtrl.text.isEmpty) {
      setState(() => _error = '请先输入管理员密码');
      return false;
    }
    await widget.storage.setServer(_serverCtrl.text);
    widget.onChanged();
    return true;
  }

  Future<void> _createRoom() async {
    if (!await _ensureReady()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final result = await _api().createRoom(
        maxMembers: int.tryParse(_maxMembersCtrl.text) ?? 2,
        ttlSeconds: int.tryParse(_ttlCtrl.text) ?? 3600,
      );
      final room = ManagedRoomRecord(
        code: result.roomCode,
        createdAt: DateTime.now().millisecondsSinceEpoch,
        expiresAt: result.expiresAt,
        maxMembers: result.maxMembers,
        ttlSeconds: result.ttlSeconds,
      );
      await widget.storage.rememberManagedRoom(room);
      _rooms = await widget.storage.getManagedRooms();
      _lastCreated = result;
      _statuses[result.roomCode] = RoomStatusResult(
        alive: true,
        currentMembers: 0,
        maxMembers: result.maxMembers,
        expiresAt: result.expiresAt,
      );
    } on AdminApiException catch (e) {
      _error = e.message;
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _refreshRooms() async {
    if (_serverCtrl.text.trim().isEmpty || _adminKeyCtrl.text.isEmpty) {
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      for (final room in _rooms) {
        try {
          _statuses[room.code] = await _api().roomStatus(room.code);
        } catch (_) {
          _statuses.remove(room.code);
        }
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _destroyRoom(String code) async {
    if (!await _ensureReady()) return;
    if (!mounted) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('销毁房间'),
        content: Text('确定销毁 $code？当前成员会被断开。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('销毁'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await _api().destroyRoom(code);
      _rooms = _rooms.where((room) => room.code != code).toList();
      _statuses.remove(code);
      await widget.storage.setManagedRooms(_rooms);
    } on AdminApiException catch (e) {
      _error = e.message;
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _trackManualRoom() async {
    final code = _manualRoomCtrl.text.trim().toLowerCase();
    if (code.isEmpty) return;
    final room = ManagedRoomRecord(
      code: code,
      createdAt: DateTime.now().millisecondsSinceEpoch,
      expiresAt: DateTime.now().millisecondsSinceEpoch,
      maxMembers: 2,
      ttlSeconds: 3600,
    );
    await widget.storage.rememberManagedRoom(room);
    _manualRoomCtrl.clear();
    _rooms = await widget.storage.getManagedRooms();
    setState(() {});
    await _refreshRooms();
  }

  @override
  void dispose() {
    _serverCtrl.dispose();
    _adminKeyCtrl.dispose();
    _maxMembersCtrl.dispose();
    _ttlCtrl.dispose();
    _manualRoomCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('管理'),
        actions: [
          IconButton(
            onPressed: _busy ? null : _refreshRooms,
            icon: const Icon(Icons.refresh),
            tooltip: '刷新状态',
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('认证', style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(height: 8),
          TextField(
            controller: _serverCtrl,
            decoration: const InputDecoration(
              labelText: '后端地址',
              hintText: 'wss://your-worker.workers.dev',
              border: OutlineInputBorder(),
              prefixIcon: Icon(Icons.dns_outlined),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _adminKeyCtrl,
            obscureText: true,
            decoration: const InputDecoration(
              labelText: '管理员密码',
              helperText: '仅本次使用，不会保存',
              border: OutlineInputBorder(),
              prefixIcon: Icon(Icons.admin_panel_settings_outlined),
            ),
          ),
          const SizedBox(height: 24),
          Text('创建房间', style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _maxMembersCtrl,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(
                    labelText: '人数',
                    border: OutlineInputBorder(),
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: TextField(
                  controller: _ttlCtrl,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(
                    labelText: '秒',
                    border: OutlineInputBorder(),
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          FilledButton.icon(
            onPressed: _busy ? null : _createRoom,
            icon: _busy
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.add),
            label: const Text('创建房间'),
          ),
          if (_lastCreated != null) _buildCreatedPanel(_lastCreated!),
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(_error!, style: const TextStyle(color: Colors.redAccent)),
          ],
          const SizedBox(height: 24),
          Text('本机房间记录', style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _manualRoomCtrl,
                  decoration: const InputDecoration(
                    labelText: '手动加入房间码记录',
                    border: OutlineInputBorder(),
                  ),
                  inputFormatters: [LowerCaseTextFormatter()],
                ),
              ),
              const SizedBox(width: 8),
              IconButton.filledTonal(
                onPressed: _trackManualRoom,
                icon: const Icon(Icons.bookmark_add_outlined),
                tooltip: '记录',
              ),
            ],
          ),
          const SizedBox(height: 12),
          if (_rooms.isEmpty)
            Text('还没有房间记录',
                style: Theme.of(context).textTheme.bodySmall)
          else
            ..._rooms.map(_buildRoomTile),
        ],
      ),
    );
  }

  Widget _buildCreatedPanel(CreateRoomResult result) => Card(
        margin: const EdgeInsets.only(top: 12),
        child: ListTile(
          leading: const Icon(Icons.key),
          title: SelectableText(result.roomCode),
          subtitle: Text(
            '${result.maxMembers} 人 · 剩余 ${_fmtLeft(result.expiresAt)}',
          ),
          trailing: IconButton(
            onPressed: () {
              Clipboard.setData(ClipboardData(text: result.roomCode));
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('房间码已复制')),
              );
            },
            icon: const Icon(Icons.copy),
            tooltip: '复制',
          ),
        ),
      );

  Widget _buildRoomTile(ManagedRoomRecord room) {
    final status = _statuses[room.code];
    final alive = status?.alive == true;
    final members = status == null
        ? '?/${room.maxMembers}'
        : '${status.currentMembers ?? '?'}/${status.maxMembers ?? room.maxMembers}';
    final left = status?.expiresAt == null ? '未知' : _fmtLeft(status!.expiresAt!);
    return Card(
      child: ListTile(
        title: SelectableText(room.code),
        subtitle: Text(alive ? '$members 人 · 剩余 $left' : '未确认存活'),
        leading: Icon(
          alive ? Icons.check_circle_outline : Icons.help_outline,
          color: alive ? Colors.greenAccent : Colors.amberAccent,
        ),
        trailing: IconButton(
          onPressed: _busy ? null : () => _destroyRoom(room.code),
          icon: const Icon(Icons.delete_outline),
          tooltip: '销毁',
        ),
      ),
    );
  }

  String _fmtLeft(int expiresAt) {
    final left = Duration(
      milliseconds: expiresAt - DateTime.now().millisecondsSinceEpoch,
    );
    if (left.isNegative) return '00:00:00';
    final h = left.inHours;
    final m = left.inMinutes.remainder(60);
    final s = left.inSeconds.remainder(60);
    return '${h.toString().padLeft(2, '0')}:'
        '${m.toString().padLeft(2, '0')}:'
        '${s.toString().padLeft(2, '0')}';
  }
}

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
