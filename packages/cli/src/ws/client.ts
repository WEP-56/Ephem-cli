// 房间 WebSocket 客户端：连接、收发密文、心跳保活、断线指数退避重连。
// 服务端主动拒绝（房间不存在/已满/过期）时不重连，交由 UI 处理。

import { EventEmitter } from "node:events";
import WebSocket from "ws";

export interface JoinedInfo {
  username: string;
  currentMembers: number;
  maxMembers: number;
  expiresAt: number;
}

export interface ChatMessage {
  from: string;
  ciphertext: string;
  nonce: string;
  timestamp: number;
}

export type CloseReason = "ttl_expired" | "empty" | "manual";

interface ReconnectingInfo {
  attempt: number;
  delayMs: number;
}

/**
 * 事件（全部通过 on 订阅）：
 *   joined(info)          加入成功
 *   peer_joined({username})
 *   peer_left({username})
 *   message(msg)          收到一条密文消息
 *   room_closing({reason})房间即将销毁
 *   server_error({code,message}) 服务端拒绝/出错（不可恢复）
 *   reconnecting(info)    断线后准备第 N 次重连
 *   closed()              连接彻底关闭
 */
export class RoomClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private manuallyClosed = false;
  private rejectedByServer = false;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly server: string,
    private readonly roomCode: string,
    private readonly username: string,
  ) {
    super();
  }

  connect(): void {
    this.manuallyClosed = false;
    this.rejectedByServer = false;
    this.openSocket();
  }

  private openSocket(): void {
    const url = `${normalizeWs(this.server)}/room/${encodeURIComponent(this.roomCode)}?username=${encodeURIComponent(this.username)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempt = 0;
      this.startPing();
      // 真正"加入成功"由服务端 joined 消息确认；这里只表示链路通了
    });

    ws.on("message", (raw: Buffer | string) => {
      let msg: { type?: string; payload?: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.dispatch(msg);
    });

    // 服务端返回非 101 响应（房间不存在/已满/过期/限流）
    ws.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () => {
        let info = { code: `http_${res.statusCode}`, message: "连接被服务端拒绝" };
        try {
          const j = JSON.parse(body);
          if (j.error) info = { code: String(j.error), message: String(j.message ?? j.error) };
        } catch {
          /* keep default */
        }
        this.rejectedByServer = true;
        this.emit("server_error", info);
      });
    });

    ws.on("close", () => {
      this.stopPing();
      if (this.manuallyClosed || this.rejectedByServer) {
        this.emit("closed");
        return;
      }
      this.scheduleReconnect();
    });

    ws.on("error", () => {
      // 网络层错误；后续 close 会触发重连流程，这里不单独抛出
    });
  }

  private dispatch(msg: { type?: string; payload?: any }) {
    switch (msg.type) {
      case "joined":
        this.emit("joined", msg.payload as JoinedInfo);
        break;
      case "peer_joined":
        this.emit("peer_joined", msg.payload);
        break;
      case "peer_left":
        this.emit("peer_left", msg.payload);
        break;
      case "message":
        this.emit("message", msg.payload as ChatMessage);
        break;
      case "room_closing":
        this.manuallyClosed = true; // 房间销毁是终态
        this.emit("room_closing", msg.payload as { reason: CloseReason });
        break;
      case "error":
        this.emit("server_error", msg.payload);
        break;
      default:
        break;
    }
  }

  /** 发送一条已加密的消息（密文 + nonce）。 */
  send(ciphertext: string, nonce: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "message", payload: { ciphertext, nonce } }));
    }
  }

  close(): void {
    this.manuallyClosed = true;
    this.stopPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 25_000);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private scheduleReconnect(): void {
    this.reconnectAttempt += 1;
    const delayMs = Math.min(1000 * 2 ** (this.reconnectAttempt - 1), 30_000);
    this.emit("reconnecting", { attempt: this.reconnectAttempt, delayMs });
    this.reconnectTimer = setTimeout(() => this.openSocket(), delayMs);
  }
}

/** 把任意形式的地址规范化成 ws/wss 基础 URL（去尾部斜杠）。 */
function normalizeWs(server: string): string {
  let s = server.trim().replace(/\/+$/, "");
  if (s.startsWith("https://")) s = "wss://" + s.slice("https://".length);
  else if (s.startsWith("http://")) s = "ws://" + s.slice("http://".length);
  else if (!s.startsWith("ws://") && !s.startsWith("wss://")) s = "wss://" + s;
  return s;
}
