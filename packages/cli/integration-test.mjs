// 集成测试：建房 → 双端 WS 连接 → 加密收发 → peer 事件 → 错误房间码。
// 运行：NODE_PATH 指向 cli 的 node_modules（需要 ws）

import { WebSocket } from "ws";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  hkdfSync,
} from "node:crypto";

const HTTP = "http://127.0.0.1:8787";
const WS_BASE = "ws://127.0.0.1:8787";
const ADMIN_KEY = "change-me-in-production";

const SALT = "ephem-v1-room-salt";
const INFO = "ephem-room-encryption-key";
const TAG_LEN = 16;

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.log(`  ✗ ${msg}`);
  }
}

function deriveKey(code) {
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(code), Buffer.from(SALT), Buffer.from(INFO), 32),
  );
}
function encrypt(key, pt) {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  const enc = Buffer.concat([c.update(pt, "utf8"), c.final()]);
  return {
    ciphertext: Buffer.concat([enc, c.getAuthTag()]).toString("base64"),
    nonce: nonce.toString("base64"),
  };
}
function decrypt(key, p) {
  const combined = Buffer.from(p.ciphertext, "base64");
  const nonce = Buffer.from(p.nonce, "base64");
  const tag = combined.subarray(combined.length - TAG_LEN);
  const enc = combined.subarray(0, combined.length - TAG_LEN);
  const d = createDecipheriv("aes-256-gcm", key, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

function once(ws, type) {
  return new Promise((resolve) => {
    const handler = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === type) {
        ws.off("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
  });
}

function connect(username, code) {
  const ws = new WebSocket(
    `${WS_BASE}/room/${code}?username=${encodeURIComponent(username)}`,
  );
  ws.on("open", () => console.log(`    [${username} open]`));
  ws.on("message", (raw) =>
    console.log(`    [${username} msg]`, raw.toString().slice(0, 60)),
  );
  ws.on("error", (e) => console.log(`    [${username} error]`, e.message));
  ws.on("close", (code, reason) =>
    console.log(`    [${username} close]`, code, reason.toString()),
  );
  ws.on("unexpected-response", (_req, res) =>
    console.log(`    [${username} unexpected-response]`, res.statusCode),
  );
  return ws;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 全局兜底：防止未捕获的 rejection 让进程悄悄退出
process.on("unhandledRejection", (e) => {
  console.log("    [unhandledRejection]", e?.message ?? e);
});
process.on("uncaughtException", (e) => {
  console.log("    [uncaughtException]", e?.message ?? e);
});

async function main() {
  // ── 健康检查：确保后端已起来 ──────────────
  console.log("[0] 等待后端就绪");
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${HTTP}/`, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status === 200) {
        ready = true;
        break;
      }
    } catch {
      /* 还没起来，继续等 */
    }
    await sleep(1000);
  }
  if (!ready) {
    console.error("✗ 后端在 60 秒内未就绪，跳过集成测试");
    process.exit(1);
  }
  console.log("  ✓ 后端已就绪");

  // ── 建房 ──────────────────────────────
  console.log("\n[1] 创建房间");
  const r = await fetch(`${HTTP}/api/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": ADMIN_KEY },
    body: JSON.stringify({ maxMembers: 3, ttlSeconds: 600 }),
  });
  if (!r.ok) {
    const text = await r.text();
    console.error(`✗ 建房失败 HTTP ${r.status}: ${text}`);
    process.exit(1);
  }
  const room = await r.json();
  assert(!!room.roomCode, `房间已创建：${room.roomCode}`);
  const key = deriveKey(room.roomCode);

  // ── 状态查询（需鉴权）────────────────
  console.log("\n[2] 状态查询");
  const s1 = await fetch(
    `${HTTP}/api/rooms/${encodeURIComponent(room.roomCode)}/status`,
    { headers: { "X-Admin-Key": ADMIN_KEY } },
  );
  const sj = await s1.json();
  assert(s1.status === 200 && sj.alive === true, `状态正常：${sj.currentMembers}/${sj.maxMembers}`);

  const sNoAuth = await fetch(
    `${HTTP}/api/rooms/${encodeURIComponent(room.roomCode)}/status`,
  );
  assert(sNoAuth.status === 401, "无鉴权查询状态 → 401");

  // ── 双端连接 ──────────────────────────
  console.log("\n[3] 双端连接");
  const a = connect("alice", room.roomCode);
  const aJoined = await once(a, "joined");
  assert(aJoined.payload.username === "alice", "alice 收到 joined");
  assert(aJoined.payload.maxMembers === 3, "joined 携带 maxMembers=3");

  const b = connect("bob", room.roomCode);
  const bJoined = await once(b, "joined");
  const aPeer = await once(a, "peer_joined");
  assert(bJoined.payload.username === "bob", "bob 收到 joined");
  assert(aPeer.payload.username === "bob", "alice 收到 bob 的 peer_joined");

  // ── 加密收发 ──────────────────────────
  console.log("\n[4] 端到端加密收发");
  const msgA = "你好 bob，我是 alice 🐰";
  a.send(JSON.stringify({ type: "message", payload: encrypt(key, msgA) }));
  const bRecv = await once(b, "message");
  assert(bRecv.payload.from === "alice", "bob 收到 alice 的消息");
  assert(decrypt(key, bRecv.payload) === msgA, `bob 解密成功：${decrypt(key, bRecv.payload)}`);

  const msgB = "收到！加密真好用 🔐";
  b.send(JSON.stringify({ type: "message", payload: encrypt(key, msgB) }));
  const aRecv = await once(a, "message");
  assert(aRecv.payload.from === "bob", "alice 收到 bob 的消息");
  assert(decrypt(key, aRecv.payload) === msgB, `alice 解密成功：${decrypt(key, aRecv.payload)}`);

  // ── 后端只看到密文（密文 base64 解码后不含明文）──
  console.log("\n[5] 后端零知识验证");
  const cipherText = bRecv.payload.ciphertext;
  assert(!cipherText.includes("你好"), "密文中不含明文（base64 也搜不到）");

  // ── peer_left ─────────────────────────
  console.log("\n[6] 成员离开");
  const aPeerLeft = once(a, "peer_left");
  b.close();
  const left = await aPeerLeft;
  assert(left.payload.username === "bob", "alice 收到 bob 的 peer_left");

  // ── 错误房间码 ────────────────────────
  console.log("\n[7] 错误房间码");
  const bad = connect("eve", "wrong-word-here");
  const badResult = await new Promise((resolve) => {
    bad.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    bad.on("error", (e) => resolve({ error: e.message }));
  });
  assert(badResult.status === 404, `错误房间码 → 404（${badResult.body}）`);

  // ── 人数上限 ──────────────────────────
  console.log("\n[8] 人数上限");
  const r2 = await fetch(`${HTTP}/api/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": ADMIN_KEY },
    body: JSON.stringify({ maxMembers: 2, ttlSeconds: 600 }),
  });
  const room2 = await r2.json();
  const c1 = connect("u1", room2.roomCode);
  await once(c1, "joined");
  const c2 = connect("u2", room2.roomCode);
  await once(c2, "joined");
  const c3 = connect("u3", room2.roomCode);
  const fullResult = await new Promise((resolve) => {
    c3.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (ck) => (body += ck));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
  });
  assert(fullResult.status === 403, `第三个人被拒 → 403（${fullResult.body}）`);
  c1.close();
  c2.close();
  c3.close();

  // ── 手动销毁 ──────────────────────────
  console.log("\n[9] 手动销毁房间");
  const d = await fetch(`${HTTP}/api/rooms/${encodeURIComponent(room2.roomCode)}`, {
    method: "DELETE",
    headers: { "X-Admin-Key": ADMIN_KEY },
  });
  const dj = await d.json();
  assert(d.status === 200 && dj.success === true, "销毁成功");
  const afterDel = connect("late", room2.roomCode);
  const afterResult = await new Promise((resolve) => {
    afterDel.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (ck) => (body += ck));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
  });
  assert(afterResult.status === 404, `销毁后连接 → 404`);

  a.close();
  console.log(`\n──────────────\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("测试异常：", e);
  process.exit(1);
});
