import { AdapterError } from "./errors.js";
import { hasVisibleText, MAX_FINAL_TEXT_BYTES } from "./output-parser.js";
import type { StructuredOutput } from "./types.js";

const FANIN_SCHEMA = "cauce.agent_fanin_data.v1";
const TENANT_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const TRUNCATION_NOTICE = "\n[fan-in synthesis truncated]";
const ENTRY_TRUNCATION_NOTICE = " [entry truncated]";

type JsonObject = Record<string, unknown>;
interface AttributedText {
  readonly tenantId: string;
  readonly alias: string;
  readonly text: string;
}

export interface FaninSynthesisOptions {
  /**
   * Validated terminal replies produced by this same local adapter while
   * processing correlated child responses. They never come from
   * fanin_data_v1.
   */
  readonly processedReplies?: readonly {
    readonly tenantId: string;
    readonly alias: string;
    readonly reply: string;
  }[];
}

function objectRecord(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function boundedUtf8(
  value: string,
  maxBytes: number,
  suffix = TRUNCATION_NOTICE,
): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const boundedSuffix = suffixBytes <= maxBytes ? suffix : "";
  const prefixLimit = Math.max(0, maxBytes - Buffer.byteLength(boundedSuffix, "utf8"));
  let prefix = "";
  let bytes = 0;
  for (const codePoint of value) {
    const nextBytes = Buffer.byteLength(codePoint, "utf8");
    if (bytes + nextBytes > prefixLimit) break;
    prefix += codePoint;
    bytes += nextBytes;
  }
  return `${prefix}${boundedSuffix}`;
}

function renderAttributedEntry(entry: AttributedText, maxBytes: number): string {
  const prefix = `${entry.tenantId}/${entry.alias}: `;
  const prefixBytes = Buffer.byteLength(prefix, "utf8");
  const minimum = `${prefix}${ENTRY_TRUNCATION_NOTICE.trimStart()}`;
  if (Buffer.byteLength(minimum, "utf8") > maxBytes) return "";
  return `${prefix}${boundedUtf8(
    JSON.stringify(entry.text),
    maxBytes - prefixBytes,
    ENTRY_TRUNCATION_NOTICE,
  )}`;
}

function renderAttributedSection(
  heading: string,
  entries: readonly AttributedText[],
  maxBytes: number,
  emptyText: string,
  entryKind: string,
): string {
  if (entries.length === 0) return boundedUtf8(`${heading}\n${emptyText}`, maxBytes);
  const minimumEntryBytes = entries.map((entry) =>
    Buffer.byteLength(
      `${entry.tenantId}/${entry.alias}: ${ENTRY_TRUNCATION_NOTICE.trimStart()}`,
      "utf8",
    ));
  const omittedLine = (count: number): string =>
    `[${count} ${entryKind} ${count === 1 ? "entry" : "entries"} omitted for byte limit]`;
  const headingBytes = Buffer.byteLength(heading, "utf8");
  let includedCount = 0;
  let includedMinimumBytes = 0;
  for (const minimumBytes of minimumEntryBytes) {
    const candidateCount = includedCount + 1;
    const omittedCount = entries.length - candidateCount;
    const footerBytes = omittedCount === 0
      ? 0
      : Buffer.byteLength(omittedLine(omittedCount), "utf8") + 1;
    const candidateBytes = headingBytes
      + candidateCount
      + includedMinimumBytes
      + minimumBytes
      + footerBytes;
    if (candidateBytes > maxBytes) break;
    includedCount = candidateCount;
    includedMinimumBytes += minimumBytes;
  }
  const omittedCount = entries.length - includedCount;
  const footer = omittedCount === 0 ? undefined : omittedLine(omittedCount);
  if (includedCount === 0) {
    return boundedUtf8(`${heading}\n${footer ?? omittedLine(entries.length)}`, maxBytes);
  }
  const fixedBytes = headingBytes
    + includedCount
    + includedMinimumBytes
    + (footer === undefined ? 0 : Buffer.byteLength(footer, "utf8") + 1);
  const availableExtraBytes = Math.max(0, maxBytes - fixedBytes);
  const baseExtraBytes = Math.floor(availableExtraBytes / includedCount);
  let remainder = availableExtraBytes % includedCount;
  const lines = entries.slice(0, includedCount).map((entry, index) => {
    const entryBytes = minimumEntryBytes[index]!
      + baseExtraBytes
      + (remainder > 0 ? 1 : 0);
    remainder = Math.max(0, remainder - 1);
    return renderAttributedEntry(entry, entryBytes);
  });
  if (footer !== undefined) lines.push(footer);
  return boundedUtf8(`${heading}\n${lines.join("\n")}`, maxBytes);
}

/**
 * Pure fan-in rendering boundary. It never invokes a harness, tool, network,
 * filesystem, native session, or provider API.
 */
export function synthesizeFaninOutput(
  body: Readonly<Record<string, unknown>>,
  options: FaninSynthesisOptions = {},
): StructuredOutput {
  const data = objectRecord(body.fanin_data_v1);
  if (data === undefined || data.schema !== FANIN_SCHEMA || !Array.isArray(data.responses)) {
    throw new AdapterError(
      "INVALID_DELIVERY",
      `agent.fanin requires body.fanin_data_v1 with schema '${FANIN_SCHEMA}' and responses[]`,
      false,
    );
  }

  const responses: AttributedText[] = [];
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
    responses.push({
      tenantId: response.tenant_id,
      alias: response.alias,
      text,
    });
  }

  const expected = typeof data.expected === "number" && Number.isSafeInteger(data.expected)
    ? data.expected
    : undefined;
  const completed = typeof data.completed === "number" && Number.isSafeInteger(data.completed)
    ? data.completed
    : responses.length;
  const heading = expected === undefined
    ? `Agent results (${completed} completed):`
    : `Agent results (${completed}/${expected} completed):`;
  const processedReplies = (options.processedReplies ?? [])
    .filter((candidate) =>
      TENANT_PATTERN.test(candidate.tenantId)
      && ALIAS_PATTERN.test(candidate.alias)
      && hasVisibleText(candidate.reply))
    .map((candidate) => ({
      tenantId: candidate.tenantId,
      alias: candidate.alias,
      text: candidate.reply.trim(),
    }));
  if (processedReplies.length === 0) {
    return {
      reply: renderAttributedSection(
        heading,
        responses,
        MAX_FINAL_TEXT_BYTES,
        "No branch responses were available.",
        "raw branch",
      ),
      messages: [],
      status: "done",
      retryable: false,
      artifacts: [],
    };
  }

  const separator = "\n\n";
  const availableBytes = MAX_FINAL_TEXT_BYTES - Buffer.byteLength(separator, "utf8");
  const processedBudget = Math.floor(availableBytes / 2);
  const evidenceBudget = availableBytes - processedBudget;
  const processedHeading = processedReplies.length === 1
    ? "Locally processed branch reply (1):"
    : `Locally processed branch replies (${processedReplies.length}):`;
  const processed = renderAttributedSection(
    processedHeading,
    processedReplies,
    processedBudget,
    "No locally processed replies were available.",
    "processed branch",
  );
  const evidence = renderAttributedSection(
    heading,
    responses,
    evidenceBudget,
    "No branch responses were available.",
    "raw branch",
  );

  return {
    reply: boundedUtf8(`${processed}${separator}${evidence}`, MAX_FINAL_TEXT_BYTES),
    messages: [],
    status: "done",
    retryable: false,
    artifacts: [],
  };
}
