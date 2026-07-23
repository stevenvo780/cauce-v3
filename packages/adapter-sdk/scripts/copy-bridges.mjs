import { chmod, copyFile, mkdir } from "node:fs/promises";

const destination = new URL("../dist/bridge/", import.meta.url);
await mkdir(destination, { recursive: true });
await Promise.all(
  ["hermes-stdin-bridge.py", "openclaw-stdin-bridge.mjs"].map(async (name) => {
    const target = new URL(name, destination);
    await copyFile(new URL(`../bridge/${name}`, import.meta.url), target);
    await chmod(target, 0o755);
  }),
);
