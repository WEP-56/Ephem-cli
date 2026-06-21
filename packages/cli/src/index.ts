// ephem-cli 入口：解析命令行参数，未提供的走交互式问答。

import React from "react";
import { render } from "ink";
import { Command } from "commander";
import { App } from "./ui/App.js";

const program = new Command();

program
  .name("ephem")
  .description("临时、端到端加密的命令行聊天室")
  .option("-s, --server <url>", "后端地址（也可用 EPHEM_SERVER 环境变量）")
  .option("-r, --room <code>", "房间码，例如 correct-horse-battery")
  .option("-u, --username <name>", "用户名")
  .helpOption("-h, --help", "查看帮助")
  .action((opts) => {
    const defaults = {
      server: opts.server ?? process.env.EPHEM_SERVER,
      room: opts.room,
      username: opts.username,
    };

    // 安全提醒：命令行参数传房间码会被记录到 shell history，优先用交互式输入。
    if (opts.room) {
      process.stderr.write(
        "⚠ 提示：通过 --room 传入的房间码可能被记录到 shell 历史，建议优先交互式输入。\n",
      );
    }

    const instance = render(React.createElement(App, { defaults }));
    instance.waitUntilExit()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });

program.parse(process.argv);
