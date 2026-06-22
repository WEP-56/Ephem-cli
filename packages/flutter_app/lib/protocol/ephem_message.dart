import 'dart:convert';
import 'dart:typed_data';

import 'package:image/image.dart' as img;

const int imageMaxBytes = 1024 * 1024;
const int imageMaxEdge = 1600;
const int thumbMaxEdge = 360;

sealed class EphemMessage {
  const EphemMessage();
}

class EphemTextMessage extends EphemMessage {
  final String text;
  final bool structured;

  const EphemTextMessage(this.text, {this.structured = true});
}

class EphemImageMessage extends EphemMessage {
  final String mime;
  final String? name;
  final int size;
  final int? width;
  final int? height;
  final String data;
  final EphemImageThumb? thumb;

  const EphemImageMessage({
    required this.mime,
    required this.size,
    required this.data,
    this.name,
    this.width,
    this.height,
    this.thumb,
  });

  Uint8List previewBytes() => base64Decode(thumb?.data ?? data);
  String previewMime() => thumb?.mime ?? mime;
}

class EphemImageThumb {
  final String mime;
  final int width;
  final int height;
  final String data;

  const EphemImageThumb({
    required this.mime,
    required this.width,
    required this.height,
    required this.data,
  });
}

String encodeTextMessage(String text) => jsonEncode({
      'v': 1,
      'kind': 'text',
      'text': text,
    });

String encodeImageMessage(EphemImageMessage image) => jsonEncode({
      'v': 1,
      'kind': 'image',
      'mime': image.mime,
      if (image.name != null) 'name': image.name,
      'size': image.size,
      if (image.width != null) 'width': image.width,
      if (image.height != null) 'height': image.height,
      'data': image.data,
      if (image.thumb != null)
        'thumb': {
          'mime': image.thumb!.mime,
          'width': image.thumb!.width,
          'height': image.thumb!.height,
          'data': image.thumb!.data,
        },
    });

EphemMessage parsePlaintextMessage(String plaintext) {
  try {
    final decoded = jsonDecode(plaintext);
    if (decoded is Map<String, dynamic> &&
        decoded['v'] == 1 &&
        decoded['kind'] == 'text' &&
        decoded['text'] is String) {
      return EphemTextMessage(decoded['text'] as String);
    }
    if (decoded is Map<String, dynamic> &&
        decoded['v'] == 1 &&
        decoded['kind'] == 'image' &&
        decoded['mime'] is String &&
        decoded['size'] is num &&
        decoded['data'] is String) {
      final thumb = decoded['thumb'];
      return EphemImageMessage(
        mime: decoded['mime'] as String,
        name: decoded['name'] is String ? decoded['name'] as String : null,
        size: (decoded['size'] as num).toInt(),
        width:
            decoded['width'] is num ? (decoded['width'] as num).toInt() : null,
        height: decoded['height'] is num
            ? (decoded['height'] as num).toInt()
            : null,
        data: decoded['data'] as String,
        thumb: thumb is Map<String, dynamic> &&
                thumb['mime'] is String &&
                thumb['width'] is num &&
                thumb['height'] is num &&
                thumb['data'] is String
            ? EphemImageThumb(
                mime: thumb['mime'] as String,
                width: (thumb['width'] as num).toInt(),
                height: (thumb['height'] as num).toInt(),
                data: thumb['data'] as String,
              )
            : null,
      );
    }
  } catch (_) {
    // Old clients encrypt plain text directly.
  }
  return EphemTextMessage(plaintext, structured: false);
}

Future<EphemImageMessage> prepareImageMessage({
  required Uint8List bytes,
  required String? fileName,
}) async {
  final decoded = img.decodeImage(bytes);
  if (decoded == null) {
    throw const FormatException('无法解析图片');
  }

  final resized = _resizeImage(decoded, imageMaxEdge);
  var encoded = Uint8List.fromList(img.encodeJpg(resized, quality: 84));
  if (encoded.length > imageMaxBytes) {
    encoded = Uint8List.fromList(img.encodeJpg(resized, quality: 72));
  }
  if (encoded.length > imageMaxBytes) {
    throw FormatException('图片压缩后仍超过 ${formatBytes(imageMaxBytes)}');
  }

  final thumb = _resizeImage(decoded, thumbMaxEdge);
  final thumbBytes = Uint8List.fromList(img.encodeJpg(thumb, quality: 76));

  return EphemImageMessage(
    mime: 'image/jpeg',
    name: fileName,
    size: encoded.length,
    width: resized.width,
    height: resized.height,
    data: base64Encode(encoded),
    thumb: EphemImageThumb(
      mime: 'image/jpeg',
      width: thumb.width,
      height: thumb.height,
      data: base64Encode(thumbBytes),
    ),
  );
}

String imageSummary(EphemImageMessage image) {
  final name =
      image.name == null || image.name!.isEmpty ? '' : '${image.name} · ';
  final dimensions = image.width != null && image.height != null
      ? ' · ${image.width}x${image.height}'
      : '';
  return '[图片 $name${formatBytes(image.size)} · ${image.mime}$dimensions]';
}

String formatBytes(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) {
    final kb = bytes / 1024;
    return '${kb.toStringAsFixed(bytes < 10 * 1024 ? 1 : 0)} KB';
  }
  return '${(bytes / 1024 / 1024).toStringAsFixed(2)} MB';
}

img.Image _resizeImage(img.Image source, int maxEdge) {
  final longest = source.width > source.height ? source.width : source.height;
  if (longest <= maxEdge) return source;
  if (source.width >= source.height) {
    return img.copyResize(source, width: maxEdge);
  }
  return img.copyResize(source, height: maxEdge);
}
