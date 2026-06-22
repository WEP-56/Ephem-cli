import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { SetupWizard, type ConnectConfig } from "./SetupWizard.js";
import { ChatRoom } from "./ChatRoom.js";
import { RoomClient, type JoinedInfo } from "../ws/client.js";
import { type AppConfig, saveConfig } from "../config.js";

interface Props {
  defaults: { server?: string; room?: string; username?: string };
  initialConfig: AppConfig;
}

type Phase = "setup" | "connecting" | "chat" | "error";

export function App({ defaults, initialConfig }: Props) {
  const { exit } = useApp();
  const skipSetup = Boolean(defaults.server && defaults.room && defaults.username);
  const [phase, setPhase] = useState<Phase>(skipSetup ? "connecting" : "setup");
  const [appConfig, setAppConfig] = useState<AppConfig>(initialConfig);
  const [client, setClient] = useState<RoomClient | null>(null);
  const [joined, setJoined] = useState<JoinedInfo | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const cfgRef = useRef<ConnectConfig | null>(
    skipSetup
      ? { server: defaults.server!, room: defaults.room!, username: defaults.username! }
      : null,
  );

  const updateConfig = useCallback((next: AppConfig) => {
    setAppConfig(next);
    void saveConfig(next);
  }, []);

  const connect = useCallback((config: ConnectConfig) => {
    cfgRef.current = config;
    const nextConfig = {
      ...appConfig,
      server: config.server,
      username: config.username,
    };
    updateConfig(nextConfig);
    const c = new RoomClient(config.server, config.room, config.username, nextConfig.proxy);
    setClient(c);
    setPhase("connecting");
    setError(null);
    setJoined(null);

    c.on("joined", (info: JoinedInfo) => {
      setJoined(info);
      setPhase("chat");
    });
    c.on("server_error", (info: { code: string; message: string }) => {
      setError(info);
      setPhase("error");
    });
    // 连接彻底关闭时，若仍处于 connecting 则视为失败
    c.on("closed", () => {
      setPhase((p) => (p === "connecting" ? "error" : p));
    });
    c.connect();
  }, [appConfig, updateConfig]);

  // 命令行参数齐全时直接连接
  useEffect(() => {
    if (skipSetup && cfgRef.current) connect(cfgRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 退出清理
  useEffect(() => () => client?.close(), [client]);

  const handleRetry = useCallback(() => {
    client?.close();
    setClient(null);
    setJoined(null);
    setError(null);
    setPhase("setup");
  }, [client]);

  if (phase === "setup") {
    return <SetupWizard defaults={defaults} onComplete={connect} />;
  }

  if (phase === "connecting") {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="cyan">正在连接…</Text>
        <Text color="gray">服务器：{cfgRef.current?.server}</Text>
        <Text color="gray">房间：{cfgRef.current?.room}</Text>
      </Box>
    );
  }

  if (phase === "error") {
    return (
      <ErrorScreen
        message={error?.message ?? "未知错误"}
        code={error?.code ?? "unknown"}
        onRetry={handleRetry}
        onExit={() => exit()}
      />
    );
  }

  // chat
  if (!client || !joined || !cfgRef.current) return null;
  return (
    <ChatRoom
      client={client}
      server={cfgRef.current.server}
      roomCode={cfgRef.current.room}
      username={cfgRef.current.username}
      joined={joined}
      appConfig={appConfig}
      onConfigChange={updateConfig}
      onExit={() => exit()}
    />
  );
}

function ErrorScreen({
  message,
  code,
  onRetry,
  onExit,
}: {
  message: string;
  code: string;
  onRetry: () => void;
  onExit: () => void;
}) {
  useInput((input, key) => {
    if (key.return) onRetry();
  });
  return (
    <Box flexDirection="column" gap={1}>
      <Text color="red" bold>
        连接失败
      </Text>
      <Text color="gray">
        {message}（{code}）
      </Text>
      <Text color="gray">按回车返回设置重试，Ctrl+C 退出</Text>
    </Box>
  );
}
