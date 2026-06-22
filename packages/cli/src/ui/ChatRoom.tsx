import React, { useEffect, useReducer, useRef, useState } from "react";
import { readFile, stat } from "node:fs/promises";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
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
  roomCode: string;
  username: string;
  joined: JoinedInfo;
  onExit: () => void;
}

type Line =
  | { id: number; kind: "system"; text: string; level?: "info" | "warn" | "error" }
  | { id: number; kind: "text"; from: string; text: string; self: boolean; time: string }
  | { id: number; kind: "image"; from: string; summary: string; self: boolean; time: string };

let lineId = 0;

export function ChatRoom({ client, roomCode, username, joined, onExit }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const roomKey = useRef(deriveRoomKey(roomCode));

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
    if (!t) return;
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

      <Box
        flexDirection="column"
        flexGrow={1}
        marginTop={1}
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

      <Box marginTop={1} borderStyle={compact ? undefined : "single"} borderColor="cyan" paddingX={compact ? 0 : 1}>
        <Text color="cyan">› </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={(value) => {
            void handleSend(value);
          }}
          placeholder={closing ? "房间即将关闭…" : "输入消息…"}
        />
      </Box>
    </Box>
  );
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
