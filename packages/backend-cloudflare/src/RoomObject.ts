// RoomObject —— 每个房间一个 Durable Object 实例。
// 职责：管理房间元数据、处理 WebSocket 连接、原样转发密文（不解密、不留存）、
//       通过 alarm 实现 TTL 自毁与空房间宽限自毁。
//
// 安全要点：
//   - 持久化只存 RoomMeta（含 roomCodeHash），不存任何消息内容，不存明文房间码。
//   - 消息只做内存转发，连接关闭后无残留。
//   - 销毁时 deleteAll() + deleteAlarm()，状态彻底清空。

import { RateLimiter } from "./rateLimit";

/** 持久化的房间元数据（DO storage 里的 'meta' 键）。 */
export interface RoomMeta {
  roomCodeHash: string;
  maxMembers: number;
  createdAt: number;
  expiresAt: number;
}

/** 房间内存中的活跃连接。 */
interface Session {
  username: string;
  ws: WebSocket;
  joinedAt: number;
}

export type CloseReason = "ttl_expired" | "empty" | "manual";

/** 单 IP 每分钟最多连接尝试次数（防止单房间码被暴力枚举）。 */
const RATE_LIMIT_MAX = 15;
const RATE_LIMIT_WINDOW_MS = 60_000;
/** 房间人数硬上限，避免管理员设置过大值。 */
const HARD_MAX_MEMBERS = 32;
/** 用户名最大长度。 */
const MAX_USERNAME_LEN = 32;
/** 房间全员断开后，宽限多久再自毁（避免网络抖动误判）。 */
const EMPTY_GRACE_MS = 5 * 60 * 1000;
/** 单条客户端 JSON 文本帧上限。图片首版内联传输，限制可避免异常大帧压垮 DO。 */
const MAX_CLIENT_FRAME_BYTES = 2 * 1024 * 1024;

/** 服务端 → 客户端 消息类型 */
type ServerMessage =
  | { type: "joined"; payload: { username: string; currentMembers: number; maxMembers: number; expiresAt: number } }
  | { type: "peer_joined"; payload: { username: string } }
  | { type: "peer_left"; payload: { username: string } }
  | { type: "message"; payload: { from: string; ciphertext: string; nonce: string; timestamp: number } }
  | { type: "room_closing"; payload: { reason: CloseReason } }
  | { type: "error"; payload: { code: string; message: string } };

export class RoomObject implements DurableObject {
  private state: DurableObjectState;
  private sessions = new Map<WebSocket, Session>();
  private limiter = new RateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);

  constructor(state: DurableObjectState, _env: unknown) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    // WebSocket 连接（CLI 侧 wss://host/room/:code?username=...）
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleConnect(request);
    }

    // 内部管理操作，由 Worker 转发
    switch (request.method) {
      case "POST":
        return this.handleInit(request);
      case "GET":
        return this.handleStatus();
      case "DELETE":
        return this.handleDestroy("manual");
      default:
        return json({ error: "method_not_allowed" }, 405);
    }
  }

  // ─── 初始化（Worker 创建房间时调用） ───────────────────────────
  private async handleInit(request: Request): Promise<Response> {
    let body: { maxMembers?: number; ttlSeconds?: number; roomCodeHash?: string };
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad_body" }, 400);
    }
    if (!body.roomCodeHash) return json({ error: "missing_hash" }, 400);

    // 已初始化则拒绝（房间码哈希冲突，Worker 侧会换码重试）
    const existing = await this.state.storage.get<RoomMeta>("meta");
    if (existing) {
      return json({ error: "already_initialized" }, 409);
    }

    const now = Date.now();
    const maxMembers = clamp(body.maxMembers ?? 2, 2, HARD_MAX_MEMBERS);
    const ttlSeconds = clamp(body.ttlSeconds ?? 3600, 60, 24 * 3600);
    const meta: RoomMeta = {
      roomCodeHash: body.roomCodeHash,
      maxMembers,
      createdAt: now,
      expiresAt: now + ttlSeconds * 1000,
    };

    await this.state.blockConcurrencyWhile(async () => {
      await this.state.storage.put("meta", meta);
      await this.state.storage.setAlarm(meta.expiresAt);
    });

    return json({ ok: true, expiresAt: meta.expiresAt });
  }

  // ─── 状态查询 ─────────────────────────────────────────────────
  private async handleStatus(): Promise<Response> {
    const meta = await this.state.storage.get<RoomMeta>("meta");
    if (!meta) return json({ alive: false, error: "not_found" }, 404);
    const alive = Date.now() < meta.expiresAt;
    return json({
      alive,
      currentMembers: this.sessions.size,
      maxMembers: meta.maxMembers,
      createdAt: meta.createdAt,
      expiresAt: meta.expiresAt,
    });
  }

  // ─── 手动销毁 ─────────────────────────────────────────────────
  private async handleDestroy(reason: CloseReason): Promise<Response> {
    const meta = await this.state.storage.get<RoomMeta>("meta");
    if (!meta) return json({ success: false, error: "not_found" }, 404);
    await this.destroyRoom(reason);
    return json({ success: true });
  }

  // ─── WebSocket 连接 ───────────────────────────────────────────
  private async handleConnect(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";

    // 限流：防止单 IP 对该房间码暴力尝试
    if (!this.limiter.check(ip)) {
      return json({ error: "rate_limited", message: "连接过于频繁，请稍后再试" }, 429);
    }

    const meta = await this.state.storage.get<RoomMeta>("meta");
    if (!meta) {
      return json({ error: "room_not_found", message: "房间不存在或已销毁" }, 404);
    }
    if (Date.now() >= meta.expiresAt) {
      return json({ error: "room_expired", message: "房间已过期" }, 410);
    }
    if (this.sessions.size >= meta.maxMembers) {
      return json({ error: "room_full", message: "房间人数已满" }, 403);
    }

    const username =
      (url.searchParams.get("username") ?? "匿名").trim().slice(0, MAX_USERNAME_LEN) ||
      "匿名";

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const session: Session = { username, ws: server, joinedAt: Date.now() };
    this.sessions.set(server, session);
    server.accept();

    // 先注册事件监听，再返回 Response；
    // 首条 joined / peer_joined 用 setTimeout(0) 延迟到握手彻底建立后发送，
    // 避免并发连接时首条消息丢失（workerd 已知时序问题）。
    server.addEventListener("message", (event) => this.onMessage(server, event));
    server.addEventListener("close", () => this.onClose(server, meta));
    server.addEventListener("error", () => this.onClose(server, meta));

    setTimeout(() => {
      this.send(server, {
        type: "joined",
        payload: {
          username,
          currentMembers: this.sessions.size,
          maxMembers: meta.maxMembers,
          expiresAt: meta.expiresAt,
        },
      });
      this.broadcast({ type: "peer_joined", payload: { username } }, server);
      this.rescheduleAlarm(meta);
    }, 0);

    return new Response(null, { status: 101, webSocket: client });
  }

  // ─── 消息处理：原样转发密文 ───────────────────────────────────
  private onMessage(ws: WebSocket, event: MessageEvent) {
    let msg: { type?: string; payload?: { ciphertext?: string; nonce?: string } };
    const raw = event.data;
    if (typeof raw !== "string") {
      this.send(ws, {
        type: "error",
        payload: { code: "bad_message", message: "只支持 JSON 文本帧" },
      });
      return;
    }
    if (raw.length > MAX_CLIENT_FRAME_BYTES) {
      this.send(ws, {
        type: "error",
        payload: { code: "message_too_large", message: "消息过大" },
      });
      return;
    }
    try {
      msg = JSON.parse(raw);
    } catch {
      this.send(ws, {
        type: "error",
        payload: { code: "bad_message", message: "无法解析的消息" },
      });
      return;
    }

    if (msg.type === "message") {
      const session = this.sessions.get(ws);
      if (!session) return;
      // 后端不解密、不校验内容，只补一个时间戳并转发给其他成员
      this.broadcast(
        {
          type: "message",
          payload: {
            from: session.username,
            ciphertext: msg.payload?.ciphertext ?? "",
            nonce: msg.payload?.nonce ?? "",
            timestamp: Date.now(),
          },
        },
        ws,
      );
    }
    // ping 心跳：服务端无需回应，有流量即可保活
  }

  // ─── 连接关闭 ─────────────────────────────────────────────────
  private onClose(ws: WebSocket, meta: RoomMeta) {
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);
    if (session) {
      this.broadcast({ type: "peer_left", payload: { username: session.username } });
    }
    if (this.sessions.size === 0) {
      // 全员离开 → 进入空房间宽限倒计时
      this.rescheduleAlarm(meta);
    }
  }

  // ─── alarm：TTL 到期或空房间宽限到期 ─────────────────────────
  async alarm(): Promise<void> {
    const meta = await this.state.storage.get<RoomMeta>("meta");
    if (!meta) return;
    const reason: CloseReason = Date.now() >= meta.expiresAt ? "ttl_expired" : "empty";
    await this.destroyRoom(reason);
  }

  // ─── 销毁房间 ─────────────────────────────────────────────────
  private async destroyRoom(reason: CloseReason) {
    this.broadcast({ type: "room_closing", payload: { reason } });
    for (const { ws } of this.sessions.values()) {
      try {
        ws.close(1000, reason);
      } catch {
        /* ignore */
      }
    }
    this.sessions.clear();
    await this.state.storage.deleteAll();
    await this.state.storage.deleteAlarm();
  }

  // ─── 重新排程 alarm ───────────────────────────────────────────
  private async rescheduleAlarm(meta: RoomMeta) {
    const now = Date.now();
    const fireAt =
      this.sessions.size === 0
        ? Math.min(meta.expiresAt, now + EMPTY_GRACE_MS)
        : meta.expiresAt;
    // 确保至少 1s 后触发，避免立即销毁
    await this.state.storage.setAlarm(Math.max(fireAt, now + 1000));
  }

  // ─── 工具方法 ─────────────────────────────────────────────────
  private send(ws: WebSocket, msg: ServerMessage) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* 连接可能已关闭，忽略 */
    }
  }

  private broadcast(msg: ServerMessage, except?: WebSocket) {
    const data = JSON.stringify(msg);
    for (const { ws } of this.sessions.values()) {
      if (ws === except) continue;
      try {
        ws.send(data);
      } catch {
        /* 忽略已断开的连接 */
      }
    }
  }
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
