import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../protocol/ephem_message.dart';

class ArchiveMessage {
  final String kind;
  final String from;
  final String? text;
  final EphemImageMessage? image;
  final bool mine;
  final int timestamp;

  const ArchiveMessage.text({
    required this.from,
    required this.text,
    required this.mine,
    required this.timestamp,
  })  : kind = 'text',
        image = null;

  const ArchiveMessage.image({
    required this.from,
    required this.image,
    required this.mine,
    required this.timestamp,
  })  : kind = 'image',
        text = null;

  factory ArchiveMessage.fromJson(Map<String, dynamic> json) {
    final kind = json['kind']?.toString() ?? 'text';
    if (kind == 'image') {
      return ArchiveMessage.image(
        from: json['from']?.toString() ?? '未知',
        mine: json['mine'] == true,
        timestamp: (json['timestamp'] as num?)?.toInt() ?? 0,
        image: EphemImageMessage.fromJson(
            json['image'] as Map<String, dynamic>? ?? const {}),
      );
    }
    return ArchiveMessage.text(
      from: json['from']?.toString() ?? '未知',
      text: json['text']?.toString() ?? '',
      mine: json['mine'] == true,
      timestamp: (json['timestamp'] as num?)?.toInt() ?? 0,
    );
  }

  Map<String, dynamic> toJson() => {
        'kind': kind,
        'from': from,
        'mine': mine,
        'timestamp': timestamp,
        if (text != null) 'text': text,
        if (image != null) 'image': image!.toJson(),
      };
}

class EphemArchive {
  final String title;
  final String roomCode;
  final int exportedAt;
  final List<ArchiveMessage> messages;

  const EphemArchive({
    required this.title,
    required this.roomCode,
    required this.exportedAt,
    required this.messages,
  });

  factory EphemArchive.fromJson(Map<String, dynamic> json) {
    final messages = json['messages'];
    return EphemArchive(
      title: json['title']?.toString() ?? 'Ephem 记录',
      roomCode: json['roomCode']?.toString() ?? '',
      exportedAt: (json['exportedAt'] as num?)?.toInt() ??
          DateTime.now().millisecondsSinceEpoch,
      messages: messages is List
          ? messages
              .whereType<Map<String, dynamic>>()
              .map(ArchiveMessage.fromJson)
              .toList()
          : const [],
    );
  }

  Map<String, dynamic> toJson() => {
        'format': 'ephem.archive',
        'version': 1,
        'title': title,
        'roomCode': roomCode,
        'exportedAt': exportedAt,
        'messages': messages.map((message) => message.toJson()).toList(),
      };
}

class ArchiveService {
  static const _kArchives = 'ephem.archives';

  Future<List<EphemArchive>> listArchives() async {
    final raw = (await SharedPreferences.getInstance()).getString(_kArchives);
    if (raw == null || raw.isEmpty) return [];
    try {
      final list = jsonDecode(raw) as List<dynamic>;
      return list
          .whereType<Map<String, dynamic>>()
          .map(EphemArchive.fromJson)
          .toList();
    } catch (_) {
      return [];
    }
  }

  Future<void> saveArchive(EphemArchive archive) async {
    final archives = await listArchives();
    final next = [
      archive,
      ...archives.where((item) => item.exportedAt != archive.exportedAt),
    ].take(20).toList();
    await _write(next);
  }

  Future<void> deleteArchive(int exportedAt) async {
    await _write((await listArchives())
        .where((archive) => archive.exportedAt != exportedAt)
        .toList());
  }

  Future<void> exportArchive(EphemArchive archive) async {
    await saveArchive(archive);
    final path = await FilePicker.platform.saveFile(
      dialogTitle: '导出 Ephem 记录',
      fileName: '${archive.roomCode}-${archive.exportedAt}.ephem',
      type: FileType.custom,
      allowedExtensions: ['ephem'],
    );
    if (path == null) return;
    await File(path).writeAsBytes(encodeArchive(archive), flush: true);
  }

  Future<EphemArchive?> importArchive() async {
    final result = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: ['ephem'],
      withData: true,
    );
    final file = result?.files.single;
    final bytes = file?.bytes ??
        (file?.path == null ? null : await File(file!.path!).readAsBytes());
    if (bytes == null) return null;
    final archive = decodeArchive(Uint8List.fromList(bytes));
    await saveArchive(archive);
    return archive;
  }

  Uint8List encodeArchive(EphemArchive archive) {
    final jsonBytes = utf8.encode(jsonEncode(archive.toJson()));
    return Uint8List.fromList(gzip.encode(jsonBytes));
  }

  EphemArchive decodeArchive(Uint8List bytes) {
    List<int> jsonBytes;
    try {
      jsonBytes = gzip.decode(bytes);
    } catch (_) {
      jsonBytes = bytes;
    }
    final json = jsonDecode(utf8.decode(jsonBytes)) as Map<String, dynamic>;
    if (json['format'] != 'ephem.archive') {
      throw const FormatException('不是有效的 .ephem 文件');
    }
    return EphemArchive.fromJson(json);
  }

  Future<void> _write(List<EphemArchive> archives) async {
    await (await SharedPreferences.getInstance()).setString(
      _kArchives,
      jsonEncode(archives.map((archive) => archive.toJson()).toList()),
    );
  }
}
