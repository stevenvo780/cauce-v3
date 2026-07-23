#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";

const marker = process.argv[2];
if (!marker) throw new Error("marker path required");
spawn(process.execPath, ["--eval", `process.on('SIGTERM',()=>{}); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 200)`], {
  stdio: "ignore",
});
await new Promise((resolve) => setTimeout(resolve, 60_000));
