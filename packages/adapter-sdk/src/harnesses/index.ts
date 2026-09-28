import type { HarnessDefinition, HarnessId } from "../sdk/types.js";
import { claudeDefinition } from "./claude.js";
import { codexDefinition } from "./codex.js";
import { fakeDefinition } from "./fake.js";
import { grokDefinition } from "./grok.js";
import { hermesDefinition } from "./hermes.js";
import { museDefinition } from "./muse.js";
import { openCodeDefinition } from "./opencode.js";
import { openClawDefinition } from "./openclaw.js";

export { HarnessAdapter, executionError } from "./shared.js";
export {
  claudeDefinition, codexDefinition, fakeDefinition, grokDefinition, museDefinition, openClawDefinition,
  openCodeDefinition,
};

export const HARNESS_DEFINITIONS: Readonly<Record<HarnessId, HarnessDefinition>> = {
  hermes: hermesDefinition,
  opencode: openCodeDefinition,
  claude: claudeDefinition,
  codex: codexDefinition,
  openclaw: openClawDefinition,
  grok: grokDefinition,
  muse: museDefinition,
  fake: fakeDefinition,
};

export function harnessDefinition(id: HarnessId): HarnessDefinition {
  return HARNESS_DEFINITIONS[id];
}
