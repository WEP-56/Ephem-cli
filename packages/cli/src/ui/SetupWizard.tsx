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
  const [error, setError] = useState<string | null>(null);

  const values = [server, room, username];
  const setters = [setServer, setRoom, setUsername];

  function submit(value: string) {
    const v = value.trim();
    setters[step](v);
    setError(null);
    if (step === 0 && !v) {
      setError("请输入后端地址，例如 wss://your-worker.workers.dev");
      return;
    }
    if (step === 1 && !/^[a-z]+-[a-z]+-[a-z]+$/.test(v.toLowerCase())) {
      setError("房间码格式应为三段英文单词，例如 correct-horse-battery");
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
    <Box flexDirection="column" gap={1} borderStyle="round" borderColor="cyan" paddingX={1} paddingY={1}>
      <Box flexDirection="column">
        <Text>
          <Text color="cyan" bold>
            ephem
          </Text>
          <Text color="gray"> · 临时加密聊天室</Text>
        </Text>
        <Text color="gray">按回车进入下一步，Ctrl+C 退出。房间码和密钥不会落盘。</Text>
      </Box>

      {STEPS.map((label, i) => {
        const done = i < step;
        const active = i === step;
        return (
          <Box key={label} flexDirection="column" marginTop={i === 0 ? 1 : 0}>
            <Text color={active ? "cyan" : done ? "green" : "gray"}>
              {done ? "✓" : active ? "›" : "·"} {label}
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
              <Text color="gray">  {i === 2 && !values[i] ? "匿名" : values[i] || "(空)"}</Text>
            ) : null}
          </Box>
        );
      })}

      {error ? (
        <Box marginTop={1}>
          <Text color="red">错误：{error}</Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color="gray">提示：进入聊天后可用 /image &lt;路径&gt; 发送小于 1 MiB 的图片。</Text>
        </Box>
      )}
    </Box>
  );
}
