// Worker 入口：HTTP 路由分发。
//   - /api/rooms          POST   创建房间（Admin）
//   - /api/rooms/:code/status  GET   房间状态（Admin）
//   - /api/rooms/:code    DELETE 手动销毁（Admin）
//   - /room/:code         WS     CLI 连接（升级为 WebSocket 后转发到对应 DO）
//   - 其余静态资源（/、/app.js 等）由 wrangler [assets] 自动托管 ./public

import { createRoom, destroyRoom, roomStatus, type Env } from "./admin";
import { hashRoomCode } from "./roomCode";

// Durable Object 类必须从 Worker 入口导出，绑定才能找到它
export { RoomObject } from "./RoomObject";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // ── Admin REST API ──────────────────────────────
    if (path === "/api/rooms" && request.method === "POST") {
      return createRoom(request, env);
    }

    if (path.startsWith("/api/rooms/") && path.endsWith("/status") && request.method === "GET") {
      const code = decodeURIComponent(
        path.slice("/api/rooms/".length, path.length - "/status".length),
      );
      return roomStatus(code, request, env);
    }

    if (path.startsWith("/api/rooms/") && request.method === "DELETE") {
      const code = decodeURIComponent(path.slice("/api/rooms/".length));
      return destroyRoom(code, request, env);
    }

    // ── CLI WebSocket 连接 ──────────────────────────
    if (path.startsWith("/room/") && request.headers.get("Upgrade") === "websocket") {
      const code = decodeURIComponent(path.slice("/room/".length));
      const hash = await hashRoomCode(code);
      const stub = env.ROOM.get(env.ROOM.idFromName(hash));
      // 原样转发升级请求，DO 内部完成校验与握手
      return stub.fetch(request);
    }

    // Web 聊天端入口。静态资源实际文件是 /chat.html，这里提供干净路由。
    if (path === "/chat" && request.method === "GET") {
      return Response.redirect(new URL("/chat.html", request.url).toString(), 302);
    }

    // 非 API / 非 WS 请求交给静态资源（[assets] 已托管 ./public），
    // 这里兜底处理 assets 未命中的情况
    return new Response("Not found", { status: 404 });
  },
};
