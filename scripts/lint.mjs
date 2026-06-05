#!/usr/bin/env node
// Syntax-check every JS source file. `node --check` only accepts one file at a
// time, so we walk the tree and check each — portable across CI runners and
// platforms (no shell globbing required).

import { spawnSync } from "node:child_process";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(c?js|mjs)$/.test(entry)) out.push(p);
  }
  return out;
}

const targets = ["connect.mjs", ...walk("src"), ...walk("scripts"), ...walk("test")];

let failed = false;
for (const file of targets) {
  const r = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (r.status !== 0) failed = true;
  else console.log(`✓ ${file}`);
}

process.exit(failed ? 1 : 0);
