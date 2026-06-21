import React, { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

export interface ConnectConfig {
  server: string;
  room: string;
  username: string;
}

interface Props {
  defaults: { server?: string; room?: string; username?: string };
  onComplete: (cfg: ConnectConfig) => void;
}

const STEPS = ["后端地址", "房间码", "用户名"] as const;

/** 三步问答：后端地址 → 房间码 → 用户名。完成后回调 onComplete。 */
export function SetupWizard({ defaults, onComplete }: Props) {
  const [step, setStep] = useState(0);
  const [server, setServer] = useState(defaults.server ?? "");
  const [room, setRoom] = useState((defaults.room ?? "").toLowerCase());
  const [username, setUsername] = useState(defaults.username ?? "");

  const values = [server, room, username];
  const setters = [setServer, setRoom, setUsername];

  function submit(value: string) {
    const v = value.trim();
    setters[step](v);
    if (step === 0 && !v) {
      // 后端地址为空时拒绝（除非有默认值）
      return;
    }
    if (step < 2) {
      setStep(step + 1);
    } else {
      onComplete({
        server: (server || "").trim(),
        room: (room || "").trim().toLowerCase(),
        username: (v || "匿名").slice(0, 32),
      });
    }
  };

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text color="cyan" bold>
          ephem · 临时加密聊天室
        </Text>
        <Text color="gray">按回车进入下一步，Ctrl+C 退出</Text>
      </Box>

      {STEPS.map((label, i) => {
        const done = i < step;
        const active = i === step;
        return (
          <Box key={label} flexDirection="column">
            <Text color={active ? "cyan" : "gray"}>
              {done ? "✓" : active ? "?" : "·"} {label}
              {i === 0 && defaults.server ? "（回车使用默认值）" : ""}
            </Text>
            {active ? (
              <Box>
                <Text color="gray">  › </Text>
                <TextInput
                  value={values[i]}
                  onChange={(v) => setters[i](v)}
                  onSubmit={submit}
                  placeholder={i === 0 ? "wss://your-worker.workers.dev" : i === 1 ? "correct-horse-battery" : "你的名字"}
                />
              </Box>
            ) : done ? (
              <Text color="gray">  {values[i] || "(空)"}</Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}
