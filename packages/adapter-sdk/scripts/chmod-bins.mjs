import { chmod, readdir } from "node:fs/promises";

const bins = new URL("../dist/src/bin/", import.meta.url);
const entries = (await readdir(bins)).filter(name => name.endsWith(".js")).sort();
if (entries.length === 0) throw new Error("no built adapter bins to chmod");
await Promise.all(entries.map((name) => chmod(new URL(name, bins), 0o755)));
