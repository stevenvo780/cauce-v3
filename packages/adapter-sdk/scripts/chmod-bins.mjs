import { chmod } from "node:fs/promises";

await Promise.all(
  ["hermes", "opencode", "claude", "codex", "openclaw", "fake", "fake-harness", "shared-session"].map((name) =>
    chmod(new URL(`../dist/src/bin/${name}.js`, import.meta.url), 0o755),
  ),
);
