import { request as httpsRequest } from "node:https";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { readOwnerOnlyFile } from "../secure-files.js";

/**
 * The adapter is the identity proxy for decisions: the MCP server holds no credential, and the
 * adapter reaches the decisions service with the alias's own mTLS certificate. Only three fixed
 * operations cross the socket, so no path or header chosen by the model reaches the network.
 */
export interface DecisionesRespuesta { readonly status: number; readonly body: unknown }
export interface DecisionesRespaldo { readonly decision: string; readonly valor: null; readonly motivo: string; readonly caer_a_llm: boolean }
export type DecisionesForwarder = (method: "GET" | "POST", path: string, body?: unknown) => Promise<DecisionesRespuesta>;
export interface DecisionesTls { readonly certFile: string; readonly keyFile: string; readonly caFile: string }
interface DecisionesRoute { readonly method: "GET" | "POST"; readonly path: string; readonly body?: unknown }

/* Above the service's own 30 s budget so its typed timeout, not ours, is what the model reads. */
export const DECISIONES_TIMEOUT_MS = 40_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const PLANTILLA_ID = /^[a-z][a-z0-9_]{1,63}$/u;

const RESPALDO_LLM: DecisionesRespaldo = {
  decision: "llm", valor: null, caer_a_llm: true, motivo: "No hubo decisión de Jev: resolvelo con tu propio razonamiento",
};

/**
 * What the model applies when no answer can come from the service at all. The security templates
 * fail closed here too; each entry must equal that template's si_falla (the decisions service's
 * tests compare them against the catalog).
 */
export const RESPALDO_SIN_SERVICIO: Readonly<Record<string, DecisionesRespaldo>> = {
  aprobacion_humana: { decision: "exige_aprobacion", valor: null, caer_a_llm: false, motivo: "Sin respuesta del servicio de decisiones: falla cerrado, pedí aprobación." },
  guardia_privacidad_jarvis: { decision: "bloquear", valor: null, caer_a_llm: false, motivo: "Sin respuesta del servicio de decisiones: falla cerrado, no lo compartas." },
};

export function respaldoSinServicio(operacion: unknown, argumentos: unknown): DecisionesRespaldo | undefined {
  if (operacion === "listar_plantillas") return undefined;
  const plantilla = typeof argumentos === "object" && argumentos !== null ? (argumentos as Record<string, unknown>).plantilla : undefined;
  return operacion === "decidir_plantilla" && typeof plantilla === "string" ? (RESPALDO_SIN_SERVICIO[plantilla] ?? RESPALDO_LLM) : RESPALDO_LLM;
}

function withRespaldo(status: number, body: unknown, respaldo: DecisionesRespaldo | undefined): DecisionesRespuesta {
  if (respaldo === undefined || status < 400 || typeof body !== "object" || body === null || Array.isArray(body) || "respaldo" in body) return { status, body };
  return { status, body: { ...body, respaldo } };
}

const object = { type: "object" };
export const DECISIONES_TOOLS: Tool[] = [
  {
    name: "listar_plantillas",
    description: "Lista las plantillas de decisión (ruteo, urgencia, aprobación, fallos, etc.) con el state que espera cada una. Con 'plantilla' devuelve su definición completa.",
    inputSchema: { type: "object", properties: { plantilla: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "decidir_plantilla",
    description: "Decide con una plantilla del catálogo (mirá listar_plantillas) en segundos y por una fracción de centavo, sin gastar tokens de LLM. Devuelve decision, valor, confianza, senales y caer_a_llm: si caer_a_llm es true, decidí vos usando las senales como pista. Si devuelve error, aplicá su respaldo (siempre viene; en aprobacion_humana y guardia_privacidad_jarvis falla cerrado). Nunca pongas secretos en state; la identidad la pone el adaptador.",
    inputSchema: {
      type: "object",
      properties: { plantilla: { type: "string" }, state: object, restringir: object },
      required: ["plantilla", "state"],
      additionalProperties: false,
    },
  },
  {
    name: "decidir",
    description: "Pregunta libre a Jev con preguntas tipadas: questions = {id: {type: noul|choice|score, instructions, criteria}}. noul = sí/no (criteria opcional {true,false}); choice = criteria {opcion: descripción}; score = criteria [niveles ordenados, 2 a 10]. Devuelve cada respuesta con certeza y caer_a_llm si alguna queda bajo el umbral. Nunca pongas secretos en state ni en questions: se enmascaran, y en ids u opciones se rechazan.",
    inputSchema: {
      type: "object",
      properties: { state: {}, questions: object, umbrales: object },
      required: ["state", "questions"],
      additionalProperties: false,
    },
  },
];

function argumentsObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Los argumentos deben ser un objeto");
  const args = value as Record<string, unknown>;
  const extra = Object.keys(args).find((key) => !allowed.includes(key));
  if (extra !== undefined) throw new Error(`Argumento inesperado '${extra.slice(0, 40)}': la identidad la pone el adaptador`);
  return args;
}

export function decisionesRoute(operacion: unknown, argumentos: unknown): DecisionesRoute {
  if (operacion === "listar_plantillas") {
    const { plantilla } = argumentsObject(argumentos, ["plantilla"]);
    if (plantilla === undefined) return { method: "GET", path: "/v1/plantillas" };
    if (typeof plantilla !== "string" || !PLANTILLA_ID.test(plantilla)) throw new Error("'plantilla' no es un id de plantilla");
    return { method: "GET", path: `/v1/plantillas/${plantilla}` };
  }
  if (operacion === "decidir_plantilla") {
    const { plantilla, state, restringir } = argumentsObject(argumentos, ["plantilla", "state", "restringir"]);
    return {
      method: "POST",
      path: "/v1/decidir",
      body: { plantilla, state, ...(restringir === undefined ? {} : { opciones: { restringir } }) },
    };
  }
  if (operacion === "decidir") {
    const { state, questions, umbrales } = argumentsObject(argumentos, ["state", "questions", "umbrales"]);
    return { method: "POST", path: "/v1/decidir", body: { state, questions, ...(umbrales === undefined ? {} : { umbrales }) } };
  }
  throw new Error("Operación de decisiones desconocida");
}

/** Returns undefined when the alias has no decisions URL or no mTLS identity: the socket then says so. */
export function decisionesForwarder(url: string | undefined, tls: DecisionesTls | undefined): DecisionesForwarder | undefined {
  if (url === undefined || tls === undefined) return undefined;
  const base = new URL(url);
  return async (method, path, body) => {
    const material = {
      cert: await readOwnerOnlyFile(tls.certFile, "mTLS certificate"),
      key: await readOwnerOnlyFile(tls.keyFile, "mTLS private key"),
      ca: await readOwnerOnlyFile(tls.caFile, "mTLS CA certificate"),
      rejectUnauthorized: true,
    };
    return new Promise((resolve, reject) => {
      const outgoing = httpsRequest(new URL(path, base), {
        method, headers: { "content-type": "application/json", accept: "application/json" }, ...material,
      }, (response) => {
        let received = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          received += chunk;
          if (Buffer.byteLength(received) > MAX_RESPONSE_BYTES) outgoing.destroy(new Error("Decisions response exceeds limit"));
        });
        response.on("error", reject);
        response.on("end", () => {
          let parsed: unknown;
          try { parsed = received.length === 0 ? {} : JSON.parse(received); }
          catch { parsed = { error: "respuesta_invalida", mensaje: "el servicio de decisiones no devolvió JSON" }; }
          resolve({ status: response.statusCode ?? 502, body: parsed });
        });
      });
      outgoing.setTimeout(DECISIONES_TIMEOUT_MS, () => { outgoing.destroy(new Error("Decisions request timed out")); });
      outgoing.on("error", reject);
      outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
  };
}

/** Every failed decision reaches the model with a respaldo: the service's own, or the adapter's. */
export async function answerDecisiones(forwarder: DecisionesForwarder | undefined, operacion: unknown, argumentos: unknown): Promise<DecisionesRespuesta> {
  const respaldo = respaldoSinServicio(operacion, argumentos);
  if (forwarder === undefined) {
    return withRespaldo(503, { error: "decisiones_no_configurado", mensaje: "Este adaptador no tiene servicio de decisiones: aplicá el respaldo" }, respaldo);
  }
  let route: DecisionesRoute;
  try { route = decisionesRoute(operacion, argumentos); }
  catch (error) { return withRespaldo(400, { error: "solicitud_invalida", mensaje: error instanceof Error ? error.message : "solicitud inválida" }, respaldo); }
  try {
    const answer = await forwarder(route.method, route.path, route.body);
    return withRespaldo(answer.status, answer.body, respaldo);
  } catch {
    return withRespaldo(503, { error: "decisiones_inalcanzable", mensaje: "No se pudo llegar al servicio de decisiones: aplicá el respaldo" }, respaldo);
  }
}
