import React, { useEffect, useReducer, useRef, useState } from "react";
import { readFile, stat } from "node:fs/promises";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { createRoom, destroyRoom, roomStatus } from "../adminApi.js";
import { type AppConfig, type ManagedRoomRecord, configPath, normalizeProxyUrl, rememberRoom } from "../config.js";
import type { RoomClient, JoinedInfo, ChatMessage } from "../ws/client.js";
import { deriveRoomKey } from "../crypto/deriveKey.js";
import { encrypt, decrypt } from "../crypto/cipher.js";
import {
  IMAGE_MAX_BYTES,
  detectImageMime,
  displayFileName,
  encodeImageMessage,
  encodeTextMessage,
  formatBytes,
  imageSummary,
  parseImageCommand,
  parsePlaintextMessage,
} from "../protocol/message.js";

interface Props {
  client: RoomClient;
  server: string;
  roomCode: string;
  username: string;
  joined: JoinedInfo;
  appConfig: AppConfig;
  onConfigChange: (config: AppConfig) => void;
  onExit: () => void;
}

type Line =
  | { id: number; kind: "system"; text: string; level?: "info" | "warn" | "error" }
  | { id: number; kind: "text"; from: string; text: string; self: boolean; time: string }
  | { id: number; kind: "image"; from: string; summary: string; self: boolean; time: string };

let lineId = 0;

type InputMode = "chat" | "settings" | "adminServer" | "adminPassword" | "admin";

export function ChatRoom({ client, server, roomCode, username, joined, appConfig, onConfigChange, onExit }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const roomKey = useRef(deriveRoomKey(roomCode));
  const adminKey = useRef("");

  const [lines, dispatch] = useReducer(
    (state: Line[], action: { type: "add"; line: Line } | { type: "clear" }) => {
      if (action.type === "clear") return [];
      return [...state, action.line].slice(-500);
    },
    [],
  );
  const [input, setInput] = useState("");
  const [members, setMembers] = useState(joined.currentMembers);
  const [maxMembers] = useState(joined.maxMembers);
  const [expiresAt] = useState(joined.expiresAt);
  const [remaining, setRemaining] = useState(() => Math.max(0, Math.floor((joined.expiresAt - Date.now()) / 1000)));
  const [closing, setClosing] = useState<string | null>(null);
  const [status, setStatus] = useState<"online" | "reconnecting" | "closing">("online");
  const [statusText, setStatusText] = useState("已连接");
  const [mode, setMode] = useState<InputMode>("chat");
  const [adminServer, setAdminServer] = useState(server);

  const addSystem = (text: string, level: "info" | "warn" | "error" = "info") =>
    dispatch({ type: "add", line: { id: ++lineId, kind: "system", text, level } });
  const addText = (from: string, text: string, self: boolean) =>
    dispatch({
      type: "add",
      line: { id: ++lineId, kind: "text", from, text, self, time: nowStr() },
    });
  const addImage = (from: string, summary: string, self: boolean) =>
    dispatch({
      type: "add",
      line: { id: ++lineId, kind: "image", from, summary, self, time: nowStr() },
    });

  // 订阅客户端事件
  useEffect(() => {
    addSystem(`已加入房间 ${roomCode}（${joined.currentMembers}/${joined.maxMembers} 人）`);

    const onPeerJoined = ({ username: u }: { username: string }) => {
      setMembers((m) => m + 1);
      addSystem(`${u} 加入了房间`);
    };
    const onPeerLeft = ({ username: u }: { username: string }) => {
      setMembers((m) => Math.max(0, m - 1));
      addSystem(`${u} 离开了房间`);
    };
    const onMessage = (msg: ChatMessage) => {
      try {
        const plaintext = decrypt(roomKey.current, { ciphertext: msg.ciphertext, nonce: msg.nonce });
        const parsed = parsePlaintextMessage(plaintext);
        if (parsed.kind === "image") addImage(msg.from, imageSummary(parsed), false);
        else addText(msg.from, parsed.text, false);
      } catch {
        addSystem(`收到来自 ${msg.from} 的无法解密的消息`, "warn");
      }
    };
    const onRoomClosing = ({ reason }: { reason: string }) => {
      const reasonText =
        reason === "ttl_expired" ? "房间已到期" : reason === "empty" ? "房间已空" : "房间被手动销毁";
      setStatus("closing");
      setStatusText(reasonText);
      setClosing(reasonText);
      addSystem(`房间即将关闭：${reasonText}`, "warn");
      setTimeout(() => {
        client.close();
        onExit();
        exit();
      }, 1500);
    };
    const onServerError = (info: { code: string; message: string }) => {
      addSystem(`错误：${info.message} (${info.code})`, "error");
    };
    const onReconnecting = ({ attempt, delayMs }: { attempt: number; delayMs: number }) => {
      setStatus("reconnecting");
      setStatusText(`重连 #${attempt}，${Math.ceil(delayMs / 1000)}s 后`);
      addSystem(`连接断开，准备第 ${attempt} 次重连`, "warn");
    };
    const onJoined = () => {
      setStatus("online");
      setStatusText("已连接");
    };

    client.on("joined", onJoined);
    client.on("peer_joined", onPeerJoined);
    client.on("peer_left", onPeerLeft);
    client.on("message", onMessage);
    client.on("room_closing", onRoomClosing);
    client.on("server_error", onServerError);
    client.on("reconnecting", onReconnecting);

    return () => {
      client.off("joined", onJoined);
      client.off("peer_joined", onPeerJoined);
      client.off("peer_left", onPeerLeft);
      client.off("message", onMessage);
      client.off("room_closing", onRoomClosing);
      client.off("server_error", onServerError);
      client.off("reconnecting", onReconnecting);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  // 倒计时
  useEffect(() => {
    const t = setInterval(() => {
      const r = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
      setRemaining(r);
    }, 1000);
    return () => clearInterval(t);
  }, [expiresAt]);

  // 退出时关闭连接
  useEffect(() => () => client.close(), [client]);

  useInput((input, key) => {
    if (key.ctrl && input.toLowerCase() === "l") {
      dispatch({ type: "clear" });
      addSystem("已清屏");
    }
  });

  async function handleSend(text: string) {
    const t = text.trim();
    if (mode !== "chat") {
      await handleModeInput(t);
      setInput("");
      return;
    }
    if (!t) return;
    if (await handleSlashCommand(t)) {
      setInput("");
      return;
    }
    const imagePath = parseImageCommand(t);
    if (imagePath !== null) {
      await handleImageSend(imagePath);
      setInput("");
      return;
    }
    try {
      const { ciphertext, nonce } = encrypt(roomKey.current, encodeTextMessage(t));
      client.send(ciphertext, nonce);
      addText(username, t, true);
    } catch {
      addSystem("发送失败：加密出错", "error");
    }
    setInput("");
  }

  async function handleSlashCommand(text: string): Promise<boolean> {
    const [cmd] = text.split(/\s+/, 1);
    switch (cmd.toLowerCase()) {
      case "/image":
        return false;
      case "/help":
        addSystem("命令：/image <路径>、/setting、/admin、/clear、/quit");
        return true;
      case "/clear":
        dispatch({ type: "clear" });
        addSystem("已清屏");
        return true;
      case "/quit":
      case "/exit":
        client.close();
        onExit();
        exit();
        return true;
      case "/setting":
        setMode("settings");
        addSystem(`进入设置模式。配置文件：${configPath()}`);
        addSystem("可用：show、server <地址>、username <名称>、proxy on <地址>、proxy off、clear server|username|proxy|rooms|all、exit");
        return true;
      case "/admin":
        setAdminServer(appConfig.server || server);
        setMode("adminServer");
        addSystem("进入管理模式。请确认后端地址，直接回车使用当前地址。");
        return true;
      default:
        if (cmd.startsWith("/")) {
          addSystem(`未知命令：${cmd}。输入 /help 查看命令。`, "warn");
          return true;
        }
        return false;
    }
  }

  async function handleModeInput(text: string): Promise<void> {
    if (mode === "adminServer") {
      const nextServer = text.trim() || adminServer || server;
      if (!nextServer) {
        addSystem("管理模式需要后端地址。", "error");
        return;
      }
      setAdminServer(nextServer);
      onConfigChange({ ...appConfig, server: nextServer });
      setMode("adminPassword");
      addSystem("请输入管理员密码（不会保存）。");
      return;
    }
    if (mode === "adminPassword") {
      if (!text) {
        addSystem("管理员密码不能为空。", "warn");
        return;
      }
      adminKey.current = text;
      setMode("admin");
      addSystem("管理模式已就绪。可用：create [人数] [秒]、rooms、status <房间码>、destroy <房间码>、server <地址>、exit");
      return;
    }
    if (mode === "settings") {
      handleSettingsCommand(text);
      return;
    }
    if (mode === "admin") {
      await handleAdminCommand(text);
    }
  }

  function handleSettingsCommand(text: string): void {
    const [cmd, ...rest] = text.split(/\s+/);
    const value = rest.join(" ").trim();
    switch ((cmd ?? "").toLowerCase()) {
      case "show":
        addSystem(`后端：${appConfig.server || "(未设置)"}`);
        addSystem(`用户名：${appConfig.username || "(未设置)"}`);
        addSystem(`代理：${appConfig.proxy?.enabled ? appConfig.proxy.url || "(未设置地址)" : "关闭"}`);
        addSystem(`本机管理房间记录：${appConfig.rooms?.length ?? 0} 个`);
        break;
      case "server":
        if (!value) {
          addSystem("用法：server <后端地址>", "warn");
          break;
        }
        onConfigChange({ ...appConfig, server: value });
        addSystem(`已保存后端地址：${value}`);
        break;
      case "username":
        if (!value) {
          addSystem("用法：username <名称>", "warn");
          break;
        }
        onConfigChange({ ...appConfig, username: value.slice(0, 32) });
        addSystem(`已保存用户名：${value.slice(0, 32)}`);
        break;
      case "proxy":
        if (rest[0]?.toLowerCase() === "off") {
          onConfigChange({ ...appConfig, proxy: { enabled: false, url: appConfig.proxy?.url ?? "" } });
          addSystem("代理已关闭");
        } else if (rest[0]?.toLowerCase() === "on") {
          const proxyUrl = normalizeProxyUrl(rest.slice(1).join(" "));
          if (!proxyUrl) {
            addSystem("用法：proxy on 127.0.0.1:7897", "warn");
            break;
          }
          onConfigChange({ ...appConfig, proxy: { enabled: true, url: proxyUrl } });
          addSystem(`代理已启用：${proxyUrl}`);
        } else {
          addSystem("用法：proxy on <地址> 或 proxy off", "warn");
        }
        break;
      case "clear":
        handleSettingsClear(rest[0]?.toLowerCase());
        break;
      case "exit":
      case "back":
        setMode("chat");
        addSystem("已返回聊天模式");
        break;
      default:
        addSystem("设置命令：show、server、username、proxy、clear、exit", "warn");
    }
  }

  function handleSettingsClear(target?: string): void {
    switch (target) {
      case "server":
        onConfigChange({ ...appConfig, server: undefined });
        addSystem("已清理后端地址记录");
        break;
      case "username":
        onConfigChange({ ...appConfig, username: undefined });
        addSystem("已清理用户名记录");
        break;
      case "proxy":
        onConfigChange({ ...appConfig, proxy: { enabled: false, url: "" } });
        addSystem("已清理代理设置");
        break;
      case "rooms":
        onConfigChange({ ...appConfig, rooms: [] });
        addSystem("已清理本机房间记录");
        break;
      case "all":
        onConfigChange({});
        addSystem("已清理全部本地设置");
        break;
      default:
        addSystem("用法：clear server|username|proxy|rooms|all", "warn");
    }
  }

  async function handleAdminCommand(text: string): Promise<void> {
    const [cmd, ...rest] = text.split(/\s+/);
    switch ((cmd ?? "").toLowerCase()) {
      case "create": {
        const maxMembers = Number.parseInt(rest[0] ?? "2", 10) || 2;
        const ttlSeconds = Number.parseInt(rest[1] ?? "3600", 10) || 3600;
        addSystem("正在创建房间…");
        const res = await createRoom(adminServer, adminKey.current, { maxMembers, ttlSeconds }, appConfig.proxy);
        if (!res.ok || !res.data) {
          addSystem(`创建失败：${res.error ?? res.status}`, "error");
          return;
        }
        const room: ManagedRoomRecord = {
          code: res.data.roomCode,
          createdAt: Date.now(),
          expiresAt: res.data.expiresAt,
          maxMembers: res.data.maxMembers,
          ttlSeconds: res.data.ttlSeconds,
        };
        onConfigChange(rememberRoom({ ...appConfig, server: adminServer }, room));
        addSystem(`房间已创建：${room.code}（${room.maxMembers} 人，${fmtCd(room.ttlSeconds)}）`);
        break;
      }
      case "rooms":
        await renderManagedRooms();
        break;
      case "status": {
        const code = rest[0]?.toLowerCase();
        if (!code) {
          addSystem("用法：status <房间码>", "warn");
          return;
        }
        const res = await roomStatus(adminServer, adminKey.current, code, appConfig.proxy);
        if (!res.ok || !res.data) {
          addSystem(`查询失败：${res.error ?? res.status}`, "error");
          return;
        }
        addSystem(formatStatus(code, res.data));
        break;
      }
      case "destroy": {
        const code = rest[0]?.toLowerCase();
        if (!code) {
          addSystem("用法：destroy <房间码>", "warn");
          return;
        }
        const res = await destroyRoom(adminServer, adminKey.current, code, appConfig.proxy);
        if (!res.ok || !res.data?.success) {
          addSystem(`销毁失败：${res.error ?? res.status}`, "error");
          return;
        }
        onConfigChange({ ...appConfig, rooms: (appConfig.rooms ?? []).filter((room) => room.code !== code) });
        addSystem(`房间已销毁：${code}`);
        break;
      }
      case "server":
        if (!rest[0]) {
          addSystem(`当前管理后端：${adminServer}`);
          return;
        }
        setAdminServer(rest.join(" "));
        onConfigChange({ ...appConfig, server: rest.join(" ") });
        addSystem(`管理后端已切换：${rest.join(" ")}`);
        break;
      case "exit":
      case "back":
        adminKey.current = "";
        setMode("chat");
        addSystem("已退出管理模式");
        break;
      default:
        addSystem("管理命令：create [人数] [秒]、rooms、status <房间码>、destroy <房间码>、server <地址>、exit", "warn");
    }
  }

  async function renderManagedRooms(): Promise<void> {
    const rooms = appConfig.rooms ?? [];
    if (rooms.length === 0) {
      addSystem("本机还没有管理房间记录");
      return;
    }
    addSystem(`本机记录 ${rooms.length} 个房间，正在刷新状态…`);
    const results = await Promise.all(
      rooms.map(async (room) => ({
        room,
        status: await roomStatus(adminServer, adminKey.current, room.code, appConfig.proxy),
      })),
    );
    for (const item of results) {
      addSystem(
        item.status.ok && item.status.data
          ? formatStatus(item.room.code, item.status.data)
          : `${item.room.code}：查询失败 ${item.status.error ?? item.status.status}`,
        item.status.ok ? "info" : "warn",
      );
    }
  }

  async function handleImageSend(filePath: string) {
    if (!filePath) {
      addSystem("用法：/image <图片路径>", "warn");
      return;
    }
    try {
      const info = await stat(filePath);
      if (!info.isFile()) {
        addSystem("发送失败：路径不是文件", "error");
        return;
      }
      if (info.size > IMAGE_MAX_BYTES) {
        addSystem(`发送失败：图片不能超过 ${formatBytes(IMAGE_MAX_BYTES)}，当前 ${formatBytes(info.size)}`, "error");
        return;
      }
      const bytes = await readFile(filePath);
      const name = displayFileName(filePath);
      const mime = detectImageMime(bytes, name);
      if (!mime) {
        addSystem("发送失败：仅支持 jpg/png/webp/gif 图片", "error");
        return;
      }
      const plaintext = encodeImageMessage({
        name,
        mime,
        size: bytes.length,
        data: bytes.toString("base64"),
      });
      const { ciphertext, nonce } = encrypt(roomKey.current, plaintext);
      client.send(ciphertext, nonce);
      addImage(username, imageSummary({ name, mime, size: bytes.length }), true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addSystem(`发送图片失败：${message}`, "error");
    }
  }

  // 可视区域：留出 header + 边框 + 输入区的空间
  const rows = stdout?.rows ?? 24;
  const columns = stdout?.columns ?? 80;
  const compact = rows < 18 || columns < 72;
  const visible = Math.max(4, rows - (compact ? 7 : 9));

  const cdColor = remaining < 60 ? "red" : remaining < 300 ? "yellow" : "gray";
  const statusColor = status === "online" ? "green" : status === "closing" ? "yellow" : "cyan";

  return (
    <Box flexDirection="column" height={rows}>
      <Box borderStyle={compact ? undefined : "round"} borderColor="cyan" paddingX={compact ? 0 : 1}>
        <Box flexGrow={1}>
          <Text color="cyan" bold>
            ephem
          </Text>
          <Text color="gray"> · </Text>
          <Text bold>{roomCode}</Text>
          <Text color="gray">
            {"  "}
            {members}/{maxMembers} 人
          </Text>
          <Box flexGrow={1} />
          <Text color={statusColor}>{statusText}</Text>
          <Text color="gray">  </Text>
          <Text color={cdColor}>⏳ {fmtCd(remaining)}</Text>
        </Box>
      </Box>
      <Text color="gray">
        Enter 发送 · /image &lt;路径&gt; 发图 · Ctrl+L 清屏 · Ctrl+C 退出{closing ? ` · ${closing}` : ""}
      </Text>

      <Box flexGrow={1} marginTop={1}>
        <Box
          flexDirection="column"
          flexGrow={1}
          borderStyle={compact ? undefined : "single"}
          borderColor="gray"
          paddingX={compact ? 0 : 1}
        >
          {lines.slice(-visible).map((l) =>
            l.kind === "system" ? (
              <Text key={l.id} color={systemColor(l.level)}>
                · {l.text}
              </Text>
            ) : l.kind === "image" ? (
              <MessageRow key={l.id} time={l.time} from={l.from} self={l.self} text={l.summary} image />
            ) : (
              <MessageRow key={l.id} time={l.time} from={l.from} self={l.self} text={l.text} />
            ),
          )}
        </Box>
        {!compact ? <CommandCard mode={mode} proxyEnabled={Boolean(appConfig.proxy?.enabled)} /> : null}
      </Box>

      <Box marginTop={1} borderStyle={compact ? undefined : "single"} borderColor="cyan" paddingX={compact ? 0 : 1}>
        <Text color="cyan">› </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={(value) => {
            void handleSend(value);
          }}
          placeholder={inputPlaceholder(mode, closing)}
          mask={mode === "adminPassword" ? "*" : undefined}
        />
      </Box>
    </Box>
  );
}

function CommandCard({ mode, proxyEnabled }: { mode: InputMode; proxyEnabled: boolean }) {
  const items =
    mode === "admin"
      ? ["create 2 3600", "rooms", "status <房间码>", "destroy <房间码>", "exit"]
      : mode === "settings"
        ? ["show", "server <地址>", "username <名称>", `proxy ${proxyEnabled ? "off" : "on <地址>"}`, "clear ...", "exit"]
        : mode === "adminServer"
          ? ["输入后端地址", "回车用当前值"]
          : mode === "adminPassword"
            ? ["输入管理员密码", "仅本次使用"]
            : ["/image <路径>", "/setting", "/admin", "/clear", "/quit"];
  return (
    <Box width={28} marginLeft={1} flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>
        命令
      </Text>
      {items.map((item) => (
        <Text key={item} color="gray">
          {item}
        </Text>
      ))}
    </Box>
  );
}

function inputPlaceholder(mode: InputMode, closing: string | null): string {
  if (closing) return "房间即将关闭…";
  if (mode === "settings") return "设置命令…";
  if (mode === "adminServer") return "后端地址（回车使用当前地址）…";
  if (mode === "adminPassword") return "管理员密码…";
  if (mode === "admin") return "管理命令…";
  return "输入消息…";
}

function formatStatus(code: string, status: { alive?: boolean; currentMembers?: number; maxMembers?: number; expiresAt?: number; error?: string }): string {
  if (status.error || status.alive === false) return `${code}：已结束 (${status.error ?? "dead"})`;
  const members = `${status.currentMembers ?? "?"}/${status.maxMembers ?? "?"}`;
  const left =
    typeof status.expiresAt === "number"
      ? fmtCd(Math.max(0, Math.floor((status.expiresAt - Date.now()) / 1000)))
      : "未知";
  return `${code}：活跃 ${members}，剩余 ${left}`;
}

function MessageRow({
  time,
  from,
  text,
  self,
  image = false,
}: {
  time: string;
  from: string;
  text: string;
  self: boolean;
  image?: boolean;
}) {
  const nameColor = self ? "cyan" : "white";
  return (
    <Box>
      <Text color="gray">{time} </Text>
      <Text color={nameColor} bold>
        {from}
      </Text>
      <Text color="gray"> │ </Text>
      <Text color={image ? "magenta" : nameColor}>{text}</Text>
    </Box>
  );
}

function systemColor(level?: "info" | "warn" | "error"): "gray" | "yellow" | "red" {
  if (level === "error") return "red";
  if (level === "warn") return "yellow";
  return "gray";
}

function nowStr(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function fmtCd(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
