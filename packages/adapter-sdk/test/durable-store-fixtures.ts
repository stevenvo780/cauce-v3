// Shared helpers for the split durable-store.test.ts tests (Task 2 of opencode-minimax.md).
// NOT a test: the `dist/test/*.test.js` runner does not pick it up.
import {readFile, rm} from 'node:fs/promises';
import { resolve } from "node:path";
import {CANONICAL_OPEN_CODE_SESSION_FILE, DurableStore, type CanonicalOpenCodeSessionPointer} from '../src/sdk/durable-store.js';
import type {Delivery, StructuredOutput} from '../src/sdk/types.js';
export const root = resolve(".test-state/canonical-open-code-store");
export const scopeA = `auth-v3:${"A".repeat(43)}`;
export const scopeB = `auth-v3:${"B".repeat(43)}`;

export type AtomicCrashWindow = "tmp" | "backup-tmp" | "backup" | "committed";

export async function freshStore(name: string): Promise<{ directory: string; store: DurableStore }> {
  const directory = resolve(root, name);
  await rm(directory, { recursive: true, force: true });
  return { directory, store: await DurableStore.open(directory) };
}

export async function pointer(directory: string): Promise<CanonicalOpenCodeSessionPointer> {
  return JSON.parse(
    await readFile(resolve(directory, CANONICAL_OPEN_CODE_SESSION_FILE), "utf8"),
  ) as CanonicalOpenCodeSessionPointer;
}

export function delivery(id: string): Delivery {
  return {
    type: "delivery",
    version: "3.0",
    delivery_id: id,
    event_id: `30000000-0000-4000-8000-${id.padEnd(12, "0").slice(0, 12)}`,
    message_id: `00000000-0000-4000-8000-${id.padEnd(12, "0").slice(0, 12)}`,
    request_id: `10000000-0000-4000-8000-${id.padEnd(12, "0").slice(0, 12)}`,
    trace_id: `trace-${id}`,
    epoch: 1,
    attempt: 1,
    claim_token: `20000000-0000-4000-8000-${id.padEnd(12, "0").slice(0, 12)}`,
    ack_deadline_at: new Date(Date.now() + 30_000).toISOString(),
    tenant_id: "Steven",
    room_id: "grp.steven",
    actor_alias: "jarvis",
    recipient_alias: "argos",
    origin: {
      adapter: "telegram",
      channel: "telegram",
      conversation_id: "room-42",
      external_message_id: "message-9",
      relay: [],
      metadata: {},
    },
    body: { type: "agent.message", text: "perform the task" },
  };
}

export const delegatedOutput: StructuredOutput = {
  reply: null,
  messages: [{ to: "socrates", body: "implement the bounded fix" }],
  notify: [],
  status: "done",
  retryable: false,
  artifacts: [],
};

export const completedOutput: StructuredOutput = {
  reply: "REVIEW=PASS",
  messages: [],
  notify: [],
  status: "done",
  retryable: false,
  artifacts: [],
};
