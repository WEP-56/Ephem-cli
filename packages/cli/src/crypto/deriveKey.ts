// 从房间码派生对称密钥：HKDF(SHA-256) → 32 字节 AES-256-GCM 密钥。
// 全程在客户端本地完成，房间码本身不因此通过网络发给后端。
//
// 设计说明：这是"共享密码派生密钥"模式（PAKE 的简化版）。房间码同时承担
// 路由标识和密钥种子双重职责。攻击者要验证猜测必须先连上对应房间码的 WS
// 端点，而后端对单房间码连接尝试做了限流。

import { hkdfSync } from "node:crypto";

const SALT = "ephem-v1-room-salt";
const INFO = "ephem-room-encryption-key";
const KEY_LEN = 32; // AES-256

/** 从房间码派生房间加密密钥（32 字节）。 */
export function deriveRoomKey(roomCode: string): Buffer {
  const ikm = Buffer.from(roomCode, "utf8");
  const salt = Buffer.from(SALT, "utf8");
  const info = Buffer.from(INFO, "utf8");
  // hkdfSync 在 Node 18+ 返回 Buffer
  return Buffer.from(hkdfSync("sha256", ikm, salt, info, KEY_LEN));
}
