import {
  measureStrictestUnits, seccion, vinetas, type AgentProfile, type ContextoDeAlias,
} from "./agent-profile.js";
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
  const after = position + length === text.length || text[position + length] === "\n";
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

export function validaTopologiaDeBloquesGestionados(text: string): void {
  if (text.includes("\r")) {
    throw new Error("native profile projection does not accept CR or CRLF line endings");
  }
  const fixed = strictBlock(text, MARCA_INICIO, MARCA_FIN, "fixed-context");
  const profile = strictBlock(text, MARCA_PERFIL_INICIO, MARCA_PERFIL_FIN, "profile");
  if (fixed !== undefined && profile !== undefined
    && fixed.start < profile.end && profile.start < fixed.end) {
    throw new Error("native profile file has overlapping managed blocks");
  }
}

function revisionLine(text: string): RevisionLine | undefined {
  validaTopologiaDeBloquesGestionados(text);
  const position = text.indexOf(PREFIJO_REVISION_PERFIL);
  if (position === -1) return undefined;
  if (text.indexOf(PREFIJO_REVISION_PERFIL, position + PREFIJO_REVISION_PERFIL.length) !== -1) {
    throw new Error("native profile file has repeated revision markers");
  }
  const start = text.lastIndexOf("\n", position - 1) + 1;
  const newline = text.indexOf("\n", position);
  const end = newline === -1 ? text.length : newline;
  const line = text.slice(start, end);
  const exact = new RegExp(
    `^${PREFIJO_REVISION_PERFIL} v${VERSION_REVISION_PERFIL} revision=([1-9][0-9]*) -->$`,
    "u",
  ).exec(line);
  if (start !== position || exact === null) {
    throw new Error("native profile file has a malformed revision marker");
  }
  const after = newline === -1 ? end : end + 1;
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

/**
 * Generador de ficheros de arnés a partir de un perfil y hechos del alias.
 * Distribuye las secciones del perfil en los ficheros correspondientes según el arnés
 * (`claude`, `codex`, `openclaw`).
 *
 * `MEMORY.md` y `HEARTBEAT.md` en `openclaw` son gestionados por el agente y no se sobrescriben si existen.
 */

/** Topes de tamaño por fichero y total para openclaw, medidos en unidades UTF-16. */
export const TOPES_OPENCLAW = { porFichero: 60_000, total: 150_000 } as const;

/** Los siete ficheros de openclaw, en el orden en que se emiten. */
export const FICHEROS_OPENCLAW = [
  "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "HEARTBEAT.md", "AGENTS.md", "TOOLS.md",
] as const;

/** Error lanzado cuando un fichero generado o el total excede el tope configurado para el arnés. */
export class ErrorDeTopeDelArnes extends Error {
  constructor(
    readonly fichero: string,
    readonly medido: number,
    readonly tope: number,
  ) {
    super(
      fichero === "total"
        ? `los ficheros del arnés suman ${medido} unidades y el tope total es ${tope}`
        : `${fichero} mide ${medido} unidades y el tope por fichero es ${tope}`,
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
    // Solo reglas autoradas y estables.
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
    // Solo herramientas declaradas.
    if (perfil.tools.length === 0) return "";
    return seccion("Herramientas", vinetas(perfil.tools)) ?? "";
  }
  // MEMORY.md y HEARTBEAT.md no reciben contenido generado; son gestionados por el agente.
  return "";
}

/** Bloque único de Claude/Codex con el contenido autorado. */
function bloqueUnico(perfil: AgentProfile): string {
  const rol = unir([
    perfil.role_summary ?? undefined,
    perfil.responsibilities.length > 0
      ? `Responsabilidades:\n${vinetas(perfil.responsibilities)}`
      : undefined,
    perfil.restrictions.length > 0
      ? `Restricciones:\n${vinetas(perfil.restrictions)}`
      : undefined,
  ]);
  return unir([
    seccion("Identidad y propósito", perfil.purpose ?? undefined),
    seccion("Rol, responsabilidades y restricciones", rol),
    seccion("Tu humano y cómo tratarlo", perfil.human_brief ?? undefined),
    seccion("Herramientas", perfil.tools.length > 0 ? vinetas(perfil.tools) : undefined),
    seccion(
      "Instrucciones fijas de funcionamiento",
      perfil.operating_rules.length > 0 ? vinetas(perfil.operating_rules) : undefined,
    ),
  ]);
}

function unir(partes: readonly (string | undefined)[]): string {
  return partes.filter((parte): parte is string => parte !== undefined && parte.trim().length > 0)
    .join("\n\n");
}

/**
 * Ficheros asignados al arnés con los bloques fusionados sobre el contenido existente.
 * Lanza ErrorDeTopeDelArnes si el tamaño supera el límite configurado.
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

    // MEMORY y HEARTBEAT: gestionados por el agente. Si existen no se modifican.
    if (esDelAgente(harness, nombre)) {
      generados.push({
        nombre, politica: "solo-si-falta",
        texto: previo ?? "",
        escribir: previo === undefined,
      });
      continue;
    }
    // El fichero único de claude/codex consolida el perfil completo.
    const cuerpo = harness === "openclaw"
      ? bloqueDeFichero(nombre, contexto.perfil)
      : bloqueUnico(contexto.perfil);
    const canonico = esFicheroCanonico(harness, nombre);
    const bloque = cuerpo.trim().length === 0
      ? canonico && revisionNativa !== undefined ? renglonDeDueno(contexto.perfil) : ""
      : `${renglonDeDueno(contexto.perfil)}\n${cuerpo}`;

    // Si el bloque está vacío y existía un bloque previo, se retira el bloque conservando el resto del archivo.
    const anterior = previo === undefined ? undefined : bloqueDePerfil(previo);

    // Guarda de pertenencia: solo se modifica o retira si el bloque pertenece al mismo alias.
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

  comprobarTopes(harness, generados);
  return generados;
}

function assertNoReservedMarkersInProfile(text: string, name: string): void {
  const block = bloqueDePerfil(text);
  if (block === undefined) return;
  if (block.includes("<!-- CAUCE:")) {
    throw new Error(`${name} has a reserved Cauce marker inside the authored profile block`);
  }
}

/** Comentario HTML con el identificador del alias dueño del bloque. */
function renglonDeDueno(perfil: AgentProfile): string {
  return `<!-- alias: ${perfil.tenant_id}/${perfil.alias} -->`;
}

/** El alias que declara un bloque, o `undefined` si no lo declara. */
function duenoDelBloque(bloque: string): string | undefined {
  return /^\s*<!--\s*alias:\s*([^\s>]+)\s*-->/.exec(bloque)?.[1];
}

/** Comprueba si el bloque existente pertenece al mismo alias y tenant. */
function esDelMismoAlias(anterior: string, perfil: AgentProfile): boolean {
  const suyo = duenoDelBloque(anterior);
  return suyo !== undefined && suyo === `${perfil.tenant_id}/${perfil.alias}`;
}

/** MEMORY.md y HEARTBEAT.md de openclaw son gestionados por el agente. */
function esDelAgente(harness: string, nombre: string): boolean {
  return harness === "openclaw" && (nombre === "MEMORY.md" || nombre === "HEARTBEAT.md");
}

function esFicheroCanonico(harness: string, nombre: string): boolean {
  return nombre === (harness === "claude" ? "CLAUDE.md" : "AGENTS.md");
}

/** Valida los topes de tamaño por fichero y acumulado en openclaw. */
function comprobarTopes(harness: string, ficheros: readonly FicheroGenerado[]): void {
  if (harness !== "openclaw") return;
  let total = 0;
  for (const fichero of ficheros) {
    // Los ficheros del agente (solo-si-falta) no computan para los topes gestionados.
    if (fichero.politica === "solo-si-falta") continue;
    // Ficheros que la siembra no va a escribir no computan para topes gestionados.
    if (!fichero.escribir) continue;
    const medido = measureStrictestUnits(fichero.texto);
    if (medido > TOPES_OPENCLAW.porFichero) {
      throw new ErrorDeTopeDelArnes(fichero.nombre, medido, TOPES_OPENCLAW.porFichero);
    }
    total += medido;
  }
  if (total > TOPES_OPENCLAW.total) {
    throw new ErrorDeTopeDelArnes("total", total, TOPES_OPENCLAW.total);
  }
}
