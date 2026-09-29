import {
  EgressHandleSchema, isSafeBasename, isValidMediaType, NOTIFY_KINDS,
} from "@cauce/protocol";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import type { HarnessRequestContext } from "../../contracts/harness.js";
import type { Delivery, StructuredOutput } from "../types.js";
import {
  hasNonBlankText, MAX_FINAL_TEXT_BYTES, validateDeliveryOutput, validateStructuredOutput,
} from "../output-parser.js";
import { HEX_SHA256 } from "../output-parser/relay-artifacts.js";

const string = { type: "string" };
const tool = (name: string, description: string, properties = {}, required: string[] = []): Tool => ({
  name, description, inputSchema: { type: "object", properties, required, additionalProperties: false },
});
export const EMISSION_TOOLS: Tool[] = [
  tool("cauce_reply", "Deposit this turn's answer once. Corrections to rejected input are safe. End the CLI turn after success; delivery is committed by the engine afterwards.", {
    reply: { type: ["string", "null"] }, status: { enum: ["done", "failed"] }, retryable: { type: "boolean" },
  }, ["reply", "status", "retryable"]),
  tool("cauce_send", "Stage a delegation to an online routing target. It is sent with this turn's successful final ACK.", { to: string, body: string }, ["to", "body"]),
  tool("cauce_notify", "Stage a notification to a configured human destination handle.", {
    to: string, kind: { enum: NOTIFY_KINDS }, body: string,
  }, ["to", "kind", "body"]),
  tool("cauce_artifact_add", "Stage one attachment; invalid entries are rejected without changing the turn.", {
    name: string, uri: string, media_type: string, sha256: string,
  }, ["name", "uri"]),
  tool("cauce_progress", "Publish progress (at most 1024 UTF-8 bytes) for this turn using the engine's authenticated claim.", { text: { ...string, maxLength: 1024 } }, ["text"]),
  tool("cauce_status", "Read the current turn and what is staged; staged is not a confirmed delivery."),
  tool("cauce_queue", "Read pending and active deliveries addressed to this alias."),
  tool("cauce_retry", "Replay a dead delegation originally sent by this alias. The gateway checks ownership.", { delivery_id: string }, ["delivery_id"]),
];

export type EmissionGateway = (method: "GET" | "POST", path: string, body?: unknown) => Promise<unknown>;
interface EmissionState { readonly output: StructuredOutput; readonly replied: boolean }
export interface EmissionTurnOptions {
  readonly delivery: Delivery;
  readonly context: HarnessRequestContext;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly persist: (state: EmissionState, correlationId?: string) => Promise<void>;
  readonly gateway: EmissionGateway;
  readonly instanceId: string;
}

export function toolArguments(name: string, value: unknown): Record<string, unknown> {
  const definition = EMISSION_TOOLS.find((entry) => entry.name === name);
  if (definition === undefined) throw new Error(`Unknown tool: ${name}`);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Arguments must be an object");
  const args = value as Record<string, unknown>;
  const keys = Object.keys(definition.inputSchema.properties ?? {});
  if (Object.keys(args).some((key) => !keys.includes(key))) throw new Error("Unexpected argument; delivery identity is supplied by the engine");
  for (const key of definition.inputSchema.required ?? []) {
    if (!(key in args)) throw new Error(`Missing '${key}'`);
  }
  return args;
}

function text(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !hasNonBlankText(value)) throw new Error(`'${key}' must contain visible text`);
  return value;
}

export class EmissionTurn {
  readonly token = randomUUID();
  private state: EmissionState = {
    replied: false,
    output: { reply: null, status: "done", retryable: false, messages: [], notify: [], artifacts: [] },
  };
  private active = false;
  private correlationId: string | undefined;
  constructor(readonly options: EmissionTurnOptions) {}

  activate(correlationId?: string): void { this.correlationId = correlationId; this.active = true; }
  close(): void { this.active = false; }
  get available(): boolean { return this.active && !this.options.signal.aborted && this.options.isCurrent(); }
  get output(): StructuredOutput | undefined { return this.state.replied ? this.state.output : undefined; }

  private requireAvailable(message: string): void {
    if (!this.available) throw new Error(message);
  }

  status(): Record<string, unknown> {
    const { delivery } = this.options;
    return {
      delivery_id: delivery.delivery_id, attempt: delivery.attempt,
      deadline: delivery.ack_deadline_at, state: this.available ? "active" : "closed",
      reply_deposited: this.state.replied, messages: this.state.output.messages.length,
      result_status: this.state.replied ? this.state.output.status : null,
      notify: this.state.output.notify.length, artifacts: this.state.output.artifacts.length,
      submission: this.state.replied ? "staged_until_cli_finishes" : "awaiting_reply",
    };
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.requireAvailable("No active owned turn; the delivery may have closed or lost its claim");
    if (name === "cauce_status") return this.status();
    const { delivery, context } = this.options;
    const path = `/v3/agent/deliveries/${encodeURIComponent(delivery.delivery_id)}`;
    if (name === "cauce_progress") {
      const progress = text(args, "text");
      if (Buffer.byteLength(progress) > 1024 || progress.includes("\0")) throw new Error("Progress must be at most 1024 UTF-8 bytes without NUL");
      return this.options.gateway("POST", `${path}/progress`, {
        text: progress, attempt: delivery.attempt, claim_token: delivery.claim_token,
        epoch: delivery.epoch, instance_id: this.options.instanceId,
      });
    }
    if (name === "cauce_retry") {
      const id = text(args, "delivery_id");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id)) throw new Error("'delivery_id' must be a UUID");
      return this.options.gateway("POST", `/v3/agent/deliveries/${encodeURIComponent(id)}/retry`, {});
    }
    let candidate = this.state.output;
    let replied = this.state.replied;
    let discardedMessages = 0;
    switch (name) {
      case "cauce_reply": {
        if (replied) throw new Error("A reply is already deposited for this turn");
        if (args.reply !== null && typeof args.reply !== "string") throw new Error("'reply' must be a string or null");
        if (typeof args.reply === "string" && Buffer.byteLength(args.reply) > MAX_FINAL_TEXT_BYTES) throw new Error("'reply' exceeds the UTF-8 byte limit");
        if (args.status !== "done" && args.status !== "failed") throw new Error("'status' must be done or failed");
        if (typeof args.retryable !== "boolean" || (args.status === "done" && args.retryable)) throw new Error("'retryable' must be boolean and false on success");
        candidate = { ...candidate, reply: args.reply, status: args.status, retryable: args.retryable };
        if (candidate.status === "failed") {
          discardedMessages = candidate.messages.length;
          candidate = { ...candidate, messages: [] };
        }
        replied = true;
        break;
      }
      case "cauce_send": {
        const to = text(args, "to");
        const targets = context.routing_targets.filter((target) => target.alias === to);
        if (to === context.self_alias || to === context.sender_alias) throw new Error("Use cauce_reply to answer the sender; self-delegation is forbidden");
        if (targets.length !== 1 || targets[0]?.online !== true) throw new Error("Target must be one unambiguous online alias in this turn's routing_targets");
        candidate = { ...candidate, messages: [...candidate.messages, { to, body: text(args, "body") }] };
        break;
      }
      case "cauce_notify": {
        const to = text(args, "to");
        if (!EgressHandleSchema.safeParse(to).success) throw new Error("'to' must be a destination handle");
        const kind = NOTIFY_KINDS.find((entry) => entry === args.kind);
        if (kind === undefined) throw new Error("Unknown notification kind");
        candidate = { ...candidate, notify: [...candidate.notify, { to, kind, body: text(args, "body") }] };
        break;
      }
      case "cauce_artifact_add": {
        const name = text(args, "name");
        const uri = text(args, "uri");
        if (!isSafeBasename(name)) throw new Error("'name' must be a safe basename");
        const mediaType = args.media_type;
        if (mediaType !== undefined && (typeof mediaType !== "string" || !isValidMediaType(mediaType))) throw new Error("Invalid media_type");
        const sha256 = args.sha256;
        if (sha256 !== undefined && (typeof sha256 !== "string" || !HEX_SHA256.test(sha256))) throw new Error("Invalid sha256");
        candidate = { ...candidate, artifacts: [...candidate.artifacts, { name, uri,
          ...(mediaType === undefined ? {} : { media_type: mediaType }),
          ...(sha256 === undefined ? {} : { sha256: sha256.toLowerCase() }),
        }] };
        break;
      }
      default: throw new Error(`Unknown tool: ${name}`);
    }
    const validated = validateStructuredOutput(candidate);
    if (!isDeepStrictEqual(validated, candidate)) throw new Error("Input exceeds the output contract or attachment/notification budget; nothing was deposited");
    if (replied) {
      const final = validateDeliveryOutput(validated, {
        messageType: context.message_type, senderAlias: context.sender_alias,
        selfAlias: context.self_alias, routingTargets: context.routing_targets,
      });
      if (!isDeepStrictEqual(final, validated)) throw new Error("Result would be changed by delivery policy; provide a visible reply and valid delegations");
    }
    const next = { output: validated, replied };
    await this.options.persist(next, this.correlationId);
    this.requireAvailable("Turn closed during persistence; deposit is retained for diagnosis but cannot be sent");
    this.state = next;
    return { ...this.status(), ...(discardedMessages === 0 ? {} : { delegations_discarded_on_failure: discardedMessages }) };
  }
}
