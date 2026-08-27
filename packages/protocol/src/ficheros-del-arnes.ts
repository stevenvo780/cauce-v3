import {
  measureStrictestUnits, seccion, vinetas, type AgentProfile, type ContextoDeAlias,
} from "./agent-profile.js";
import { bloqueDePerfil, conBloqueDePerfil, sinBloqueDePerfil } from "./marcas-de-bloque.js";

/**
 * Generador de ficheros de arnés a partir de un perfil y hechos del alias.
 * Distribuye las secciones del perfil en los ficheros correspondientes según el arnés
 * (`claude`, `codex`, `openclaw`).
 *
 * `MEMORY.md` y `HEARTBEAT.md` en `openclaw` son gestionados por el agente y no se sobrescriben si existen.
 */

// ── Los topes que declara openclaw ───────────────────────────────────────────────────────────

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

// ── La forma de lo que se genera ─────────────────────────────────────────────────────────────

/** Cómo se trata un fichero que ya está en el disco del contenedor. */
export type PoliticaDeFichero =
  /** Se fusiona nuestro bloque conservando byte a byte todo lo de fuera. */
  | "bloque-gestionado"
  /** Es del agente: si existe no se toca; si falta se crea vacío. */
  | "solo-si-falta";

export interface FicheroGenerado {
  readonly nombre: string;
  readonly politica: PoliticaDeFichero;
  /** El contenido COMPLETO que tiene que quedar en el disco. */
  readonly texto: string;
  /** `false` cuando lo que hay en el disco ya es esto: no hay nada que escribir. */
  readonly escribir: boolean;
}

/** Los nombres que le tocan a un arnés, sin generar nada. Un arnés desconocido no recibe ninguno. */
export function nombresDelArnes(harness: string): readonly string[] {
  if (harness === "claude") return ["CLAUDE.md"];
  if (harness === "codex") return ["AGENTS.md"];
  if (harness === "openclaw") return [...FICHEROS_OPENCLAW];
  return [];
}

// ── Reparto de secciones por fichero ────────────────────────────────────────

/**
 * Distribuye las secciones autoradas del perfil en los ficheros soportados por openclaw.
 * Los hechos dinámicos no se persisten en ficheros estáticos.
 */
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
): readonly FicheroGenerado[] {
  const nombres = nombresDelArnes(harness);
  const generados: FicheroGenerado[] = [];

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
    const bloque = cuerpo.trim().length === 0 ? "" : `${renglonDeDueno(contexto.perfil)}\n${cuerpo}`;

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

    const texto = conBloqueDePerfil(previo ?? "", bloque);
    generados.push({
      nombre, politica: "bloque-gestionado", texto, escribir: texto !== previo,
    });
  }

  comprobarTopes(harness, generados);
  return generados;
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

/** Valida los topes de tamaño por fichero y acumulado en openclaw. */
function comprobarTopes(harness: string, ficheros: readonly FicheroGenerado[]): void {
  if (harness !== "openclaw") return;
  let total = 0;
  for (const fichero of ficheros) {
    // Los ficheros del agente (solo-si-falta) no computan para los topes gestionados.
    if (fichero.politica === "solo-si-falta") continue;
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
