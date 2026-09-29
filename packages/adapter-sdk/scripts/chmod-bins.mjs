import { chmod } from "node:fs/promises";

await Promise.all(
  ["hermes", "opencode", "claude", "codex", "muse", "openclaw", "fake", "fake-harness", "shared-session", "cauce-mcp"].map((name) =>
    chmod(new URL(`../dist/src/bin/${name}.js`, import.meta.url), 0o755),
  ),
);
