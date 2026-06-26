import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { ProxyConfig } from "./config.js";

export interface CreateRoomRequest {
  maxMembers: number;
  ttlSeconds: number;
}

export interface CreateRoomResponse {
  roomCode: string;
  expiresAt: number | null;
  maxMembers: number;
  ttlSeconds: number;
  roomType: "ephemeral" | "persistent";
}

export interface RoomStatusResponse {
  alive: boolean;
  currentMembers?: number;
  maxMembers?: number;
  createdAt?: number;
  expiresAt?: number;
  roomType?: "ephemeral" | "persistent";
  historyCount?: number;
  error?: string;
}

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
}

export async function createRoom(
  server: string,
  adminKey: string,
  body: CreateRoomRequest,
  proxy?: ProxyConfig,
): Promise<ApiResult<CreateRoomResponse>> {
  return apiRequest<CreateRoomResponse>(server, "/api/rooms", {
    method: "POST",
    adminKey,
    body,
    proxy,
  });
}

export async function roomStatus(
  server: string,
  adminKey: string,
  roomCode: string,
  proxy?: ProxyConfig,
): Promise<ApiResult<RoomStatusResponse>> {
  return apiRequest<RoomStatusResponse>(server, `/api/rooms/${encodeURIComponent(roomCode)}/status`, {
    method: "GET",
    adminKey,
    proxy,
  });
}

export async function destroyRoom(
  server: string,
  adminKey: string,
  roomCode: string,
  proxy?: ProxyConfig,
): Promise<ApiResult<{ success: boolean; error?: string }>> {
  return apiRequest<{ success: boolean; error?: string }>(server, `/api/rooms/${encodeURIComponent(roomCode)}`, {
    method: "DELETE",
    adminKey,
    proxy,
  });
}

export function normalizeHttpBase(server: string): string {
  let s = server.trim().replace(/\/+$/, "");
  if (s.startsWith("wss://")) s = `https://${s.slice("wss://".length)}`;
  else if (s.startsWith("ws://")) s = `http://${s.slice("ws://".length)}`;
  else if (!s.startsWith("http://") && !s.startsWith("https://")) s = `https://${s}`;
  return s;
}

async function apiRequest<T>(
  server: string,
  path: string,
  opts: {
    method: "GET" | "POST" | "DELETE";
    adminKey: string;
    body?: unknown;
    proxy?: ProxyConfig;
  },
): Promise<ApiResult<T>> {
  const url = new URL(path, `${normalizeHttpBase(server)}/`);
  const bodyText = opts.body ? JSON.stringify(opts.body) : undefined;
  const headers: Record<string, string> = {
    "X-Admin-Key": opts.adminKey,
  };
  if (bodyText) headers["Content-Type"] = "application/json";

  const useProxy = opts.proxy?.enabled && opts.proxy.url && url.protocol === "https:";
  if (!useProxy) {
    try {
      const res = await fetch(url, {
        method: opts.method,
        headers,
        body: bodyText,
      });
      return parseResponse<T>(res.status, await res.text());
    } catch (err) {
      return { ok: false, status: 0, data: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  return requestWithProxy<T>(url, opts.method, headers, bodyText, opts.proxy!.url);
}

function requestWithProxy<T>(
  url: URL,
  method: "GET" | "POST" | "DELETE",
  headers: Record<string, string>,
  bodyText: string | undefined,
  proxyUrl: string,
): Promise<ApiResult<T>> {
  return new Promise((resolve) => {
    const isHttps = url.protocol === "https:";
    const req = (isHttps ? httpsRequest : httpRequest)(
      url,
      {
        method,
        headers,
        agent: isHttps ? new HttpsProxyAgent(proxyUrl) : undefined,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => resolve(parseResponse<T>(res.statusCode ?? 0, raw)));
      },
    );
    req.on("error", (err) => resolve({ ok: false, status: 0, data: null, error: err.message }));
    if (bodyText) req.write(bodyText);
    req.end();
  });
}

function parseResponse<T>(status: number, text: string): ApiResult<T> {
  let data: T | null = null;
  try {
    data = text ? (JSON.parse(text) as T) : null;
  } catch {
    /* keep null */
  }
  const error =
    data && typeof data === "object" && "error" in data ? String((data as { error?: unknown }).error) : undefined;
  return { ok: status >= 200 && status < 300, status, data, error };
}
