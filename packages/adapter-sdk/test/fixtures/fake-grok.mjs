#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { runFakeCli } from "./fake-cli-common.mjs";

// Like the real CLI it reads the prompt BY PATH from --prompt-file, never from the stdin stream:
// with the default socketpair stdin this read fails with ENXIO, so the double guards the transport.
function promptFromFile() {
  const index = process.argv.indexOf("--prompt-file");
  const path = index === -1 ? undefined : process.argv[index + 1];
  if (path === undefined) throw new Error("fake grok: missing --prompt-file");
  return readFileSync(path, "utf8");
}

await runFakeCli("grok", promptFromFile);
