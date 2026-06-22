import { basename } from "node:path";

export const IMAGE_MAX_BYTES = 1024 * 1024;

export type StructuredMessage =
  | { v: 1; kind: "text"; text: string }
  | {
      v: 1;
      kind: "image";
      mime: string;
      name?: string;
      size: number;
      width?: number;
      height?: number;
      data: string;
      thumb?: { mime: string; width: number; height: number; data: string };
    };

export type ParsedMessage =
  | { kind: "text"; text: string; structured: boolean }
  | { kind: "image"; mime: string; name?: string; size: number; width?: number; height?: number };

export function encodeTextMessage(text: string): string {
  return JSON.stringify({ v: 1, kind: "text", text } satisfies StructuredMessage);
}

export function encodeImageMessage(input: {
  name?: string;
  mime: string;
  size: number;
  data: string;
}): string {
  return JSON.stringify({
    v: 1,
    kind: "image",
    mime: input.mime,
    name: input.name,
    size: input.size,
    data: input.data,
  } satisfies StructuredMessage);
}

export function parsePlaintextMessage(plaintext: string): ParsedMessage {
  try {
    const msg = JSON.parse(plaintext) as Partial<StructuredMessage>;
    if (msg && msg.v === 1 && msg.kind === "text" && typeof msg.text === "string") {
      return { kind: "text", text: msg.text, structured: true };
    }
    if (
      msg &&
      msg.v === 1 &&
      msg.kind === "image" &&
      typeof msg.mime === "string" &&
      typeof msg.size === "number" &&
      typeof msg.data === "string"
    ) {
      return {
        kind: "image",
        mime: msg.mime,
        name: typeof msg.name === "string" ? msg.name : undefined,
        size: msg.size,
        width: typeof msg.width === "number" ? msg.width : undefined,
        height: typeof msg.height === "number" ? msg.height : undefined,
      };
    }
  } catch {
    // Old clients encrypt plain text directly; keep that path compatible.
  }
  return { kind: "text", text: plaintext, structured: false };
}

export function imageSummary(image: { name?: string; mime: string; size: number; width?: number; height?: number }): string {
  const name = image.name ? `${image.name} · ` : "";
  const dim = image.width && image.height ? ` · ${image.width}x${image.height}` : "";
  return `[图片 ${name}${formatBytes(image.size)} · ${image.mime}${dim}]`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function parseImageCommand(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed.toLowerCase().startsWith("/image")) return null;
  const rest = trimmed.slice("/image".length).trim();
  if (!rest) return "";
  if ((rest.startsWith('"') && rest.endsWith('"')) || (rest.startsWith("'") && rest.endsWith("'"))) {
    return rest.slice(1, -1);
  }
  return rest;
}

export function displayFileName(filePath: string): string {
  return basename(filePath) || "image";
}

export function detectImageMime(bytes: Uint8Array, fileName: string): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) return "image/gif";

  const lower = fileName.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return null;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}
