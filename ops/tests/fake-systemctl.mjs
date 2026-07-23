#!/usr/bin/env node
import { appendFile, readFile, writeFile } from "node:fs/promises";

const statePath = process.env.FAKE_SYSTEMCTL_STATE;
if (!statePath) process.exit(125);
const state = JSON.parse(await readFile(statePath, "utf8"));
const command = process.argv.slice(2);
const scope = command[0] === "--user" ? "user" : "system";
if (scope === "user") command.shift();
const [action, ...args] = command;
await appendFile(state.log, `${JSON.stringify({ scope, action, args })}\n`);
const unit = args.at(-1);
state.active ??= [];
state.enabled ??= [];
if (action === "is-active") process.exit(state.active.includes(unit) ? 0 : 3);
if (action === "is-enabled") process.exit(state.enabled.includes(unit) ? 0 : 1);
if (action === "start") {
  if (!state.active.includes(unit)) state.active.push(unit);
}
if (action === "enable") {
  if (!state.enabled.includes(unit)) state.enabled.push(unit);
}
if (action === "stop") state.active = state.active.filter((value) => value !== unit);
if (action === "disable") {
  state.active = state.active.filter((value) => value !== unit);
  if (!state.disableKeepsEnabled) state.enabled = state.enabled.filter((value) => value !== unit);
}
await writeFile(statePath, `${JSON.stringify(state)}\n`);
process.exit(0);
