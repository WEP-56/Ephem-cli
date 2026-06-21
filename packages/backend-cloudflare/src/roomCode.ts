// 房间码生成与哈希
// 房间码 = BIP39 词表随机抽 3 个词，用 "-" 连接，例如 correct-horse-battery
// 后端只存房间码的 SHA-256 哈希，不存明文

import { WORDLIST } from "./wordlist";

/**
 * 生成一个房间码（3 个随机词）。
 * 组合空间 2048^3 ≈ 85 亿，配合后端限流和房间 TTL，足以防止暴力枚举。
 */
export function generateRoomCode(): string {
  const pick = () => WORDLIST[cryptoRandomInt(WORDLIST.length)];
  return `${pick()}-${pick()}-${pick()}`;
}

/**
 * 对房间码取 SHA-256 哈希（hex），用作 Durable Object 的 name/id。
 * 明文房间码不出现在任何持久化存储里。
 */
export async function hashRoomCode(code: string): Promise<string> {
  const data = new TextEncoder().encode(code);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bufToHex(digest);
}

/** 校验字符串是否是合法房间码格式（3 段、每段都在词表里）。 */
export function isValidRoomCodeFormat(code: string): boolean {
  const parts = code.trim().toLowerCase().split("-");
  if (parts.length !== 3) return false;
  const set = new Set(WORDLIST);
  return parts.every((p) => set.has(p));
}

function bufToHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 用 crypto.getRandomValues 生成 [0, max) 内均匀分布的随机整数（拒绝采样）。 */
function cryptoRandomInt(max: number): number {
  if (max <= 0) throw new Error("max must be positive");
  const maxUint32 = 0xffffffff;
  // 让 max 能整除的最大上界，消除取模偏差
  const limit = maxUint32 - ((maxUint32 + 1) % max);
  const buf = new Uint32Array(1);
  let r: number;
  do {
    crypto.getRandomValues(buf);
    r = buf[0];
  } while (r > limit);
  return r % max;
}
