#!/usr/bin/env node
/**
 * Detach pack-local.ps1 so killing Cursor Claw does not kill the pack job.
 * Usage: node scripts/pack-local-detached.cjs
 *        npm run pack:local
 */
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const root = path.resolve(__dirname, "..");
const ps1 = path.join(root, "scripts", "pack-local.ps1");
const logDir = path.join(root, "temp");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outLog = path.join(logDir, `pack-local-detached-${stamp}.log`);

const out = fs.openSync(outLog, "a");
const child = spawn(
  "powershell.exe",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1],
  {
    cwd: root,
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
  },
);
child.unref();
console.log(`pack-local detached pid=${child.pid}`);
console.log(`log: ${outLog}`);
console.log("当前会话可继续；打包完成后脚本会自行停掉旧进程并启动 release\\local");
