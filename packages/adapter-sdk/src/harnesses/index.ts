import { parseDirectOutput } from "../sdk/output-parser.js";
import type { HarnessDefinition, HarnessId } from "../sdk/types.js";
import { claudeDefinition } from "./claude.js";
import { codexDefinition } from "./codex.js";
import { fakeDefinition } from "./fake.js";
import { fake2Definition } from "./fake2.js";
import { grokDefinition } from "./grok.js";
import { hermesDefinition } from "./hermes.js";
import { museDefinition } from "./muse.js";
import { openCodeDefinition } from "./opencode.js";
import { openClawDefinition } from "./openclaw.js";

import { capabilities, HarnessAdapter, executionError } from "./shared.js";

export { HarnessAdapter, executionError };
export {
  claudeDefinition, codexDefinition, fakeDefinition, fake2Definition, grokDefinition, museDefinition,
  openClawDefinition, openCodeDefinition,
};

export const HARNESS_DEFINITIONS = {
  hermes: hermesDefinition,
  opencode: openCodeDefinition,
  claude: claudeDefinition,
  codex: codexDefinition,
  openclaw: openClawDefinition,
  grok: grokDefinition,
  // The packaged Muse definition is the `muse exec` one (production path). The MSP variant
  // (`./muse-msp.js`) is not a separate harness id: `runCli` loads it only with an explicit Muse
  // MSP configuration, so the rest of the fleet never loads `@muse-code/sdk`.
  muse: museDefinition,
  fake: fakeDefinition,
  fake2: fake2Definition,
};

const HARNESS_ID = /^[a-z][a-z0-9_-]{0,63}$/u;
const DEFINITION_BY_ID: ReadonlyMap<string, HarnessDefinition> = new Map(Object.entries(HARNESS_DEFINITIONS));

/** The descriptor does not name an executable. This runs only when no handwritten module registered the id. */
function genericHarnessDefinition(id: string): HarnessDefinition {
  if (!HARNESS_ID.test(id)) throw new Error(`no packaged harness definition for '${id}'`);
  return {
    id,
    command: id,
    baseArgs: [],
    capabilities: capabilities(id, false),
    sessionStrategy: { kind: "none" },
    sessionArgs: () => [],
    parse: parseDirectOutput,
  };
}

export function harnessDefinition(id: HarnessId): HarnessDefinition {
  const known = DEFINITION_BY_ID.get(id);
  if (known !== undefined) return known;
  return genericHarnessDefinition(id);
}
