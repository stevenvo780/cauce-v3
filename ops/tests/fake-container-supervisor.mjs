#!/usr/bin/env node
import { appendFile } from "node:fs/promises";

const [action, alias] = process.argv.slice(2);
if (process.env.FAKE_SUPERVISOR_LOG) {
  await appendFile(process.env.FAKE_SUPERVISOR_LOG, `${JSON.stringify({ action, alias })}\n`);
}
process.exit(Number(process.env[`FAKE_SUPERVISOR_${action?.toUpperCase()}_EXIT`] ?? "0"));
