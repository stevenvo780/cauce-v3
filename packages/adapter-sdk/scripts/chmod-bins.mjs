import { chmod } from "node:fs/promises";

await Promise.all(
  ["hermes", "opencode", "claude", "codex", "openclaw", "grok", "muse", "fake", "fake-harness", "shared-session", "cauce-mcp", "cauce-decisiones-mcp"].map((name) =>
    chmod(new URL(`../dist/src/bin/${name}.js`, import.meta.url), 0o755),
  ),
);
