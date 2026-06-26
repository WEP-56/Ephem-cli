import 'package:flutter/material.dart';

import '../protocol/ephem_message.dart';
import '../services/archive_service.dart';

class ArchivesPage extends StatefulWidget {
  const ArchivesPage({super.key});

  @override
  State<ArchivesPage> createState() => _ArchivesPageState();
}

class _ArchivesPageState extends State<ArchivesPage> {
  final _service = ArchiveService();
  List<EphemArchive> _archives = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    _archives = await _service.listArchives();
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _import() async {
    try {
      final archive = await _service.importArchive();
      if (archive != null) await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('导入失败：$e')),
      );
    }
  }

  Future<void> _delete(EphemArchive archive) async {
    await _service.deleteArchive(archive.exportedAt);
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    return Scaffold(
      appBar: AppBar(
        title: const Text('记录'),
        actions: [
          IconButton(
            onPressed: _import,
            icon: const Icon(Icons.file_upload_outlined),
            tooltip: '导入 .ephem',
          ),
        ],
      ),
      body: _archives.isEmpty
          ? const Center(child: Text('还没有导入或导出的记录'))
          : ListView.builder(
              padding: const EdgeInsets.all(12),
              itemCount: _archives.length,
              itemBuilder: (_, i) => Card(
                child: ListTile(
                  leading: const Icon(Icons.archive_outlined),
                  title: Text(_archives[i].title),
                  subtitle: Text(
                    '${_archives[i].messages.length} 条 · ${DateTime.fromMillisecondsSinceEpoch(_archives[i].exportedAt)}',
                  ),
                  onTap: () => Navigator.of(context).push(
                    MaterialPageRoute(
                      builder: (_) => ArchiveViewerPage(archive: _archives[i]),
                    ),
                  ),
                  trailing: IconButton(
                    onPressed: () => _delete(_archives[i]),
                    icon: const Icon(Icons.delete_outline),
                    tooltip: '删除',
                  ),
                ),
              ),
            ),
    );
  }
}

class ArchiveViewerPage extends StatelessWidget {
  final EphemArchive archive;

  const ArchiveViewerPage({super.key, required this.archive});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(archive.title)),
      body: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: archive.messages.length,
        itemBuilder: (_, i) {
          final message = archive.messages[i];
          if (message.kind == 'image' && message.image != null) {
            return _ArchiveImage(message: message);
          }
          return Align(
            alignment:
                message.mine ? Alignment.centerRight : Alignment.centerLeft,
            child: Container(
              margin: const EdgeInsets.symmetric(vertical: 3),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                color: message.mine
                    ? Theme.of(context).colorScheme.primaryContainer
                    : Theme.of(context).colorScheme.surfaceContainerHighest,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (!message.mine)
                    Text(
                      message.from,
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.secondary,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  Text(message.text ?? ''),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}

class _ArchiveImage extends StatelessWidget {
  final ArchiveMessage message;

  const _ArchiveImage({required this.message});

  @override
  Widget build(BuildContext context) {
    final image = message.image!;
    return Align(
      alignment: message.mine ? Alignment.centerRight : Alignment.centerLeft,
      child: InkWell(
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute(
            builder: (_) => Scaffold(
              appBar: AppBar(title: Text(image.name ?? '图片')),
              backgroundColor: Colors.black,
              body: Center(
                child: InteractiveViewer(
                  minScale: 0.5,
                  maxScale: 5,
                  child: Image.memory(image.fullBytes()),
                ),
              ),
            ),
          ),
        ),
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 3),
          constraints:
              BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.75),
          padding: const EdgeInsets.all(8),
          decoration: BoxDecoration(
            color: message.mine
                ? Theme.of(context).colorScheme.primaryContainer
                : Theme.of(context).colorScheme.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(12),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (!message.mine)
                Text(
                  message.from,
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.secondary,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: Image.memory(image.previewBytes(), fit: BoxFit.cover),
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
    );
  }
}
