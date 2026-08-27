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
  readonly deliveryId?: string;
}

export interface FaninSynthesisOptions {
  /**
   * Validated terminal replies produced by this same local adapter while
   * processing correlated child responses. They never come from
   * fanin_data_v1. Callers supply them newest first; `updatedAt` is used to
   * re-establish that order defensively.
   */
  readonly processedReplies?: readonly {
    readonly tenantId: string;
    readonly alias: string;
    readonly reply: string;
    readonly updatedAt?: string;
    readonly childDeliveryId?: string;
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
      ...(typeof response.delivery_id === "string" && response.delivery_id.length > 0
        ? { deliveryId: response.delivery_id }
        : {}),
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
    .map((candidate, order) => ({
      tenantId: candidate.tenantId,
      alias: candidate.alias,
      text: candidate.reply.trim(),
      updatedAt: candidate.updatedAt ?? "",
      order,
      ...(typeof candidate.childDeliveryId === "string" && candidate.childDeliveryId.length > 0
        ? { childDeliveryId: candidate.childDeliveryId }
        : {}),
    }))
    .sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || left.order - right.order);
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
      notify: [],
      status: "done",
      retryable: false,
      artifacts: [],
    };
  }

  // The newest locally processed reply leads the synthesis: it is the last turn this
  // adapter completed for the chain, so it reads as the answer instead of as one more row
  // of a dump. It is emitted verbatim — unquoted and unescaped — because it was produced by
  // this adapter, not read off the wire; quoting it would collapse a multi-paragraph reply
  // into a single escaped line. Every other locally processed reply still has to appear:
  // with a stateless harness the leading turn never saw the sibling branches, so dropping
  // them would destroy terminal local reviews that only exist here.
  const primary = processedReplies[0]!;
  const others = processedReplies.slice(1);
  // Coverage is keyed by the branch delivery id the store itself stamped on each
  // agent.response. A tenant/alias key would collapse two branches delegated to the same
  // alias and silently drop the evidence of the one that was never synthesized locally.
  // A branch that cannot be proven covered always keeps its raw evidence.
  const covered = new Set(processedReplies
    .map((reply) => reply.childDeliveryId)
    .filter((value): value is string => value !== undefined));
  const uncovered = responses.filter((response) =>
    response.deliveryId === undefined || !covered.has(response.deliveryId));
  const footer = process.env.CAUCE_FANIN_FOOTER === "1"
    ? `[${processedReplies.length} locally synthesized branch `
      + `${processedReplies.length === 1 ? "reply" : "replies"}; `
      + `${responses.length} branch ${responses.length === 1 ? "response" : "responses"} `
      + `in this chain; ${uncovered.length} without local synthesis]`
    : undefined;

  const sections: {
    readonly heading: string;
    readonly entries: readonly AttributedText[];
    readonly emptyText: string;
    readonly entryKind: string;
  }[] = [];
  if (others.length > 0) {
    sections.push({
      heading: others.length === 1
        ? "Other locally processed branch reply (1):"
        : `Other locally processed branch replies (${others.length}):`,
      entries: others,
      emptyText: "No other locally processed replies were available.",
      entryKind: "processed branch",
    });
  }
  if (uncovered.length > 0) {
    sections.push({
      heading: uncovered.length === 1
        ? "Branch without local synthesis (1):"
        : `Branches without local synthesis (${uncovered.length}):`,
      entries: uncovered,
      emptyText: "No branch responses were available.",
      entryKind: "raw branch",
    });
  }

  const separator = "\n\n";
  const separatorBytes = Buffer.byteLength(separator, "utf8");
  const footerBytes = footer === undefined ? 0 : Buffer.byteLength(footer, "utf8");
  const availableBytes = MAX_FINAL_TEXT_BYTES
    - footerBytes
    - separatorBytes * (sections.length + (footer === undefined ? 0 : 1));
  if (availableBytes <= 0) {
    return {
      reply: boundedUtf8(primary.text, MAX_FINAL_TEXT_BYTES),
      messages: [],
      notify: [],
      status: "done",
      retryable: false,
      artifacts: [],
    };
  }
  if (sections.length === 0) {
    return {
      reply: footer === undefined
        ? boundedUtf8(primary.text, MAX_FINAL_TEXT_BYTES)
        : boundedUtf8(
          `${boundedUtf8(primary.text, availableBytes)}${separator}${footer}`,
          MAX_FINAL_TEXT_BYTES,
        ),
      messages: [],
      notify: [],
      status: "done",
      retryable: false,
      artifacts: [],
    };
  }
  // Every section keeps a reserved floor so that near the byte limit it can still emit its
  // heading and its `[n … omitted for byte limit]` record: a section that were squeezed to
  // zero would drop branches with nothing left to prove they existed. The lead reply gets
  // the remainder, and the two sides trade their unused slack in both directions.
  const sectionFloor = Math.floor(availableBytes / (sections.length + 2));
  const primaryDemand = Math.min(
    Buffer.byteLength(primary.text, "utf8"),
    availableBytes - sectionFloor * sections.length,
  );
  const sectionSlack = availableBytes - sectionFloor * sections.length - primaryDemand;
  const sectionBonus = Math.floor(Math.max(0, sectionSlack) / sections.length);
  let sectionRemainder = Math.max(0, sectionSlack) % sections.length;
  const rendered = sections.map((section) => {
    const budget = sectionFloor + sectionBonus + (sectionRemainder > 0 ? 1 : 0);
    sectionRemainder = Math.max(0, sectionRemainder - 1);
    return renderAttributedSection(
      section.heading,
      section.entries,
      budget,
      section.emptyText,
      section.entryKind,
    );
  });
  const renderedBytes = rendered.reduce(
    (total, section) => total + Buffer.byteLength(section, "utf8"),
    0,
  );
  const primaryBudget = Math.max(0, availableBytes - renderedBytes);
  return {
    reply: boundedUtf8(
      [
        boundedUtf8(primary.text, primaryBudget),
        ...rendered,
        ...(footer === undefined ? [] : [footer]),
      ].join(separator),
      MAX_FINAL_TEXT_BYTES,
    ),
    messages: [],
    notify: [],
    status: "done",
    retryable: false,
    artifacts: [],
  };
}
