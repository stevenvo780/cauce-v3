import { chmod, copyFile, mkdir, readdir } from "node:fs/promises";

const destination = new URL("../dist/bridge/", import.meta.url);
await mkdir(destination, { recursive: true });
await Promise.all(
  ["hermes-stdin-bridge.py", "openclaw-stdin-bridge.mjs"].map(async (name) => {
    const target = new URL(name, destination);
    await copyFile(new URL(`../bridge/${name}`, import.meta.url), target);
    await chmod(target, 0o755);
  }),
);
const descriptors = new URL('../dist/descriptors/', import.meta.url);
await mkdir(descriptors, { recursive: true });
const descriptorFiles = (await readdir(new URL('../descriptors/', import.meta.url)))
  .filter(name => /^[a-z][a-z0-9_-]{0,63}\.json$/u.test(name)).sort();
await Promise.all(descriptorFiles.map(name =>
  copyFile(new URL(`../descriptors/${name}`, import.meta.url), new URL(name, descriptors))));
