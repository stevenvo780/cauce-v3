import { AdapterError } from "./errors.js";
import { hasVisibleText, MAX_FINAL_TEXT_BYTES } from "./output-parser.js";
import type { StructuredOutput } from "./types.js";

const FANIN_SCHEMA = "cauce.agent_fanin_data.v1";
const TENANT_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const TRUNCATION_NOTICE = "\n[fan-in synthesis truncated]";

type JsonObject = Record<string, unknown>;

function objectRecord(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function boundedUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffixBytes = Buffer.byteLength(TRUNCATION_NOTICE, "utf8");
  const prefixLimit = Math.max(0, maxBytes - suffixBytes);
  let prefix = "";
  let bytes = 0;
  for (const codePoint of value) {
    const nextBytes = Buffer.byteLength(codePoint, "utf8");
    if (bytes + nextBytes > prefixLimit) break;
    prefix += codePoint;
    bytes += nextBytes;
  }
  return `${prefix}${TRUNCATION_NOTICE}`;
}

/**
 * Pure fan-in rendering boundary. It never invokes a harness, tool, network,
 * filesystem, native session, or provider API.
 */
export function synthesizeFaninOutput(body: Readonly<Record<string, unknown>>): StructuredOutput {
  const data = objectRecord(body.fanin_data_v1);
  if (data === undefined || data.schema !== FANIN_SCHEMA || !Array.isArray(data.responses)) {
    throw new AdapterError(
      "INVALID_DELIVERY",
      `agent.fanin requires body.fanin_data_v1 with schema '${FANIN_SCHEMA}' and responses[]`,
      false,
    );
  }

  const lines: string[] = [];
  for (const [index, candidate] of data.responses.entries()) {
    const response = objectRecord(candidate);
    if (response === undefined
      || typeof response.tenant_id !== "string"
      || !TENANT_PATTERN.test(response.tenant_id)
      || typeof response.alias !== "string"
      || !ALIAS_PATTERN.test(response.alias)
      || typeof response.untrusted_text !== "string") {
      throw new AdapterError(
        "INVALID_DELIVERY",
        `agent.fanin response[${index}] requires canonical tenant_id/alias and string untrusted_text`,
        false,
      );
    }
    const text = hasVisibleText(response.untrusted_text)
      ? response.untrusted_text
      : "completed without a visible textual response.";
    lines.push(`${response.tenant_id}/${response.alias}: ${JSON.stringify(text)}`);
  }

  const expected = typeof data.expected === "number" && Number.isSafeInteger(data.expected)
    ? data.expected
    : undefined;
  const completed = typeof data.completed === "number" && Number.isSafeInteger(data.completed)
    ? data.completed
    : lines.length;
  const heading = expected === undefined
    ? `Agent results (${completed} completed):`
    : `Agent results (${completed}/${expected} completed):`;
  const reply = boundedUtf8(
    lines.length === 0 ? `${heading}\nNo branch responses were available.` : `${heading}\n${lines.join("\n")}`,
    MAX_FINAL_TEXT_BYTES,
  );

  return {
    reply,
    messages: [],
    status: "done",
    retryable: false,
    artifacts: [],
  };
}
