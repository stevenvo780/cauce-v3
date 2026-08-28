import {
  clampToRoleBriefLimit, componerBloqueDePerfil, VERSION_CONTEXTO_FIJO,
  type AgentProfile, type ArnesDelAlias, type ContextoDeAlias, type CuotaDelAlias,
  type HechosDelAlias, type PermisosDelAlias,
} from "@cauce/protocol";
import { resumirContextoFijo } from "../harnesses/contexto-fijo.js";

/**
 * CONTEXT COMPILER: profile + harness facts -> the text that goes to the file.
 *
 * What this does NOT do — that's the point.
 *
 * It does not invent the contract wording. The fixed prose —identity, PRIMARY DUTY, protocol
 * invariants, delegation mechanics— already exists, is tested, and is composed by
 * `textoFijoDelSobre()` in `harnesses/shared.ts`. The managed-block seal is the sha256 of THAT
 * exact text: if this module reformatted it —a title in front, a comma changed, sections in a
 * different order— the seal would never match, the adapter would keep sending the full envelope,
 * and the savings would be exactly zero, with no visible error.
 *
 * What this module composes is ALIAS content: the seven facets of the profile, in a text that
 * feeds the `Tu rol:` line of the identity preamble. Nothing more.
 *
 * Where each facet comes from.
 *
 * Four are AUTHORED and live in `agent_profiles`: identity and purpose; role, responsibilities and
 * restrictions; declared tools; fixed alias instructions.
 *
 * Three are FACTS and are NOT stored: permissions (`memberships` + `role_policies`), quotas
 * (`provider_accounts`) and harness configuration (`agents` + `harness_definitions`). They arrive
 * as `HechosDelAlias` and are joined here. Storing them as authored text would manufacture a
 * second source of truth: the permission is revoked in the database and the container file keeps
 * saying it has it.
 *
 * Determinism.
 *
 * Same profile and same facts -> same bytes, always. No dates, no clocks, no incidental
 * `Object.keys` order: sections are emitted in a FIXED order declared in the code, and the
 * openclaw projection JSON goes through `serializarEstable`, which sorts keys. A non-deterministic
 * compiler would let the seal drift on its own, and every seal change costs a rewrite of the file
 * in every container of the fleet.
 */

/*
 * The fact types —`PermisosDelAlias`, `CuotaDelAlias`, `ArnesDelAlias`, `HechosDelAlias`— live in
 * `@cauce/protocol` and NOT here. `@cauce/store` produces them by reading `memberships`/
 * `role_policies`, the routing-ceiling path, and `agents`+`harness_definitions`; this module
 * consumes them: the two layers cannot import each other, and `@cauce/protocol` is the only one
 * both see. Re-exported so compilers don't have to import from two places.
 */
export type { ArnesDelAlias, ContextoDeAlias, CuotaDelAlias, HechosDelAlias, PermisosDelAlias };

/**
 * Keys of `openclaw.json` the projection must NEVER emit.
 *
 * `openclaw.json` keeps `auth` and `secrets` in the SAME document as the directive; that is why
 * it is on the "never served" list of the pty-agent and gateway, and why openclaw seeding is a
 * field-by-field projection and never a full-file write. Exported so the test can verify absence
 * against this list and not against a copy of its own that drifts.
 */
export const CLAVES_PROHIBIDAS_OPENCLAW = [
  "auth", "secrets", "credentials", "tokens", "apiKey", "api_key",
] as const;

/*
 * `componerBloqueDePerfil` and its helpers MOVED to `@cauce/protocol/agent-profile.ts`.
 *
 * Reason: the gateway needs the same composition to show a PREVIEW of what will be written, and
 * cannot import this package —`@cauce/adapter-sdk` is the agent runtime: it drags the engine, the
 * websocket transport, the process launcher and the credential resolver, none of which has any
 * place inside a server—. `@cauce/protocol` is the only one both layers see, which is exactly the
 * argument for which the fact types already lived there.
 *
 * Preview and seeding coming from THE SAME function is what prevents the preview from lying: two
 * implementations of the same text diverge at the first fix, and the operator would approve a
 * block different from what ends up on disk with nothing reporting an error.
 *
 * Re-exported so nothing already importing from here has to change location.
 */
export {
  componerBloqueDePerfil,
  // Composition helpers travel with it: `ficheros-del-arnes.ts` distributes the same sections
  // across the seven openclaw Markdowns, and if it recomposed them on its own the standalone file
  // and the single block would say the same thing in different words at the first fix. One
  // implementation, two ways of distributing it.
  lineasDeArnes,
  lineasDeCuotas,
  lineasDePermisos,
  seccion,
  vinetas,
} from "@cauce/protocol";

/**
 * Deterministic JSON: keys ALWAYS come out in the same order, however they were inserted.
 *
 * `JSON.stringify` respects insertion order, so the same object built from two different sites
 * —or coming from a `JSON.parse` of another source— produces different bytes and therefore a
 * different seal. Sorting keys makes determinism not depend on how the object was assembled,
 * which is the only way it is a guarantee and not a coincidence.
 */
export function serializarEstable(valor: unknown): string {
  return JSON.stringify(ordenar(valor), null, 2);
}

function ordenar(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(ordenar);
  if (valor === null || typeof valor !== "object") return valor;
  const entradas = Object.entries(valor as Record<string, unknown>)
    .sort(([izquierda], [derecha]) => (izquierda < derecha ? -1 : izquierda > derecha ? 1 : 0));
  const ordenado: Record<string, unknown> = {};
  for (const [clave, contenido] of entradas) ordenado[clave] = ordenar(contenido);
  return ordenado;
}

/**
 * The openclaw projection: ONLY the `agents.<alias>` subtree, never the file.
 *
 * `openclaw.json` keeps `auth` and `secrets` in the same document as the directive. Treating it
 * as a text file and rewriting it whole is how a credential is leaked or lost, and that is why
 * `rutaDelContextoFijo()` returns `undefined` for openclaw on purpose: that harness has no file
 * path, it has a projection path, and this is it.
 *
 * What is returned is a FRAGMENT to merge field-by-field against the live document. This module
 * does not read `openclaw.json`, does not parse it, does not write it: it cannot leak what it
 * never had in front of it. The seal travels INSIDE the fragment so the container's freshness can
 * be checked without rereading the profile or the rest of the document.
 */
export function proyeccionOpenclaw(alias: string, bloque: string): string {
  return serializarEstable({
    agents: {
      [alias]: {
        instructions: bloque,
        cauce: { version: VERSION_CONTEXTO_FIJO, sha256: resumirContextoFijo(bloque) },
      },
    },
  });
}

// ── BLOCK B: the profile, outside the sealed block ──────────────────────────────────────────

/**
 * The harness file contains two blocks with distinct, non-overlapping markers:
 *   BLOCK A (sealed) — contract between `MARCA_INICIO`/`MARCA_FIN`, summarized by the seal.
 *   BLOCK B (unsealed) — rich profile between `MARCA_PERFIL_INICIO`/`MARCA_PERFIL_FIN`.
 * Separating them lets the envelope omit block A when the seal matches, without sacrificing the
 * full profile that the harness reads from the whole file.
 */
export {
  bloqueDePerfil, conBloqueDePerfil, MARCA_PERFIL_FIN, MARCA_PERFIL_INICIO, VERSION_PERFIL,
} from "@cauce/protocol";

/**
 * The short `role_brief` carried in the envelope, DERIVED from the profile.
 *
 * Deriving it instead of writing it separately is what keeps a single source of truth: two
 * hand-written texts for the same thing drift, which is exactly the problem the `agent_profiles`
 * table came to solve.
 *
 * Truncated with `clampToRoleBriefLimit`, which cuts by CODE POINTS. `slice(0, 1200)` indexes
 * UTF-16 units and would split an emoji in half, leaving a stray surrogate that serializes as
 * U+FFFD: the agent would receive its own role ending in a broken character.
 *
 * `null` when no role is declared, so the preamble omits the `Tu rol:` line instead of inventing
 * one — a wrong role is worse than none.
 */
export function rolBreveDelPerfil(perfil: AgentProfile): string | null {
  if (perfil.role_summary === null) return null;
  const normalized = perfil.role_summary.trim();
  return normalized.length === 0 ? null : clampToRoleBriefLimit(normalized);
}

/** Compiles the profile block from the alias context returned by the store. */
export function compilarContexto(contexto: ContextoDeAlias): string {
  return componerBloqueDePerfil(contexto.perfil, contexto.hechos);
}
