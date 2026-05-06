#!/usr/bin/env node
import { daemonMain, tempMain } from "./daemon.js";

const main = process.env.LARK_TEMP_MODE === "1" ? tempMain : daemonMain;

main().catch((e) => {
  process.stderr.write(`[Daemon] 启动失败: ${e}\n`);
  process.exit(1);
});
