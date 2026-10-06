import { ClientDelegationLabelSchema, isAlias } from "@cauce/protocol";
import { hasNonBlankText } from "../output-parser.js";
import { EmissionGatewayError, type EmissionGateway } from "./tools.js";

/** Who this adapter publishes as when no delivery is in flight: its own tenant, room and alias. */
export interface EmissionIdentity {
  readonly tenant: string;
  readonly room: string;
  readonly alias: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const TERMINAL = new Set(["done", "failed", "dead", "stored"]);

function visible(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !hasNonBlankText(value)) throw new Error(`'${key}' tiene que tener texto visible`);
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function openRootsText(body: unknown): string {
  const roots = Array.isArray(record(body).open_roots) ? record(body).open_roots as unknown[] : [];
  return roots.map((root) => {
    const recipients = Array.isArray(record(root).recipients) ? record(root).recipients as unknown[] : [];
    const targets = recipients.map((item) => `${String(record(item).alias)} (${String(record(item).status)})`);
    return `${String(record(root).message_id)} -> ${targets.join(", ")}`;
  }).join("; ");
}

/** A delivery whose result says it was only stored in a client mailbox: durable storage, never execution. */
function isStoredInClientMailbox(item: unknown): boolean {
  const delivery = record(item);
  const mailbox = record(delivery.client_mailbox);
  return delivery.status === "done" && delivery.attempt === 0
    && mailbox.state === "stored" && Object.keys(mailbox).sort().join(",") === "label,state"
    && ClientDelegationLabelSchema.safeParse(mailbox.label).success;
}

const MAILBOX_NOTE = "Guardado en el buzón del cliente: almacenamiento durable sin consumidor en línea."
  + " No implica que alguien lo haya leído ni ejecutado, ni que arranque un turno.";

/** A root message published now, outside any delivery: one alias of the own tenant, under the caller's key. */
export async function sendOutsideDelivery(
  gateway: EmissionGateway, identity: EmissionIdentity, args: Record<string, unknown>, idempotencyKey: string,
): Promise<Record<string, unknown>> {
  const to = visible(args, "to").trim();
  const text = visible(args, "body");
  if (to === "@all" || to === "@human") throw new Error(`Fuera de una entrega no se puede mandar a ${to}; nombrá un solo alias`);
  if (!isAlias(to)) throw new Error("'to' tiene que ser UN alias válido de tu tenant (sin listas)");
  if (to === identity.alias) throw new Error("No podés mandarte un mensaje a vos mismo");
  let receipt: Record<string, unknown>;
  try {
    receipt = record(await gateway("POST", "/v3/messages", {
      room_id: identity.room, recipients: [{ tenant_id: identity.tenant, alias: to }],
      body: { text }, lane: "interactive", idempotency_key: idempotencyKey,
    }));
  } catch (error) {
    if (error instanceof EmissionGatewayError && error.status === 409 && record(error.body).error === "agent_root_limit") {
      const limit = record(error.body).limit;
      throw new Error(`Ya tenés ${typeof limit === "number" ? String(limit) : "varios"} mensajes abiertos; esperá a que`
        + ` terminen (cauce_result). Abiertos: ${openRootsText(error.body)}`);
    }
    throw error;
  }
  return {
    message_id: receipt.message_id, delivery_ids: receipt.delivery_ids, duplicate: receipt.duplicate,
    nota: receipt.duplicate === true
      ? "Este mismo envío ya se había hecho (la misma llamada, reintentada): no se mandó de nuevo. Mirá su estado con"
        + " cauce_result(message_id)."
      : "Encolado como mensaje nuevo fuera de una entrega; no acredita lectura ni ejecución. La respuesta no vuelve sola a esta"
        + " conversación: consultala con cauce_result(message_id).",
  };
}

/** Status and reply of a message this alias published; readable with or without a turn. */
export async function readResult(gateway: EmissionGateway, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = visible(args, "message_id").trim();
  if (!UUID.test(id)) throw new Error("'message_id' tiene que ser un UUID");
  const message = record(await gateway("GET", `/v3/messages/${encodeURIComponent(id)}`));
  const deliveries = (Array.isArray(message.deliveries) ? message.deliveries : []).map((item) => {
    const delivery = record(item);
    if (isStoredInClientMailbox(delivery)) {
      return { alias: delivery.alias, status: "stored", reply: null, buzon: true };
    }
    return { alias: delivery.alias, status: delivery.status, reply: delivery.reply ?? null };
  });
  return {
    message_id: id,
    terminado: message.chain_open !== true && deliveries.length > 0
      && deliveries.every((item) => TERMINAL.has(String(item.status))),
    ...(deliveries.some((item) => item.buzon === true) ? { nota_buzon: MAILBOX_NOTE } : {}),
    ...(message.chain_open === true ? { cadena: "sigue trabajando: hay delegaciones o una espera humana abiertas" } : {}),
    entregas: deliveries,
  };
}
