"use strict";

const fs = require("fs");
const path = require("path");

const target = path.join(__dirname, "..", "src", "daemon-scheduled-tasks.ts");

let s = fs.readFileSync(target, "utf8");
s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

let prev;
do {
  prev = s;
  s = s.replace(/\n\n/g, "\n");
} while (s !== prev);

const lines = s.split("\n");
let depth = 0;
const out = [];

for (const line of lines) {
  const opens = (line.match(/\{/g) || []).length;
  const closes = (line.match(/\}/g) || []).length;

  const atCol0 = line.length === 0 || /^\S/.test(line);
  const prevLine = out[out.length - 1];
  const needBlank =
    depth === 0 &&
    atCol0 &&
    out.length > 0 &&
    prevLine !== "" &&
    (/^export function /.test(line) ||
      /^function /.test(line) ||
      /^interface /.test(line) ||
      (/^const /.test(line) && /^import /.test(prevLine)) ||
      (/^let /.test(line) && /^\}\s*$/.test(prevLine)));

  if (needBlank) {
    out.push("");
  }
  out.push(line);
  depth += opens - closes;
}

fs.writeFileSync(target, out.join("\r\n") + "\r\n", "utf8");
console.log("normalized:", target, "lines:", out.length);

