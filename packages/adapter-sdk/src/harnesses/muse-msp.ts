import { createUuidV7Mint } from "@muse-code/sdk";
import { parseMuseMspOutput } from "../sdk/output-parser.js";
import type { HarnessDefinition } from "../sdk/types.js";
import { capabilities } from "./shared.js";

/** Muse over MSP (`muse serve`, durable UUIDv7 sessions): opt-in; production uses `museDefinition`. */
export const museMspDefinition: HarnessDefinition = {
  id: "muse",
  command: "muse",
  baseArgs: ["serve"],
  capabilities: capabilities("muse", true),
  sessionStrategy: { kind: "generated", mint: createUuidV7Mint(), forwardResume: true },
  sessionArgs: () => [],
  parse: parseMuseMspOutput,
};
