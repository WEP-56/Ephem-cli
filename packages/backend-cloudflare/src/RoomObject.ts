// RoomObject —— 每个房间一个 Durable Object 实例。
// 职责：管理房间元数据、处理 WebSocket 连接、原样转发密文（不解密）、
//       临时房按 TTL 自毁，长期房可保存轻量文本密文历史。
//
// 安全要点：
//   - 持久化只存 RoomMeta（含 roomCodeHash），不存明文房间码。
//   - 长期房历史只存客户端标记为 persist 的小体积密文消息，不保存图片。
//   - 销毁时 deleteAll() + deleteAlarm()，状态彻底清空。

import { RateLimiter } from "./rateLimit";

/** 持久化的房间元数据（DO storage 里的 'meta' 键）。 */
export interface RoomMeta {
  roomCodeHash: string;
  roomType: RoomType;
  maxMembers: number;
  createdAt: number;
  expiresAt: number | null;
}

export type RoomType = "ephemeral" | "persistent";

interface HistoryEntry {
  id: string;
  from: string;
  ciphertext: string;
  nonce: string;
  timestamp: number;
}

/** 房间内存中的活跃连接。 */
interface Session {
  username: string;
  ws: WebSocket;
  joinedAt: number;
  clientId?: string;
  lastSeen: number;
}

export type CloseReason = "ttl_expired" | "empty" | "manual";

/** 单 IP 每分钟最多连接尝试次数（防止单房间码被暴力枚举）。 */
const RATE_LIMIT_MAX = 15;
const RATE_LIMIT_WINDOW_MS = 60_000;
/** 房间人数硬上限，避免管理员设置过大值。 */
const HARD_MAX_MEMBERS = 32;
/** 用户名最大长度。 */
const MAX_USERNAME_LEN = 32;
/** 单条客户端 JSON 文本帧上限。图片首版内联传输，限制可避免异常大帧压垮 DO。 */
const MAX_CLIENT_FRAME_BYTES = 8 * 1024 * 1024;
/** 长期房历史只保存轻量文本密文，避免图片或异常大消息进入 DO storage。 */
const MAX_HISTORY_CIPHERTEXT_CHARS = 16 * 1024;
const HISTORY_PREFIX = "history:";
const HISTORY_DEFAULT_LIMIT = 50;
const HISTORY_MAX_LIMIT = 100;
const STALE_SESSION_MS = 70_000;
const CLIENT_ID_MAX_LEN = 80;

/** 服务端 → 客户端 消息类型 */
type ServerMessage =
  | { type: "joined"; payload: { username: string; currentMembers: number; maxMembers: number; expiresAt: number | null; roomType: RoomType } }
  | { type: "history"; payload: { messages: HistoryEntry[]; before?: string | null; hasMore: boolean } }
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
    let body: { maxMembers?: number; ttlSeconds?: number; roomCodeHash?: string; roomType?: RoomType };
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
    const roomType: RoomType = body.roomType === "persistent" ? "persistent" : "ephemeral";
    const ttlSeconds = roomType === "persistent" ? 0 : clamp(body.ttlSeconds ?? 3600, 60, 24 * 3600);
    const meta: RoomMeta = {
      roomCodeHash: body.roomCodeHash,
      roomType,
      maxMembers,
      createdAt: now,
      expiresAt: roomType === "persistent" ? null : now + ttlSeconds * 1000,
    };

    await this.state.blockConcurrencyWhile(async () => {
      await this.state.storage.put("meta", meta);
      if (meta.expiresAt) await this.state.storage.setAlarm(meta.expiresAt);
    });

    return json({ ok: true, expiresAt: meta.expiresAt, roomType: meta.roomType });
  }

  // ─── 状态查询 ─────────────────────────────────────────────────
  private async handleStatus(): Promise<Response> {
    const meta = await this.state.storage.get<RoomMeta>("meta");
    if (!meta) return json({ alive: false, error: "not_found" }, 404);
    const roomType = meta.roomType ?? "ephemeral";
    const expiresAt = meta.expiresAt ?? null;
    this.pruneStaleSessions(meta);
    const alive = roomType === "persistent" || (expiresAt !== null && Date.now() < expiresAt);
    return json({
      alive,
      roomType,
      currentMembers: this.sessions.size,
      maxMembers: meta.maxMembers,
      createdAt: meta.createdAt,
      expiresAt,
      historyCount: roomType === "persistent" ? await this.historyCount() : 0,
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
    const roomType = meta.roomType ?? "ephemeral";
    const expiresAt = meta.expiresAt ?? null;
    if (expiresAt !== null && Date.now() >= expiresAt) {
      return json({ error: "room_expired", message: "房间已过期" }, 410);
    }

    const username =
      (url.searchParams.get("username") ?? "匿名").trim().slice(0, MAX_USERNAME_LEN) ||
      "匿名";
    const clientId = sanitizeClientId(url.searchParams.get("clientId"));

    this.pruneStaleSessions(meta);
    if (clientId) this.replaceExistingClient(clientId);
    if (this.sessions.size >= meta.maxMembers) {
      return json({ error: "room_full", message: "房间人数已满" }, 403);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const session: Session = { username, ws: server, joinedAt: Date.now(), clientId, lastSeen: Date.now() };
    this.sessions.set(server, session);
    server.accept();

    // 先注册事件监听，再返回 Response；
    // 首条 joined / peer_joined 用 setTimeout(0) 延迟到握手彻底建立后发送，
    // 避免并发连接时首条消息丢失（workerd 已知时序问题）。
    server.addEventListener("message", (event) => this.onMessage(server, event));
    server.addEventListener("close", () => this.onClose(server, meta));
    server.addEventListener("error", () => this.onClose(server, meta));

    setTimeout(async () => {
      this.send(server, {
        type: "joined",
        payload: {
          username,
          currentMembers: this.sessions.size,
          maxMembers: meta.maxMembers,
          expiresAt,
          roomType,
        },
      });
      if (roomType === "persistent") {
        await this.sendHistory(server, null, HISTORY_DEFAULT_LIMIT);
      }
      this.broadcast({ type: "peer_joined", payload: { username } }, server);
      this.rescheduleAlarm(meta);
    }, 0);

    return new Response(null, { status: 101, webSocket: client });
  }

  // ─── 消息处理：原样转发密文 ───────────────────────────────────
  private onMessage(ws: WebSocket, event: MessageEvent) {
    let msg: { type?: string; payload?: { ciphertext?: string; nonce?: string; persist?: boolean; before?: string; limit?: number } };
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
      session.lastSeen = Date.now();
      const outgoing = {
        from: session.username,
        ciphertext: msg.payload?.ciphertext ?? "",
        nonce: msg.payload?.nonce ?? "",
        timestamp: Date.now(),
      };
      void this.maybePersistHistory(outgoing, msg.payload?.persist === true);
      // 后端不解密、不校验内容，只补一个时间戳并转发给其他成员
      this.broadcast(
        {
          type: "message",
          payload: outgoing,
        },
        ws,
      );
    }
    if (msg.type === "history_request") {
      const session = this.sessions.get(ws);
      if (session) session.lastSeen = Date.now();
      const limit = clamp(msg.payload?.limit ?? HISTORY_DEFAULT_LIMIT, 1, HISTORY_MAX_LIMIT);
      void this.sendHistory(ws, msg.payload?.before, limit);
    }
    if (msg.type === "ping") {
      const session = this.sessions.get(ws);
      if (session) session.lastSeen = Date.now();
    }
  }

  // ─── 连接关闭 ─────────────────────────────────────────────────
  private onClose(ws: WebSocket, meta: RoomMeta) {
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);
    if (session) {
      this.broadcast({ type: "peer_left", payload: { username: session.username } });
    }
    if (this.sessions.size === 0) this.rescheduleAlarm(meta);
  }

  // ─── alarm：TTL 到期或空房间宽限到期 ─────────────────────────
  async alarm(): Promise<void> {
    const meta = await this.state.storage.get<RoomMeta>("meta");
    if (!meta) return;
    if ((meta.roomType ?? "ephemeral") === "persistent" || meta.expiresAt === null) return;
    if (Date.now() < meta.expiresAt) {
      await this.state.storage.setAlarm(meta.expiresAt);
      return;
    }
    await this.destroyRoom("ttl_expired");
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
    if ((meta.roomType ?? "ephemeral") === "persistent" || meta.expiresAt === null) {
      await this.state.storage.deleteAlarm();
      return;
    }
    // 临时房只按 TTL 销毁，不再因全部成员离开而提前销毁。
    await this.state.storage.setAlarm(Math.max(meta.expiresAt, Date.now() + 1000));
  }

  private async maybePersistHistory(message: Omit<HistoryEntry, "id">, persist: boolean) {
    if (!persist || message.ciphertext.length > MAX_HISTORY_CIPHERTEXT_CHARS) return;
    const meta = await this.state.storage.get<RoomMeta>("meta");
    if ((meta?.roomType ?? "ephemeral") !== "persistent") return;
    const id = `${message.timestamp.toString().padStart(13, "0")}:${crypto.randomUUID()}`;
    const entry: HistoryEntry = { id, ...message };
    await this.state.storage.put(`${HISTORY_PREFIX}${id}`, entry);
  }

  private async sendHistory(ws: WebSocket, before?: string | null, limit = HISTORY_DEFAULT_LIMIT) {
    const page = await this.getHistoryPage(before, limit);
    this.send(ws, { type: "history", payload: page });
  }

  private async getHistoryPage(before?: string | null, limit = HISTORY_DEFAULT_LIMIT): Promise<{ messages: HistoryEntry[]; before: string | null; hasMore: boolean }> {
    const items = await this.state.storage.list<HistoryEntry>({
      prefix: HISTORY_PREFIX,
      end: before ? `${HISTORY_PREFIX}${before}` : undefined,
      reverse: true,
      limit: limit + 1,
    });
    const values = [...items.values()];
    const hasMore = values.length > limit;
    const messages = values.slice(0, limit).reverse();
    return { messages, before: messages[0]?.id ?? null, hasMore };
  }

  private async historyCount(): Promise<number> {
    const items = await this.state.storage.list<HistoryEntry>({
      prefix: HISTORY_PREFIX,
      limit: HISTORY_MAX_LIMIT + 1,
    });
    return items.size;
  }

  private pruneStaleSessions(meta: RoomMeta) {
    const cutoff = Date.now() - STALE_SESSION_MS;
    for (const [ws, session] of this.sessions.entries()) {
      if (session.lastSeen >= cutoff) continue;
      this.dropSession(ws, meta, "stale");
    }
  }

  private replaceExistingClient(clientId: string) {
    for (const [ws, session] of this.sessions.entries()) {
      if (session.clientId !== clientId) continue;
      this.dropSession(ws, undefined, "replaced");
    }
  }

  private dropSession(ws: WebSocket, meta?: RoomMeta, reason = "closed") {
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);
    if (!session) return;
    try {
      ws.close(1000, reason);
    } catch {
      /* ignore */
    }
    this.broadcast({ type: "peer_left", payload: { username: session.username } });
    if (meta && this.sessions.size === 0) this.rescheduleAlarm(meta);
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

function sanitizeClientId(value: string | null): string | undefined {
  const id = value?.trim().slice(0, CLIENT_ID_MAX_LEN);
  if (!id || !/^[a-zA-Z0-9._:-]+$/.test(id)) return undefined;
  return id;
}
