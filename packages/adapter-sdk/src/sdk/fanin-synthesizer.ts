import { ALIAS_PATTERN, objectRecord, TENANT_PATTERN } from "@cauce/protocol";
import { AdapterError } from "./errors.js";
import { hasNonBlankText, MAX_FINAL_TEXT_BYTES } from "./output-parser.js";
import type { StructuredOutput } from "./types.js";

const FANIN_SCHEMA = "cauce.agent_fanin_data.v1";
const TRUNCATION_NOTICE = "\n[fan-in synthesis truncated]";
const ENTRY_TRUNCATION_NOTICE = " [entry truncated]";

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
    readonly sourceDeliveryId?: string;
  }[];
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
    `[${String(count)} ${entryKind} ${count === 1 ? "entry" : "entries"} omitted for byte limit]`;
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
    const minimumBytes = minimumEntryBytes[index];
    if (minimumBytes === undefined) throw new Error("Fan-in entry budget is missing");
    const entryBytes = minimumBytes
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
  if (data?.schema !== FANIN_SCHEMA || !Array.isArray(data.responses)) {
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
        `agent.fanin response[${String(index)}] requires canonical tenant_id/alias and string untrusted_text`,
        false,
      );
    }
    const text = hasNonBlankText(response.untrusted_text)
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
    ? `Agent results (${String(completed)} completed):`
    : `Agent results (${String(completed)}/${String(expected)} completed):`;
  const processedReplies = (options.processedReplies ?? [])
    .filter((candidate) =>
      TENANT_PATTERN.test(candidate.tenantId)
      && ALIAS_PATTERN.test(candidate.alias)
      && hasNonBlankText(candidate.reply))
    .map((candidate, order) => ({
      tenantId: candidate.tenantId,
      alias: candidate.alias,
      text: candidate.reply.trim(),
      updatedAt: candidate.updatedAt ?? "",
      order,
      ...(typeof candidate.childDeliveryId === "string" && candidate.childDeliveryId.length > 0
        ? { childDeliveryId: candidate.childDeliveryId }
        : {}),
      ...(typeof candidate.sourceDeliveryId === "string" && candidate.sourceDeliveryId.length > 0
        ? { sourceDeliveryId: candidate.sourceDeliveryId }
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

  // The newest locally processed reply leads and is emitted verbatim: it is this adapter's own
  // last completed turn, and quoting it would collapse a multi-paragraph reply into one line.
  const primary = processedReplies[0];
  if (primary === undefined) throw new Error("Fan-in synthesis has no primary reply");
  const others = processedReplies.slice(1);
  // Older siblings are dropped only when the lead turn was provably handed them: they continue
  // the same fan-out turn, whose branch_progress.already_returned carries the replies this
  // coordinator already wrote under a standing order to carry every one of them into the reply,
  // and the lead closed strictly last, so all of them existed before its prompt was built.
  const carriedByPrimary = others.length > 0
    && primary.sourceDeliveryId !== undefined
    && primary.updatedAt !== ""
    && others.every((reply) =>
      reply.sourceDeliveryId === primary.sourceDeliveryId
      && reply.updatedAt !== ""
      && reply.updatedAt < primary.updatedAt);
  // Coverage is keyed by the branch delivery id the store stamped on each agent.response: a
  // tenant/alias key would collapse two branches delegated to the same alias and silently drop
  // the evidence of the one never synthesized locally. Unproven coverage keeps raw evidence.
  const covered = new Set(processedReplies
    .map((reply) => reply.childDeliveryId)
    .filter((value): value is string => value !== undefined));
  const uncovered = responses.filter((response) =>
    response.deliveryId === undefined || !covered.has(response.deliveryId));
  const sections: {
    readonly heading: string;
    readonly entries: readonly AttributedText[];
    readonly emptyText: string;
    readonly entryKind: string;
  }[] = [];
  if (others.length > 0 && !carriedByPrimary) {
    sections.push({
      heading: others.length === 1
        ? "Other locally processed branch reply (1):"
        : `Other locally processed branch replies (${String(others.length)}):`,
      entries: others,
      emptyText: "No other locally processed replies were available.",
      entryKind: "processed branch",
    });
  }
  if (uncovered.length > 0) {
    sections.push({
      heading: uncovered.length === 1
        ? "Branch without local synthesis (1):"
        : `Branches without local synthesis (${String(uncovered.length)}):`,
      entries: uncovered,
      emptyText: "No branch responses were available.",
      entryKind: "raw branch",
    });
  }

  const footer = `[${String(processedReplies.length)} locally synthesized branch `
    + `${processedReplies.length === 1 ? "reply" : "replies"}; `
    + `${String(responses.length)} branch ${responses.length === 1 ? "response" : "responses"} `
    + `in this chain; ${String(uncovered.length)} without local synthesis]`;
  const separator = "\n\n";
  const separatorBytes = Buffer.byteLength(separator, "utf8");
  const availableBytes = MAX_FINAL_TEXT_BYTES
    - Buffer.byteLength(footer, "utf8")
    - separatorBytes * (sections.length + 1);
  if (sections.length === 0 && availableBytes > 0) {
    return {
      reply: boundedUtf8(`${boundedUtf8(primary.text, availableBytes)}${separator}${footer}`, MAX_FINAL_TEXT_BYTES),
      messages: [],
      notify: [],
      status: "done",
      retryable: false,
      artifacts: [],
    };
  }
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
        footer,
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
