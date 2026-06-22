import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface ManagedRoomRecord {
  code: string;
  createdAt: number;
  expiresAt: number;
  maxMembers: number;
  ttlSeconds: number;
}

export interface ProxyConfig {
  enabled: boolean;
  url: string;
}

export interface AppConfig {
  server?: string;
  username?: string;
  proxy?: ProxyConfig;
  rooms?: ManagedRoomRecord[];
}

const CONFIG_NAME = "config.json";

export function configPath(): string {
  const base =
    process.env.EPHEM_CONFIG_DIR ||
    (process.platform === "win32" && process.env.APPDATA
      ? join(process.env.APPDATA, "ephem")
      : join(homedir(), ".config", "ephem"));
  return join(base, CONFIG_NAME);
}

export async function loadConfig(): Promise<AppConfig> {
  try {
    const raw = await readFile(configPath(), "utf8");
    const parsed = JSON.parse(raw) as AppConfig;
    return sanitizeConfig(parsed);
  } catch {
    return {};
  }
}

export async function saveConfig(config: AppConfig): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(sanitizeConfig(config), null, 2)}\n`, "utf8");
}

export function rememberRoom(config: AppConfig, room: ManagedRoomRecord): AppConfig {
  const rooms = (config.rooms ?? []).filter((item) => item.code !== room.code);
  rooms.unshift(room);
  return { ...config, rooms: rooms.slice(0, 50) };
}

export function normalizeProxyUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `http://${value}`;
}

function sanitizeConfig(config: AppConfig): AppConfig {
  return {
    server: typeof config.server === "string" ? config.server.trim() : undefined,
    username: typeof config.username === "string" ? config.username.trim().slice(0, 32) : undefined,
    proxy: {
      enabled: Boolean(config.proxy?.enabled),
      url: normalizeProxyUrl(typeof config.proxy?.url === "string" ? config.proxy.url : ""),
    },
    rooms: Array.isArray(config.rooms)
      ? config.rooms
          .filter((room) => typeof room.code === "string" && room.code.trim())
          .map((room) => ({
            code: room.code.trim().toLowerCase(),
            createdAt: Number(room.createdAt) || Date.now(),
            expiresAt: Number(room.expiresAt) || Date.now(),
            maxMembers: Number(room.maxMembers) || 2,
            ttlSeconds: Number(room.ttlSeconds) || 3600,
          }))
          .slice(0, 50)
      : [],
  };
}
