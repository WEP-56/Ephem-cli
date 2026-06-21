import React, { useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useStdout } from "ink";
import TextInput from "ink-text-input";
import type { RoomClient, JoinedInfo, ChatMessage } from "../ws/client.js";
import { deriveRoomKey } from "../crypto/deriveKey.js";
import { encrypt, decrypt } from "../crypto/cipher.js";

interface Props {
  client: RoomClient;
  roomCode: string;
  username: string;
  joined: JoinedInfo;
  onExit: () => void;
}

type Line =
  | { id: number; kind: "system"; text: string }
  | { id: number; kind: "msg"; from: string; text: string; self: boolean; time: string };

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

  const addSystem = (text: string) =>
    dispatch({ type: "add", line: { id: ++lineId, kind: "system", text } });
  const addMsg = (from: string, text: string, self: boolean) =>
    dispatch({
      type: "add",
      line: { id: ++lineId, kind: "msg", from, text, self, time: nowStr() },
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
        const text = decrypt(roomKey.current, { ciphertext: msg.ciphertext, nonce: msg.nonce });
        addMsg(msg.from, text, false);
      } catch {
        addSystem(`收到来自 ${msg.from} 的无法解密的消息`);
      }
    };
    const onRoomClosing = ({ reason }: { reason: string }) => {
      const reasonText =
        reason === "ttl_expired" ? "房间已到期" : reason === "empty" ? "房间已空" : "房间被手动销毁";
      setClosing(reasonText);
      addSystem(`房间即将关闭：${reasonText}`);
      setTimeout(() => {
        client.close();
        onExit();
        exit();
      }, 1500);
    };
    const onServerError = (info: { code: string; message: string }) => {
      addSystem(`错误：${info.message} (${info.code})`);
    };

    client.on("peer_joined", onPeerJoined);
    client.on("peer_left", onPeerLeft);
    client.on("message", onMessage);
    client.on("room_closing", onRoomClosing);
    client.on("server_error", onServerError);

    return () => {
      client.off("peer_joined", onPeerJoined);
      client.off("peer_left", onPeerLeft);
      client.off("message", onMessage);
      client.off("room_closing", onRoomClosing);
      client.off("server_error", onServerError);
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

  function handleSend(text: string) {
    const t = text.trim();
    if (!t) return;
    try {
      const { ciphertext, nonce } = encrypt(roomKey.current, t);
      client.send(ciphertext, nonce);
      addMsg(username, t, true);
    } catch {
      addSystem("发送失败：加密出错");
    }
    setInput("");
  }

  // 可视区域：留出 header(2) + 输入区(3) 的空间
  const rows = stdout?.rows ?? 24;
  const visible = Math.max(4, rows - 6);

  const cdColor = remaining < 60 ? "red" : remaining < 300 ? "yellow" : "gray";

  return (
    <Box flexDirection="column" height={rows}>
      {/* Header */}
      <Box flexDirection="column">
        <Box>
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
          <Text color={cdColor}>⏳ {fmtCd(remaining)}</Text>
        </Box>
        <Text color="gray">输入消息回车发送 · Ctrl+C 退出{closing ? ` · ${closing}` : ""}</Text>
      </Box>

      {/* 消息列表 */}
      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        {lines.slice(-visible).map((l) =>
          l.kind === "system" ? (
            <Text key={l.id} color="yellow">
              {" "}
              {l.text}
            </Text>
          ) : (
            <Box key={l.id}>
              <Text color="gray">{l.time} </Text>
              <Text color={l.self ? "cyan" : "white"} bold>
                {l.from}
              </Text>
              <Text color={l.self ? "cyan" : "white"}>: {l.text}</Text>
            </Box>
          ),
        )}
      </Box>

      {/* 输入栏 */}
      <Box marginTop={1}>
        <Text color="cyan">{"> "}</Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSend}
          placeholder={closing ? "房间即将关闭…" : "输入消息…"}
        />
      </Box>
    </Box>
  );
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
