// Admin REST API 处理函数。
// 由 Worker 入口（index.ts）按路由调用。所有写操作都需要 X-Admin-Key 鉴权。

import { generateRoomCode, hashRoomCode } from "./roomCode";

export interface Env {
  ROOM: DurableObjectNamespace;
  ADMIN_PASSWORD: string;
}

const HARD_MAX_MEMBERS = 32;

/** 校验 Admin 密钥。返回 null 表示通过，否则返回 401 响应。 */
export function requireAdmin(request: Request, env: Env): Response | null {
  const key = request.headers.get("X-Admin-Key");
  if (!key || key !== env.ADMIN_PASSWORD) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}

export type RoomType = "ephemeral" | "persistent";

/** POST /api/rooms —— 创建房间。生成房间码、初始化对应 DO、设置 TTL alarm。 */
export async function createRoom(request: Request, env: Env): Promise<Response> {
  const auth = requireAdmin(request, env);
  if (auth) return auth;

  let body: { maxMembers?: number; ttlSeconds?: number; roomType?: RoomType };
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_body" }, 400);
  }

  const maxMembers = clamp(body.maxMembers ?? 2, 2, HARD_MAX_MEMBERS);
  const roomType: RoomType = body.roomType === "persistent" ? "persistent" : "ephemeral";
  const ttlSeconds = roomType === "persistent" ? 0 : clamp(body.ttlSeconds ?? 3600, 60, 24 * 3600);

  // 生成房间码，极小概率哈希冲突时换码重试
  for (let attempt = 0; attempt < 5; attempt++) {
    const roomCode = generateRoomCode();
    const hash = await hashRoomCode(roomCode);
    const stub = env.ROOM.get(env.ROOM.idFromName(hash));

    const res = await stub.fetch(
      new Request("https://do/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxMembers, ttlSeconds, roomCodeHash: hash, roomType }),
      }),
    );

    if (res.ok) {
      const data = (await res.json()) as { expiresAt: number | null; roomType: RoomType };
      return json({ roomCode, expiresAt: data.expiresAt, maxMembers, ttlSeconds, roomType: data.roomType });
    }
    if (res.status !== 409) {
      // 非冲突的内部错误
      return json({ error: "internal_error" }, 502);
    }
    // 409 = 哈希冲突，换码重试
  }
  return json({ error: "room_code_conflict" }, 503);
}

/** GET /api/rooms/:code/status —— 查询房间元信息（人数/上限/剩余时间）。仅 Admin。 */
export async function roomStatus(roomCode: string, request: Request, env: Env): Promise<Response> {
  const auth = requireAdmin(request, env);
  if (auth) return auth;

  const hash = await hashRoomCode(roomCode);
  const stub = env.ROOM.get(env.ROOM.idFromName(hash));
  const res = await stub.fetch(new Request("https://do/status", { method: "GET" }));
  return new Response(res.body, {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}

/** DELETE /api/rooms/:code —— 手动销毁房间。仅 Admin。 */
export async function destroyRoom(roomCode: string, request: Request, env: Env): Promise<Response> {
  const auth = requireAdmin(request, env);
  if (auth) return auth;

  const hash = await hashRoomCode(roomCode);
  const stub = env.ROOM.get(env.ROOM.idFromName(hash));
  const res = await stub.fetch(new Request("https://do/destroy", { method: "DELETE" }));
  return new Response(res.body, {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
