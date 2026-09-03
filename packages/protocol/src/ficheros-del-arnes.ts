import {
  componerBloqueDePerfil, measureStrictestUnits, seccion, vinetas,
  type AgentProfile, type ContextoDeAlias,
} from "./agent-profile.js";
import { MAX_CODEX_PROJECT_DOC_BYTES } from "./governance-documents.js";
import {
  MARCA_FIN,
  MARCA_INICIO,
  MARCA_PERFIL_FIN,
  MARCA_PERFIL_INICIO,
  bloqueDePerfil,
  conBloqueDePerfil,
  sinBloqueDePerfil,
} from "./marcas-de-bloque.js";

export const VERSION_REVISION_PERFIL = "1";
export const PREFIJO_REVISION_PERFIL = "<!-- CAUCE:REVISION-PERFIL";

interface RevisionLine {
  readonly start: number;
  readonly end: number;
  readonly revision: number;
}

interface StrictBlock {
  readonly start: number;
  readonly end: number;
}

export type ManagedContextEditConflict =
  | "malformed_current"
  | "malformed_proposed"
  | "managed_fixed_context_changed"
  | "managed_profile_changed"
  | "managed_profile_revision_changed"
  | "reserved_markers_changed"
  | "reserved_markers_on_create"
  | "unknown_reserved_markers_in_current"
  | "unknown_reserved_markers_in_proposed";

export type ManagedContextEditVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly conflict: ManagedContextEditConflict };

interface ManagedContextSnapshot {
  readonly fixedContext?: string;
  readonly profile?: string;
  readonly profileRevision?: string;
  readonly reservedMarkers: readonly string[];
  readonly hasUnknownReservedMarkers: boolean;
}

const RESERVED_MARKER_PREFIX = "<!-- CAUCE:";
const RESERVED_MARKER_PATTERN = /^<!-- CAUCE:[^<>\r\n]* -->$/u;
const REVISION_MARKER_PATTERN = new RegExp(
  `^${PREFIJO_REVISION_PERFIL} v${VERSION_REVISION_PERFIL} revision=([1-9][0-9]*) -->$`,
  "u",
);
const KNOWN_RESERVED_MARKERS = new Set([
  MARCA_INICIO,
  MARCA_FIN,
  MARCA_PERFIL_INICIO,
  MARCA_PERFIL_FIN,
]);

export function marcaDeRevisionDelPerfil(revision: number): string {
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new RangeError("profile revision must be a positive safe integer");
  }
  return `${PREFIJO_REVISION_PERFIL} v${VERSION_REVISION_PERFIL} revision=${String(revision)} -->`;
}

function occurrences(text: string, marker: string): number {
  let total = 0;
  for (
    let position = text.indexOf(marker);
    position !== -1;
    position = text.indexOf(marker, position + 1)
  ) total += 1;
  return total;
}

function isFullLine(text: string, position: number, length: number): boolean {
  const before = position === 0 || text[position - 1] === "\n";
  const afterPosition = position + length;
  const after = afterPosition === text.length
    || text[afterPosition] === "\n"
    || (text[afterPosition] === "\r" && text[afterPosition + 1] === "\n");
  return before && after;
}

function strictBlock(
  text: string,
  startMarker: string,
  endMarker: string,
  name: string,
): StrictBlock | undefined {
  const starts = occurrences(text, startMarker);
  const ends = occurrences(text, endMarker);
  if (starts === 0 && ends === 0) return undefined;
  if (starts !== 1 || ends !== 1) {
    throw new Error(`native profile file has malformed or repeated ${name} markers`);
  }
  const start = text.indexOf(startMarker);
  const closing = text.indexOf(endMarker);
  if (closing <= start
    || !isFullLine(text, start, startMarker.length)
    || !isFullLine(text, closing, endMarker.length)) {
    throw new Error(`native profile file has malformed ${name} marker topology`);
  }
  return { start, end: closing + endMarker.length };
}

function validateManagedBlockTopology(text: string, rejectCarriageReturns: boolean): void {
  if (rejectCarriageReturns && text.includes("\r")) {
    throw new Error("native profile projection does not accept CR or CRLF line endings");
  }
  const fixed = strictBlock(text, MARCA_INICIO, MARCA_FIN, "fixed-context");
  const profile = strictBlock(text, MARCA_PERFIL_INICIO, MARCA_PERFIL_FIN, "profile");
  if (fixed !== undefined && profile !== undefined
    && fixed.start < profile.end && profile.start < fixed.end) {
    throw new Error("native profile file has overlapping managed blocks");
  }
}

export function validaTopologiaDeBloquesGestionados(text: string): void {
  validateManagedBlockTopology(text, true);
}

function revisionLine(text: string, rejectCarriageReturns = true): RevisionLine | undefined {
  validateManagedBlockTopology(text, rejectCarriageReturns);
  const position = text.indexOf(PREFIJO_REVISION_PERFIL);
  if (position === -1) return undefined;
  if (text.includes(PREFIJO_REVISION_PERFIL, position + PREFIJO_REVISION_PERFIL.length)) {
    throw new Error("native profile file has repeated revision markers");
  }
  const start = text.lastIndexOf("\n", position - 1) + 1;
  const newline = text.indexOf("\n", position);
  const physicalEnd = newline === -1 ? text.length : newline;
  const end = physicalEnd > start && text[physicalEnd - 1] === "\r"
    ? physicalEnd - 1
    : physicalEnd;
  const line = text.slice(start, end);
  const exact = REVISION_MARKER_PATTERN.exec(line);
  if (start !== position || exact === null) {
    throw new Error("native profile file has a malformed revision marker");
  }
  const after = newline === -1 ? end : newline + 1;
  if (!text.startsWith(MARCA_PERFIL_INICIO, after)) {
    throw new Error("native profile revision marker is not adjacent to the profile block");
  }
  const revision = Number(exact[1]);
  if (!Number.isSafeInteger(revision)) {
    throw new Error("native profile revision marker is outside the safe integer range");
  }
  return { start, end, revision };
}

export function revisionDelPerfil(text: string): number | undefined {
  return revisionLine(text)?.revision;
}

export function conRevisionDelPerfil(text: string, revision: number): string {
  const marker = marcaDeRevisionDelPerfil(revision);
  const existing = revisionLine(text);
  if (existing !== undefined) {
    return text.slice(0, existing.start) + marker + text.slice(existing.end);
  }
  validaTopologiaDeBloquesGestionados(text);
  const profile = text.indexOf(MARCA_PERFIL_INICIO);
  if (profile === -1) throw new Error("native profile revision requires a managed profile block");
  return `${text.slice(0, profile)}${marker}\n${text.slice(profile)}`;
}

function reservedMarkerLines(text: string): {
  readonly markers: readonly string[];
  readonly hasUnknown: boolean;
} {
  const markers: string[] = [];
  let hasUnknown = false;
  for (const physicalLine of text.split("\n")) {
    const line = physicalLine.endsWith("\r") ? physicalLine.slice(0, -1) : physicalLine;
    if (!line.includes(RESERVED_MARKER_PREFIX)) continue;
    if (!RESERVED_MARKER_PATTERN.test(line)) {
      throw new Error("native profile file has a malformed reserved CAUCE marker");
    }
    markers.push(line);
    if (!KNOWN_RESERVED_MARKERS.has(line) && !REVISION_MARKER_PATTERN.test(line)) {
      hasUnknown = true;
    }
  }
  return { markers, hasUnknown };
}

function managedContextSnapshot(text: string): ManagedContextSnapshot {
  validateManagedBlockTopology(text, false);
  const fixed = strictBlock(text, MARCA_INICIO, MARCA_FIN, "fixed-context");
  const profile = strictBlock(text, MARCA_PERFIL_INICIO, MARCA_PERFIL_FIN, "profile");
  const revision = revisionLine(text, false);
  const reserved = reservedMarkerLines(text);
  const revisionAfter = revision === undefined
    ? undefined
    : (() => {
      const newline = text.indexOf("\n", revision.end);
      return newline === -1 ? revision.end : newline + 1;
    })();
  return {
    ...(fixed === undefined ? {} : { fixedContext: text.slice(fixed.start, fixed.end) }),
    ...(profile === undefined ? {} : { profile: text.slice(profile.start, profile.end) }),
    ...(revision === undefined || revisionAfter === undefined
      ? {}
      : { profileRevision: text.slice(revision.start, revisionAfter) }),
    reservedMarkers: reserved.markers,
    hasUnknownReservedMarkers: reserved.hasUnknown,
  };
}

export function verifyManagedContextEdit(
  current: string | undefined,
  proposed: string,
): ManagedContextEditVerdict {
  let currentSnapshot: ManagedContextSnapshot | undefined;
  if (current !== undefined) {
    try {
      currentSnapshot = managedContextSnapshot(current);
    } catch {
      return { allowed: false, conflict: "malformed_current" };
    }
    if (currentSnapshot.hasUnknownReservedMarkers) {
      return { allowed: false, conflict: "unknown_reserved_markers_in_current" };
    }
  }

  let proposedSnapshot: ManagedContextSnapshot;
  try {
    proposedSnapshot = managedContextSnapshot(proposed);
  } catch {
    return { allowed: false, conflict: "malformed_proposed" };
  }

  if (current === undefined) {
    return proposedSnapshot.reservedMarkers.length === 0
      ? { allowed: true }
      : { allowed: false, conflict: "reserved_markers_on_create" };
  }
  if (proposedSnapshot.hasUnknownReservedMarkers) {
    return { allowed: false, conflict: "unknown_reserved_markers_in_proposed" };
  }
  if (currentSnapshot === undefined) {
    return { allowed: false, conflict: "malformed_current" };
  }

  if (currentSnapshot.fixedContext !== proposedSnapshot.fixedContext) {
    return { allowed: false, conflict: "managed_fixed_context_changed" };
  }
  if (currentSnapshot.profile !== proposedSnapshot.profile) {
    return { allowed: false, conflict: "managed_profile_changed" };
  }
  if (currentSnapshot.profileRevision !== proposedSnapshot.profileRevision) {
    return { allowed: false, conflict: "managed_profile_revision_changed" };
  }
  if (currentSnapshot.reservedMarkers.length !== proposedSnapshot.reservedMarkers.length
      || currentSnapshot.reservedMarkers.some(
        (marker, index) => marker !== proposedSnapshot.reservedMarkers[index]
      )) {
    return { allowed: false, conflict: "reserved_markers_changed" };
  }
  return { allowed: true };
}

/**
 * Generator of harness files from a profile and alias facts. `MEMORY.md` and `HEARTBEAT.md` in
 * `openclaw` are agent-managed and are not overwritten if they exist.
 */

/** Per-file and total size caps for openclaw, measured in UTF-16 units. */
export const TOPES_OPENCLAW = { porFichero: 60_000, total: 150_000 } as const;

export type UnidadDeTope = "utf16_strictest" | "utf8_bytes";

export type FuenteDeTope = "default" | "measured";

export interface PresupuestoDeContexto {
  readonly unit: UnidadDeTope;
  readonly porFichero?: number;
  readonly total?: number;
  /** Absent means the harness default table; `measured` means the per-alias fact won. */
  readonly fuente?: FuenteDeTope;
}

/** What Codex applies to a project document unless the alias `config.toml` overrides it. */
export const TOPE_CODEX_POR_DEFECTO_BYTES = 32 * 1_024;

export type ArnesDeGobierno = "claude" | "codex" | "hermes" | "openclaw";

/** The one budget table. A harness without `porFichero`/`total` declares no cap of its own. */
export const PRESUPUESTOS_DE_CONTEXTO: Readonly<Record<ArnesDeGobierno, PresupuestoDeContexto>> = {
  claude: { unit: "utf16_strictest" },
  codex: { unit: "utf8_bytes", porFichero: TOPE_CODEX_POR_DEFECTO_BYTES },
  hermes: { unit: "utf16_strictest" },
  openclaw: { unit: "utf16_strictest", ...TOPES_OPENCLAW },
};

export function presupuestoDeContexto(harness: string): PresupuestoDeContexto | undefined {
  return Object.hasOwn(PRESUPUESTOS_DE_CONTEXTO, harness)
    ? PRESUPUESTOS_DE_CONTEXTO[harness as ArnesDeGobierno]
    : undefined;
}

function medirEnUnidad(texto: string, unidad: UnidadDeTope): number {
  return unidad === "utf8_bytes" ? Buffer.byteLength(texto, "utf8") : measureStrictestUnits(texto);
}

export interface HechosDePresupuestoDeContexto {
  /** `project_doc_max_bytes` measured in the alias `config.toml`. */
  readonly codexProjectDocMaxBytes?: number | undefined;
}

export function presupuestoDeContextoMedido(
  harness: string,
  hechos: HechosDePresupuestoDeContexto = {},
): PresupuestoDeContexto | undefined {
  const porDefecto = presupuestoDeContexto(harness);
  if (porDefecto === undefined || harness !== "codex") return porDefecto;
  const medido = hechos.codexProjectDocMaxBytes;
  if (medido === undefined || !Number.isSafeInteger(medido)
    || medido < 1 || medido > MAX_CODEX_PROJECT_DOC_BYTES) return porDefecto;
  return { unit: porDefecto.unit, porFichero: medido, fuente: "measured" };
}

const TOPE_DE_CODEX_EN_TOML = /^project_doc_max_bytes\s*=\s*\+?([0-9](?:_?[0-9])*)\s*(?:#.*)?$/u;

/** Reads the key from the ROOT table of a Codex `config.toml`; anything else fails closed. */
export function topeDeCodexEnConfigToml(texto: string): number | undefined {
  let valor: number | undefined;
  for (const cruda of texto.split("\n")) {
    const linea = cruda.replace(/\r$/u, "").trim();
    if (linea.startsWith("[")) break;
    const encontrado = TOPE_DE_CODEX_EN_TOML.exec(linea);
    if (encontrado === null) continue;
    if (valor !== undefined) return undefined;
    const numero = Number(encontrado[1]?.replaceAll("_", ""));
    if (!Number.isSafeInteger(numero) || numero < 1 || numero > MAX_CODEX_PROJECT_DOC_BYTES) {
      return undefined;
    }
    valor = numero;
  }
  return valor;
}

/** The seven openclaw files, in the order they are emitted. */
export const FICHEROS_OPENCLAW = [
  "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "HEARTBEAT.md", "AGENTS.md", "TOOLS.md",
] as const;

/**
 * Files that belong to the AGENT, not to the authored profile.
 *
 * They are seeded only when missing and from then on the agent writes them. Their sha is NOT a
 * stable fact about the profile: it changes the moment the agent writes its own memory, which is
 * its job. That is why the adapter does not measure them and the runtime contract cannot demand
 * them — demanding them made adoption impossible for every openclaw alias, because the expectation
 * listed seven documents and the measurement produced five, and the match is exact by set.
 *
 * The two ends read THIS list. Duplicating the names is what let them drift apart.
 */
export const FICHEROS_DEL_AGENTE = ["MEMORY.md", "HEARTBEAT.md"] as const;

export function esFicheroDelAgente(nombre: string): boolean {
  return (FICHEROS_DEL_AGENTE as readonly string[]).includes(nombre);
}

export interface RaizDeDocumentosDelArnes {
  readonly hecho: "claudeConfigDir" | "codexHome" | "home" | "openclawWorkspace";
  /** Directory under a canonical HOME used when that fact is absent. Absent = fail closed. */
  readonly porDefectoBajoHome?: string;
}

export interface DocumentosDeGobiernoDelArnes {
  readonly raiz: RaizDeDocumentosDelArnes;
  readonly documentos: readonly string[];
}

/** The one path table for governance documents; gateway, adapter and pty-agent all read it. */
export const DOCUMENTOS_DE_GOBIERNO:
Readonly<Record<ArnesDeGobierno, DocumentosDeGobiernoDelArnes>> = {
  claude: {
    raiz: { hecho: "claudeConfigDir", porDefectoBajoHome: ".claude" }, documentos: ["CLAUDE.md"],
  },
  codex: {
    raiz: { hecho: "codexHome", porDefectoBajoHome: ".codex" }, documentos: ["AGENTS.md"],
  },
  hermes: { raiz: { hecho: "home" }, documentos: ["AGENTS.md"] },
  openclaw: { raiz: { hecho: "openclawWorkspace" }, documentos: FICHEROS_OPENCLAW },
};

export interface HechosDeRutasDelArnes {
  readonly home?: string | undefined;
  readonly claudeConfigDir?: string | undefined;
  readonly codexHome?: string | undefined;
  readonly openclawWorkspace?: string | undefined;
}

const MAX_RUTA_DE_GOBIERNO = 4_096;

function directorioCanonico(valor: string | undefined): string | undefined {
  if (valor === undefined) return undefined;
  const recortado = valor.trim();
  if (recortado.length === 0 || recortado.length > MAX_RUTA_DE_GOBIERNO) return undefined;
  if (!recortado.startsWith("/") || recortado.includes("\0")) return undefined;
  const sinCola = recortado.replace(/\/+$/u, "");
  if (sinCola.length === 0) return undefined;
  const segmentos = sinCola.split("/").slice(1);
  return segmentos.some((parte) => parte.length === 0 || parte === "." || parte === "..")
    ? undefined
    : sinCola;
}

export function harnessDocumentDirectory(
  harness: string,
  hechos: HechosDeRutasDelArnes,
): string | undefined {
  if (!Object.hasOwn(DOCUMENTOS_DE_GOBIERNO, harness)) return undefined;
  const { raiz } = DOCUMENTOS_DE_GOBIERNO[harness as ArnesDeGobierno];
  const declarado = hechos[raiz.hecho];
  if (declarado !== undefined && declarado.trim().length > 0) return directorioCanonico(declarado);
  if (raiz.porDefectoBajoHome === undefined) return undefined;
  const home = directorioCanonico(hechos.home);
  return home === undefined ? undefined : `${home}/${raiz.porDefectoBajoHome}`;
}

export function harnessDocumentPaths(
  harness: string,
  hechos: HechosDeRutasDelArnes,
): readonly string[] {
  const directorio = harnessDocumentDirectory(harness, hechos);
  if (directorio === undefined) return [];
  return DOCUMENTOS_DE_GOBIERNO[harness as ArnesDeGobierno].documentos
    .map((nombre) => `${directorio}/${nombre}`);
}

export const ETIQUETAS_DE_UNIDAD: Readonly<Record<UnidadDeTope, string>> = {
  utf16_strictest: "unidades UTF-16",
  utf8_bytes: "bytes UTF-8",
};

export const ETIQUETAS_DE_FUENTE: Readonly<Record<FuenteDeTope, string>> = {
  default: "tope por defecto del arnés",
  measured: "tope medido del alias",
};

/** Error thrown when a generated file or the total exceeds the cap configured for the harness. */
export class ErrorDeTopeDelArnes extends Error {
  constructor(
    readonly fichero: string,
    readonly medido: number,
    readonly tope: number,
    readonly unidad: UnidadDeTope = "utf16_strictest",
    readonly fuente: FuenteDeTope = "default",
  ) {
    const cuenta = `${String(medido)} ${ETIQUETAS_DE_UNIDAD[unidad]}`;
    const origen = ETIQUETAS_DE_FUENTE[fuente];
    super(
      fichero === "total"
        ? `los ficheros del arnés suman ${cuenta} y el tope total es ${String(tope)} (${origen})`
        : `${fichero} mide ${cuenta} y el tope por fichero es ${String(tope)} (${origen})`,
    );
    this.name = "ErrorDeTopeDelArnes";
  }
}

export type PoliticaDeFichero =
  | "bloque-gestionado"
  | "solo-si-falta";

export interface FicheroGenerado {
  readonly nombre: string;
  readonly politica: PoliticaDeFichero;
  readonly texto: string;
  readonly escribir: boolean;
}

export interface OpcionesDeProyeccionDelPerfil {
  readonly revision?: number;
  /** The measured per-alias budget. It always wins over the harness default. */
  readonly topes?: PresupuestoDeContexto;
}

export function nombresDelArnes(harness: string): readonly string[] {
  if (harness === "claude") return ["CLAUDE.md"];
  if (harness === "codex") return ["AGENTS.md"];
  if (harness === "openclaw") return [...FICHEROS_OPENCLAW];
  return [];
}

function bloqueDeFichero(nombre: string, perfil: AgentProfile): string {
  if (nombre === "SOUL.md") {
    return unir([seccion("Identidad y propósito", perfil.purpose ?? undefined)]);
  }
  if (nombre === "IDENTITY.md") {
    return unir([seccion("Rol", perfil.role_summary ?? undefined)]);
  }
  if (nombre === "USER.md") {
    return unir([seccion("Tu humano y cómo tratarlo", perfil.human_brief ?? undefined)]);
  }
  if (nombre === "AGENTS.md") {
    // Only authored, stable rules.
    const autorado = unir([
      seccion("Responsabilidades",
        perfil.responsibilities.length > 0 ? vinetas(perfil.responsibilities) : undefined),
      seccion("Restricciones",
        perfil.restrictions.length > 0 ? vinetas(perfil.restrictions) : undefined),
      seccion("Instrucciones fijas de funcionamiento",
        perfil.operating_rules.length > 0 ? vinetas(perfil.operating_rules) : undefined),
    ]);
    if (autorado.length === 0) return "";
    return autorado;
  }
  if (nombre === "TOOLS.md") {
    // Only declared tools.
    if (perfil.tools.length === 0) return "";
    return seccion("Herramientas", vinetas(perfil.tools)) ?? "";
  }
  // MEMORY.md and HEARTBEAT.md do not receive generated content; they are managed by the agent.
  return "";
}

function unir(partes: readonly (string | undefined)[]): string {
  return partes.filter((parte): parte is string => parte !== undefined && parte.trim().length > 0)
    .join("\n\n");
}

/**
 * Files assigned to the harness with the blocks merged on top of the existing content.
 * Throws ErrorDeTopeDelArnes if the size exceeds the configured limit.
 */
export function ficherosDelArnes(
  harness: string,
  contexto: ContextoDeAlias,
  existentes: ReadonlyMap<string, string> = new Map(),
  opciones: OpcionesDeProyeccionDelPerfil = {},
): readonly FicheroGenerado[] {
  const nombres = nombresDelArnes(harness);
  if (nombres.length === 0) return [];
  const generados: FicheroGenerado[] = [];
  const nombreCanonico = harness === "claude" ? "CLAUDE.md" : "AGENTS.md";
  const revisionNativa = harness === "claude" || harness === "openclaw"
    ? opciones.revision
    : undefined;
  for (const nombre of nombres) {
    if (esDelAgente(harness, nombre)) continue;
    const existente = existentes.get(nombre) ?? "";
    if (revisionNativa === undefined && !existente.includes(PREFIJO_REVISION_PERFIL)) continue;
    validaTopologiaDeBloquesGestionados(existente);
    const revisionExistente = revisionDelPerfil(existente);
    if (revisionExistente !== undefined && nombre !== nombreCanonico) {
      throw new Error(`${nombre} has a profile revision marker outside the canonical file`);
    }
    if (revisionExistente !== undefined && revisionNativa === undefined) {
      throw new Error("a revisioned native profile requires an explicit durable revision");
    }
  }

  for (const nombre of nombres) {
    const previo = existentes.get(nombre);

    // MEMORY and HEARTBEAT: managed by the agent. If they exist they are not modified.
    if (esDelAgente(harness, nombre)) {
      generados.push({
        nombre, politica: "solo-si-falta",
        texto: previo ?? "",
        escribir: previo === undefined,
      });
      continue;
    }
    const cuerpo = harness === "openclaw"
      ? bloqueDeFichero(nombre, contexto.perfil)
      : componerBloqueDePerfil(contexto.perfil, contexto.hechos, { includeDerivedFacts: true });
    const canonico = esFicheroCanonico(harness, nombre);
    const bloque = cuerpo.trim().length === 0
      ? canonico && revisionNativa !== undefined ? renglonDeDueno(contexto.perfil) : ""
      : `${renglonDeDueno(contexto.perfil)}\n${cuerpo}`;

    // If the block is empty and a previous block existed, remove it and keep the rest of the file.
    const anterior = previo === undefined ? undefined : bloqueDePerfil(previo);

    // Ownership guard: only modified or removed if the block belongs to the same alias.
    if (anterior !== undefined && !esDelMismoAlias(anterior, contexto.perfil)) {
      generados.push({
        nombre, politica: "bloque-gestionado", texto: previo ?? "", escribir: false,
      });
      continue;
    }

    if (bloque.trim().length === 0) {
      const teniaBloque = anterior !== undefined;
      if (!teniaBloque) {
        generados.push({
          nombre, politica: "bloque-gestionado", texto: previo ?? "", escribir: false,
        });
        continue;
      }
      const limpio = sinBloqueDePerfil(previo ?? "");
      generados.push({
        nombre, politica: "bloque-gestionado", texto: limpio, escribir: limpio !== previo,
      });
      continue;
    }

    let texto = conBloqueDePerfil(previo ?? "", bloque);
    if (revisionNativa !== undefined) {
      if (canonico) texto = conRevisionDelPerfil(texto, revisionNativa);
    }
    if (revisionNativa !== undefined) {
      validaTopologiaDeBloquesGestionados(texto);
      const revisionGenerada = revisionDelPerfil(texto);
      if (canonico && revisionGenerada !== revisionNativa) {
        throw new Error(`${nombre} does not identify the requested durable profile revision`);
      }
      if (!canonico && revisionGenerada !== undefined) {
        throw new Error(`${nombre} has a profile revision marker outside the canonical file`);
      }
      assertNoReservedMarkersInProfile(texto, nombre);
    }
    generados.push({
      nombre, politica: "bloque-gestionado", texto, escribir: texto !== previo,
    });
  }

  comprobarTopes(generados, opciones.topes ?? presupuestoDeContexto(harness));
  return generados;
}

function assertNoReservedMarkersInProfile(text: string, name: string): void {
  const block = bloqueDePerfil(text);
  if (block === undefined) return;
  if (block.includes("<!-- CAUCE:")) {
    throw new Error(`${name} has a reserved Cauce marker inside the authored profile block`);
  }
}

/** HTML comment with the identifier of the alias that owns the block. */
function renglonDeDueno(perfil: AgentProfile): string {
  return `<!-- alias: ${perfil.tenant_id}/${perfil.alias} -->`;
}

/** The alias that declares a block, or `undefined` if it does not declare one. */
function duenoDelBloque(bloque: string): string | undefined {
  return /^\s*<!--\s*alias:\s*([^\s>]+)\s*-->/.exec(bloque)?.[1];
}

/** Checks whether the existing block belongs to the same alias and tenant. */
function esDelMismoAlias(anterior: string, perfil: AgentProfile): boolean {
  const suyo = duenoDelBloque(anterior);
  return suyo !== undefined && suyo === `${perfil.tenant_id}/${perfil.alias}`;
}

/** MEMORY.md and HEARTBEAT.md in openclaw are managed by the agent. */
function esDelAgente(harness: string, nombre: string): boolean {
  return harness === "openclaw" && esFicheroDelAgente(nombre);
}

function esFicheroCanonico(harness: string, nombre: string): boolean {
  return nombre === (harness === "claude" ? "CLAUDE.md" : "AGENTS.md");
}

/** Validates per-file and accumulated caps in the unit the harness table DECLARES. */
function comprobarTopes(
  ficheros: readonly FicheroGenerado[],
  presupuesto: PresupuestoDeContexto | undefined,
): void {
  if (presupuesto === undefined) return;
  const { porFichero, total: topeTotal, unit } = presupuesto;
  if (porFichero === undefined && topeTotal === undefined) return;
  const fuente = presupuesto.fuente ?? "default";
  let total = 0;
  for (const fichero of ficheros) {
    // Agent-managed files, and files the seeding will not write, do not count.
    if (fichero.politica === "solo-si-falta" || !fichero.escribir) continue;
    const medido = medirEnUnidad(fichero.texto, unit);
    if (porFichero !== undefined && medido > porFichero) {
      throw new ErrorDeTopeDelArnes(fichero.nombre, medido, porFichero, unit, fuente);
    }
    total += medido;
  }
  if (topeTotal !== undefined && total > topeTotal) {
    throw new ErrorDeTopeDelArnes("total", total, topeTotal, unit, fuente);
  }
}
