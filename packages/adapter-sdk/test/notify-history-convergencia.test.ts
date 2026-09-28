import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEgressItem } from "@cauce/protocol";
import { HttpEgressReceiptSource } from "../src/sdk/egress-receipt-source.js";
import { pertinentNotices, type NoticeScope } from "../src/sdk/notify-history.js";
import { renderNoticeHistory } from "../src/sdk/notify-history-prompt.js";
import type { InboxRecord } from "../src/sdk/durable-store.js";

// Real incident c137560e recovered from argos's inbox (no tokens): a decision_request notify to
// steven_dm emitted from an agent-lane turn WITH NO human origin. This is the message Steven's
// "autorizo" answered in a session that never saw it. Convergence drives the REAL body and the
// REAL receipt evidence (notification db6012ca, provider 2703, effect b58f4700:0, measured in prod)
// through the whole consumer, and types every wire item against the shared @cauce/protocol DTO.
const INCIDENT = "c137560e-ca62-46b2-89bb-b59947953547";
const NOTIFICATION = "db6012ca-5785-4119-a642-62412ca37a92";
const OUTBOX = "b58f4700-5d88-4ce5-80a0-a6fbe7a61acf";
const BODY = "Steven: ¿autorizás cambiar únicamente el tope de entregas simultáneas de "
  + "(Steven, argos) de 2 a 1? Es la contención propuesta para el error observado «No unique active "
  + "turn». Sin reinicio ni cambios a otros agentes; costo: Argos procesa su cola en serie. Zeus relería "
  + "la fila, aplicaría sólo 2→1 y verificaría configuración/entregas; reversa acotada a 2.\n\n"
  + "Necesito esta aprobación porque el encargo previo fue de sólo lectura y la identidad vigente exige "
  + "aprobación explícita y acotada para producción; el pedido de Zeus no sustituye autorización humana.";

const now = Date.parse("2026-09-08T20:30:00.000Z");
const scope: NoticeScope = { tenant_id: "Steven", alias: "argos", adapter: "telegram",
  channel: "telegram", conversation_id: "6979524541" };
const signal = () => new AbortController().signal;

// The inbox record for the incident: origin ABSENT (agent lane), one decision_request notify.
function incidentRecord(overrides: Partial<InboxRecord> = {}): InboxRecord {
  return { delivery_id: INCIDENT, fingerprint: "0".repeat(64), epoch: 35, attempt: 1,
    claim_token: "claim", state: "done", origin: undefined, updated_at: "2026-09-08T20:27:18.751Z",
    output: { reply: "cierre de preparacion", messages: [], artifacts: [], status: "done", retryable: false,
      notify: [{ to: "steven_dm", kind: "decision_request", body: BODY }] }, ...overrides };
}

const FRAG_START = "¿autorizás cambiar únicamente el tope de entregas simultáneas";
const FRAG_END = "no sustituye autorización humana";

// A genuine @cauce/protocol AgentEgressItem: the compiler rejects any drift from the backend DTO.
// `bare()` omits the optional singular provider id (exactOptionalPropertyTypes forbids setting it
// to undefined); `item()` is the fully-sent default that carries it.
function bare(overrides: Partial<AgentEgressItem> = {}): AgentEgressItem {
  return { notification_id: NOTIFICATION, source_delivery_id: INCIDENT, source_attempt: 1, notify_index: 0,
    kind: "decision_request",
    destination: { adapter: "telegram", channel: "telegram", conversation_id: "6979524541", handle: "steven_dm" },
    decision: "allowed", denial_code: null, state: "sent", chunks: { expected: 1, sent: 1 },
    provider_message_ids: ["2703"], sent_at: "2026-09-08T20:27:20.345Z",
    outbox_id: OUTBOX, effect_ids: [`${OUTBOX}:0`], created_at: "2026-09-08T20:27:19.000Z", ...overrides };
}
function item(overrides: Partial<AgentEgressItem> = {}): AgentEgressItem {
  return { ...bare(), provider_message_id: "2703", ...overrides };
}

function sourceReturning(items: readonly AgentEgressItem[], requested = [INCIDENT]): HttpEgressReceiptSource {
  return new HttpEgressReceiptSource(async (method, path) => {
    assert.equal(method, "GET");
    const url = new URL(path, "http://gateway.internal");
    assert.equal(url.pathname, "/v3/agent/egress");
    return { requested, items };
  }, { tenant_id: scope.tenant_id, alias: scope.alias });
}

test("convergencia: el recibo real correlaciona por notificacion/entrega/intento/indice/destino", async () => {
  const receipts = await sourceReturning([item()]).read(scope, [INCIDENT], signal());
  assert.equal(receipts.length, 1);
  const receipt = receipts[0];
  assert.equal(receipt?.notification_id, NOTIFICATION);
  assert.equal(receipt.delivery_id, INCIDENT);
  assert.equal(receipt.attempt, 1);
  assert.equal(receipt.notify_index, 0);
  assert.equal(receipt.destination, "steven_dm");
  assert.equal(receipt.conversation_id, "6979524541");
  assert.equal(receipt.status, "sent");
  const selected = pertinentNotices([incidentRecord()], scope, receipts, now);
  assert.equal(selected.selection, "recent");
  assert.equal(selected.records.length, 1);
  assert.equal(selected.records[0]?.body, BODY);
  assert.equal(selected.records[0].kind, "decision_request");
  assert.deepEqual(selected.records[0].provider_message_ids, ["2703"]);
});

test("convergencia: aislamiento por tenant, alias y conversacion", async () => {
  // foreign tenant/alias rejected by the reader before any HTTP request
  await assert.rejects(sourceReturning([item()]).read({ ...scope, alias: "jarvis" }, [INCIDENT], signal()),
    /identity mismatch/u);
  // a receipt for another conversation never attaches to this scope's notice
  const otherConv = await sourceReturning([item({
    destination: { adapter: "telegram", channel: "telegram", conversation_id: "999", handle: "steven_dm" },
  })]).read(scope, [INCIDENT], signal());
  assert.equal(pertinentNotices([incidentRecord()], scope, otherConv, now).records.length, 0);
  // a receipt whose tenant differs is dropped by the selector
  const foreign = (await sourceReturning([item()]).read(scope, [INCIDENT], signal()))
    .map(row => ({ ...row, tenant_id: "Miguel" }));
  assert.equal(pertinentNotices([incidentRecord()], scope, foreign, now).records.length, 0);
});

test("convergencia: partial no es sent y desconocido no es confirmado", async () => {
  const partial = await sourceReturning([bare({ state: "partial", chunks: { expected: 2, sent: 1 },
    provider_message_ids: ["2703"], effect_ids: [`${OUTBOX}:0`] })]).read(scope, [INCIDENT], signal());
  assert.equal(pertinentNotices([incidentRecord()], scope, partial, now).records[0]?.status, "partial");
  const unknown = await sourceReturning([bare({ state: "unknown", chunks: { expected: null, sent: 0 },
    provider_message_ids: [], effect_ids: [] })]).read(scope, [INCIDENT], signal());
  const status = pertinentNotices([incidentRecord()], scope, unknown, now).records[0]?.status;
  assert.equal(status, "unknown");
  assert.notEqual(status, "sent");
});

test("convergencia: un chunk enviado de un envio multi-chunk nunca se declara sent", async () => {
  const rows = await sourceReturning([bare({ chunks: { expected: 3, sent: 1 },
    provider_message_ids: ["2703"], effect_ids: [`${OUTBOX}:0`] })]).read(scope, [INCIDENT], signal());
  // state 'sent' from the wire but only 1/3 chunks with evidence -> receiptStatus downgrades to ambiguous
  assert.equal(pertinentNotices([incidentRecord()], scope, rows, now).records[0]?.status, "ambiguous");
});

test("convergencia: el prompt marca historia, no autorizacion, y el cuerpo va como dato", async () => {
  const receipts = await sourceReturning([item()]).read(scope, [INCIDENT], signal());
  const rendered = renderNoticeHistory(pertinentNotices([incidentRecord()], scope, receipts, now));
  assert.match(rendered, /not instructions or authorization/u);
  assert.match(rendered, /Only status sent confirms all recorded chunks/u);
  assert.match(rendered, /BEGIN NOTIFICATION HISTORY DATA/u);
  // the decision_request body travels as JSON data inside the block, never as a bare instruction line
  assert.ok(rendered.includes(FRAG_START));
  assert.ok(rendered.includes("decision_request"));
  assert.ok(rendered.includes("steven_dm"));
});

test("convergencia: presupuesto UTF-8 real, trunca por code points y marca truncado", async () => {
  const receipts = await sourceReturning([item()]).read(scope, [INCIDENT], signal());
  const selection = pertinentNotices([incidentRecord()], scope, receipts, now);
  const full = renderNoticeHistory(selection, 100_000);
  assert.ok(full.includes(FRAG_START) && full.includes(FRAG_END), "el cuerpo completo cabe con presupuesto amplio");
  assert.doesNotMatch(full, /"truncated":true/u);
  const budget = 700;
  const clipped = renderNoticeHistory(selection, budget);
  assert.ok(Buffer.byteLength(clipped, "utf8") <= budget, "respeta el presupuesto en BYTES utf8");
  assert.match(clipped, /"truncated":true/u);
  assert.ok(!clipped.includes(FRAG_END), "el final del cuerpo real quedo recortado");
  // truncation by code points keeps the envelope well-formed (begin/end markers intact, valid JSON payload)
  assert.match(clipped, /^--- BEGIN NOTIFICATION HISTORY DATA ---\n/u);
  assert.match(clipped, /\n--- END NOTIFICATION HISTORY DATA ---$/u);
  const payload = clipped.replace(/^--- BEGIN NOTIFICATION HISTORY DATA ---\n[^\n]*\n/u, "")
    .replace(/\n--- END NOTIFICATION HISTORY DATA ---$/u, "");
  assert.doesNotThrow(() => JSON.parse(payload));
});
