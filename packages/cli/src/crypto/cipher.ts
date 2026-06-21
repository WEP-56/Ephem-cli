// AES-256-GCM 加解密封装。
// 约定：每条消息用独立随机 12 字节 nonce；认证标签 (authTag, 16 字节) 拼在密文末尾。
// 密文与 nonce 都用 base64 编码传输（JSON 友好）。
// 后端只原样转发 { ciphertext, nonce }，不解密、不校验。

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const NONCE_LEN = 12;
const TAG_LEN = 16;

export interface EncryptedPayload {
  ciphertext: string; // base64(密文 + authTag)
  nonce: string; // base64(12 字节 nonce)
}

/** 加密一条文本消息。 */
export function encrypt(key: Buffer, plaintext: string): EncryptedPayload {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv(ALGO, key, nonce);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([enc, tag]); // authTag 拼在末尾
  return {
    ciphertext: combined.toString("base64"),
    nonce: nonce.toString("base64"),
  };
}

/** 解密一条消息。认证失败会抛错（说明密钥不对或密文被篡改）。 */
export function decrypt(key: Buffer, payload: EncryptedPayload): string {
  const combined = Buffer.from(payload.ciphertext, "base64");
  const nonce = Buffer.from(payload.nonce, "base64");
  if (combined.length < TAG_LEN + 1) {
    throw new Error("密文长度异常");
  }
  const tag = combined.subarray(combined.length - TAG_LEN);
  const enc = combined.subarray(0, combined.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, nonce);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf8");
}
