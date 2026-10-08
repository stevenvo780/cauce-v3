#!/usr/bin/env node
// Fake OpenClaw bridge: writes the turn to its own transcript the way OpenClaw does, then prints the envelope.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const key = process.argv[process.argv.indexOf("--session-key") + 1];
const answer = JSON.stringify({ reply: "hecho desde el transcript", messages: [], status: "done", retryable: false, artifacts: [] });
const sessions = join(process.env.HOME, ".openclaw", "agents", "main", "sessions");
mkdirSync(sessions, { recursive: true, mode: 0o700 });
const index = join(sessions, "sessions.json");
const store = existsSync(index) ? JSON.parse(readFileSync(index, "utf8")) : {};
let entry = store[`agent:main:${key}`];
if (entry === undefined) {
  const sessionId = randomUUID();
  entry = { sessionId, sessionFile: join(sessions, `${sessionId}.jsonl`) };
  writeFileSync(entry.sessionFile, `${JSON.stringify({ type: "session", id: sessionId })}\n`, { mode: 0o600 });
  writeFileSync(index, JSON.stringify({ ...store, [`agent:main:${key}`]: entry }), { mode: 0o600 });
}
const prompt = readFileSync(0, "utf8").trim();
const line = (role, content) => `${JSON.stringify({ type: "message", id: randomUUID(), message: { role, content } })}\n`;
appendFileSync(entry.sessionFile, line("user", prompt) + line("assistant", [{ type: "text", text: answer }]));
process.stdout.write(`${JSON.stringify({ result: { payloads: [{ text: answer }] }, session_id: key })}\n`);
