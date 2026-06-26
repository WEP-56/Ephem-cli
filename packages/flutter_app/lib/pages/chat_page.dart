import 'dart:async';
import 'dart:typed_data';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import '../protocol/ephem_message.dart';
import '../services/archive_service.dart';
import '../services/background_keepalive_service.dart';
import '../services/chat_controller.dart';
import '../services/ephem_client.dart';

class ChatPage extends StatefulWidget {
  final String server;
  final String roomCode;
  final String username;
  final String clientId;

  const ChatPage({
    super.key,
    required this.server,
    required this.roomCode,
    required this.username,
    required this.clientId,
  });

  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> {
  late final ChatController _ctrl;
  final _inputCtrl = TextEditingController();
  final _scrollCtrl = ScrollController();
  final _messages = <_ChatLine>[];
  final _archiveMessages = <ArchiveMessage>[];
  final _archiveService = ArchiveService();
  Timer? _cdTimer;
  String? _connectError;
  bool _roomClosing = false;
  bool _historyLoading = false;
  bool _historyHasMore = false;
  String? _historyBefore;
  final _seenHistoryIds = <String>{};

  @override
  void initState() {
    super.initState();
    _ctrl = ChatController(
      server: widget.server,
      roomCode: widget.roomCode,
      username: widget.username,
      clientId: widget.clientId,
    );

    _ctrl.events.listen(_onEvent);
    _scrollCtrl.addListener(_onScroll);
    _startConnection();
  }

  Future<void> _startConnection() async {
    try {
      await _ctrl.start(widget.roomCode);
    } on ConnectRejectedException catch (e) {
      if (mounted) setState(() => _connectError = e.message);
    }
  }

  void _onEvent(ChatEvent e) {
    if (!mounted) return;
    var shouldStartKeepalive = false;
    var prependedHistory = false;
    final oldMaxScroll =
        _scrollCtrl.hasClients ? _scrollCtrl.position.maxScrollExtent : 0.0;
    setState(() {
      switch (e) {
        case JoinedEvent():
          _messages.add(_ChatLine.system('已加入房间 ${widget.roomCode} '
              '（${e.info.currentMembers}/${e.info.maxMembers} 人）'));
          shouldStartKeepalive = true;
          if (e.info.expiresAt != null) _startCountdown(e.info.expiresAt!);
        case PeerJoinedEvent():
          _messages.add(_ChatLine.system('${e.username} 加入了房间'));
        case PeerLeftEvent():
          _messages.add(_ChatLine.system('${e.username} 离开了房间'));
        case MessageEvent():
          if (e.historical) {
            if (e.historyId != null && !_seenHistoryIds.add(e.historyId!)) {
              break;
            }
            _messages.insert(
                0, _ChatLine.msg(e.from, e.text, e.from == widget.username));
            prependedHistory = true;
          } else {
            _messages
                .add(_ChatLine.msg(e.from, e.text, e.from == widget.username));
          }
          if (!e.historical) {
            _archiveMessages.add(ArchiveMessage.text(
              from: e.from,
              text: e.text,
              mine: e.from == widget.username,
              timestamp: e.timestamp,
            ));
          }
        case ImageMessageEvent():
          _messages
              .add(_ChatLine.image(e.from, e.image, e.from == widget.username));
          if (!e.historical) {
            _archiveMessages.add(ArchiveMessage.image(
              from: e.from,
              image: e.image,
              mine: e.from == widget.username,
              timestamp: e.timestamp,
            ));
          }
        case HistoryPageEvent():
          _historyHasMore = e.hasMore;
          _historyBefore = e.before;
          _historyLoading = false;
        case DecryptFailedEvent():
          _messages.add(_ChatLine.system('收到来自 ${e.from} 的无法解密的消息'));
        case RoomClosingEvent():
          _roomClosing = true;
          final reason = {
                'ttl_expired': '房间已到期',
                'empty': '房间已空',
                'manual': '房间被手动销毁',
              }[e.reason] ??
              e.reason;
          _messages.add(_ChatLine.system('房间即将关闭：$reason'));
          Future.delayed(const Duration(milliseconds: 1500), () {
            BackgroundKeepaliveService.stop();
            if (mounted) Navigator.of(context).pop();
          });
        case ErrorEvent():
          _connectError = e.message.isEmpty ? e.code : e.message;
          _messages.add(_ChatLine.system('错误：$_connectError'));
      }
      if (!prependedHistory) _scrollToBottom();
    });
    if (prependedHistory) _restoreScrollAfterPrepend(oldMaxScroll);
    if (shouldStartKeepalive) {
      unawaited(BackgroundKeepaliveService.start(roomCode: widget.roomCode));
    }
  }

  void _startCountdown(int expiresAt) {
    _cdTimer?.cancel();
    _cdTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) {
        _cdTimer?.cancel();
        return;
      }
      setState(() {}); // 触发重建以更新倒计时
      if (DateTime.now().millisecondsSinceEpoch >= expiresAt) {
        _cdTimer?.cancel();
      }
    });
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollCtrl.hasClients) {
        _scrollCtrl.animateTo(
          _scrollCtrl.position.maxScrollExtent,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
        );
      }
    });
  }

  void _restoreScrollAfterPrepend(double oldMaxScroll) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollCtrl.hasClients) return;
      final delta = _scrollCtrl.position.maxScrollExtent - oldMaxScroll;
      if (delta > 0) {
        _scrollCtrl.jumpTo((_scrollCtrl.offset + delta).clamp(
          _scrollCtrl.position.minScrollExtent,
          _scrollCtrl.position.maxScrollExtent,
        ));
      }
    });
  }

  void _onScroll() {
    if (!_scrollCtrl.hasClients) return;
    if (_scrollCtrl.offset < 160) _loadOlderHistory();
  }

  Future<void> _send() async {
    final text = _inputCtrl.text.trim();
    if (text.isEmpty || _roomClosing) return;
    final ok = await _ctrl.send(text);
    if (ok) {
      setState(() {
        _messages.add(_ChatLine.msg(widget.username, text, true));
        _archiveMessages.add(ArchiveMessage.text(
          from: widget.username,
          text: text,
          mine: true,
          timestamp: DateTime.now().millisecondsSinceEpoch,
        ));
        _inputCtrl.clear();
        _scrollToBottom();
      });
    } else {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('发送失败：加密出错')),
      );
    }
  }

  Future<void> _pickAndSendImage() async {
    if (_roomClosing) return;
    try {
      final result = await FilePicker.platform.pickFiles(
        type: FileType.image,
        withData: true,
        allowMultiple: false,
      );
      final file = result?.files.single;
      final bytes = file?.bytes;
      if (file == null || bytes == null) return;

      final image = await prepareImageMessage(
        bytes: Uint8List.fromList(bytes),
        fileName: file.name,
      );
      final ok = await _ctrl.sendImage(image);
      if (!mounted) return;
      if (ok) {
        setState(() {
          _messages.add(_ChatLine.image(widget.username, image, true));
          _archiveMessages.add(ArchiveMessage.image(
            from: widget.username,
            image: image,
            mine: true,
            timestamp: DateTime.now().millisecondsSinceEpoch,
          ));
          _scrollToBottom();
        });
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('发送图片失败：加密出错')),
        );
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('发送图片失败：$e')),
      );
    }
  }

  void _loadOlderHistory() {
    if (_historyLoading || !_historyHasMore) return;
    setState(() => _historyLoading = true);
    _ctrl.requestHistory(before: _historyBefore, limit: 50);
  }

  Future<void> _exportArchive() async {
    if (_archiveMessages.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('当前没有可导出的聊天记录')),
      );
      return;
    }
    final archive = EphemArchive(
      title:
          '${widget.roomCode} ${DateTime.now().toLocal().toIso8601String()}',
      roomCode: widget.roomCode,
      exportedAt: DateTime.now().millisecondsSinceEpoch,
      messages: List.of(_archiveMessages),
    );
    try {
      await _archiveService.exportArchive(archive);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('记录已导出')),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('导出失败：$e')),
      );
    }
  }

  @override
  void dispose() {
    _cdTimer?.cancel();
    _inputCtrl.dispose();
    _scrollCtrl.dispose();
    _ctrl.dispose();
    BackgroundKeepaliveService.stop();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_connectError != null && _ctrl.info == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('连接失败')),
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.error_outline,
                    size: 56, color: Colors.redAccent),
                const SizedBox(height: 16),
                Text(_connectError!, textAlign: TextAlign.center),
                const SizedBox(height: 24),
                FilledButton(
                  onPressed: () => Navigator.of(context).pop(),
                  child: const Text('返回'),
                ),
              ],
            ),
          ),
        ),
      );
    }

    final info = _ctrl.info;
    final remaining = info == null || info.expiresAt == null
        ? null
        : Duration(
            milliseconds:
                info.expiresAt! - DateTime.now().millisecondsSinceEpoch);

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(widget.roomCode, style: const TextStyle(fontSize: 16)),
            if (info != null)
              Text(
                '${info.currentMembers}/${info.maxMembers} 人'
                '${info.roomType == 'persistent' ? '  ·  长期' : remaining != null && remaining.inSeconds > 0 ? '  ·  剩余 ${_fmtDuration(remaining)}' : ''}',
                style: const TextStyle(fontSize: 12, color: Colors.grey),
              ),
          ],
        ),
        actions: [
          IconButton(
            onPressed: _exportArchive,
            icon: const Icon(Icons.archive_outlined),
            tooltip: '导出 .ephem',
          ),
        ],
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => Navigator.of(context).pop(),
        ),
      ),
      body: Column(
        children: [
          // 消息列表
          Expanded(
            child: ListView.builder(
              controller: _scrollCtrl,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              itemCount: _messages.length + (_historyHasMore ? 1 : 0),
              itemBuilder: (_, i) {
                if (_historyHasMore && i == 0) {
                  return Center(
                    child: TextButton.icon(
                      onPressed: _historyLoading ? null : _loadOlderHistory,
                      icon: _historyLoading
                          ? const SizedBox(
                              width: 14,
                              height: 14,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.expand_less),
                      label: Text(_historyLoading ? '加载中…' : '加载更早记录'),
                    ),
                  );
                }
                final offset = _historyHasMore ? 1 : 0;
                return _buildLine(_messages[i - offset]);
              },
            ),
          ),
          // 输入栏
          Container(
            padding: EdgeInsets.only(
              left: 12,
              right: 12,
              top: 8,
              bottom: MediaQuery.of(context).padding.bottom + 8,
            ),
            decoration: BoxDecoration(
              color: Theme.of(context)
                  .colorScheme
                  .surfaceContainerHighest
                  .withAlpha(80),
              border: const Border(
                top: BorderSide(color: Colors.white12),
              ),
            ),
            child: Row(
              children: [
                IconButton(
                  onPressed: _roomClosing ? null : _pickAndSendImage,
                  icon: const Icon(Icons.add_photo_alternate_outlined),
                  tooltip: '发送图片',
                ),
                const SizedBox(width: 4),
                Expanded(
                  child: TextField(
                    controller: _inputCtrl,
                    minLines: 1,
                    maxLines: 4,
                    enabled: !_roomClosing,
                    decoration: InputDecoration(
                      hintText: _roomClosing ? '房间即将关闭…' : '输入消息…',
                      isDense: true,
                      contentPadding: const EdgeInsets.symmetric(
                          horizontal: 12, vertical: 8),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(20),
                        borderSide: BorderSide.none,
                      ),
                      filled: true,
                      fillColor: Theme.of(context).colorScheme.surface,
                    ),
                    onSubmitted: (_) => _send(),
                  ),
                ),
                const SizedBox(width: 8),
                IconButton.filled(
                  onPressed: _roomClosing ? null : _send,
                  icon: const Icon(Icons.send),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildLine(_ChatLine line) {
    if (line.isSystem) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Center(
          child: Text(
            line.text,
            style: const TextStyle(color: Colors.amber, fontSize: 12),
          ),
        ),
      );
    }
    if (line.image != null) {
      return _buildImageLine(line);
    }
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        mainAxisAlignment:
            line.self ? MainAxisAlignment.end : MainAxisAlignment.start,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Flexible(
            child: Container(
              constraints: BoxConstraints(
                maxWidth: MediaQuery.of(context).size.width * 0.75,
              ),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                color: line.self
                    ? Theme.of(context).colorScheme.primaryContainer
                    : Theme.of(context).colorScheme.surfaceContainerHighest,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (!line.self)
                    Text(
                      line.from ?? '',
                      style: TextStyle(
                        fontSize: 12,
                        color: Theme.of(context).colorScheme.secondary,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  Text(line.text),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildImageLine(_ChatLine line) {
    final image = line.image!;
    final preview = image.previewBytes();
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        mainAxisAlignment:
            line.self ? MainAxisAlignment.end : MainAxisAlignment.start,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Flexible(
            child: Container(
              constraints: BoxConstraints(
                maxWidth: MediaQuery.of(context).size.width * 0.75,
              ),
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: line.self
                    ? Theme.of(context).colorScheme.primaryContainer
                    : Theme.of(context).colorScheme.surfaceContainerHighest,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (!line.self)
                    Text(
                      line.from ?? '',
                      style: TextStyle(
                        fontSize: 12,
                        color: Theme.of(context).colorScheme.secondary,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ClipRRect(
                    borderRadius: BorderRadius.circular(8),
                    child: InkWell(
                      onTap: () => _showImage(image),
                      child: Image.memory(
                        preview,
                        fit: BoxFit.cover,
                        gaplessPlayback: true,
                      ),
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    imageSummary(image),
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  void _showImage(EphemImageMessage image) {
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => Scaffold(
          appBar: AppBar(title: Text(image.name ?? '图片')),
          backgroundColor: Colors.black,
          body: Center(
            child: InteractiveViewer(
              minScale: 0.5,
              maxScale: 5,
              child: Image.memory(
                image.fullBytes(),
                fit: BoxFit.contain,
              ),
            ),
          ),
        ),
      ),
    );
  }

  String _fmtDuration(Duration d) {
    final h = d.inHours;
    final m = d.inMinutes.remainder(60);
    final s = d.inSeconds.remainder(60);
    return '${h.toString().padLeft(2, '0')}:'
        '${m.toString().padLeft(2, '0')}:'
        '${s.toString().padLeft(2, '0')}';
  }
}

class _ChatLine {
  final bool isSystem;
  final String? from;
  final String text;
  final EphemImageMessage? image;
  final bool self;

  _ChatLine.system(this.text)
      : isSystem = true,
        from = null,
        image = null,
        self = false;
  _ChatLine.msg(this.from, this.text, this.self)
      : isSystem = false,
        image = null;
  _ChatLine.image(this.from, this.image, this.self)
      : isSystem = false,
        text = '';
}
