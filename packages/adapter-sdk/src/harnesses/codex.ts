import { parseCodexOutput } from "../sdk/output-parser.js";
import type { HarnessDefinition } from "../sdk/types.js";
import { capabilities } from "./shared.js";

export const codexDefinition: HarnessDefinition = {
  id: "codex",
  command: "codex",
  baseArgs: ["exec", "--skip-git-repo-check"],
  capabilities: capabilities("codex", true),
  sessionStrategy: { kind: "observed" },
  // `--json` emite JSONL segun avanza el turno, y su primer evento sale ANTES de cualquier
  // llamada al modelo. Por eso cero bytes en stdout prueba que el turno no empezo: los fallos
  // medidos que mueren asi (config.toml que no parsea, `thread/resume` sin rollout) salen del
  // CLI sin escribir una sola linea, mientras que un turno a medias ya dejo decenas.
  startWitness: { kind: "stdout-first-byte" },
  sessionArgs: ({ sessionId, resume }) =>
    resume && sessionId !== undefined ? ["resume", "--json", sessionId, "-"] : ["--json", "-"],
  parse: parseCodexOutput,
};
