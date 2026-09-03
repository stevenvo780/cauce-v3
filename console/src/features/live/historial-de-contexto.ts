import type { AgentPerfilCampos } from '../../api/types';
import {
  CAMPOS_DE_LISTA, CAMPOS_DE_TEXTO, ETIQUETAS,
  type CampoDelPerfil, type DocumentoRevision, type PerfilRevision, type TramoDeRevisiones,
} from './perfil';

/**
 * The rules of the context journal, outside the component so they are testable without a panel.
 * The journal is READ-ONLY: restoring loads the seven authored fields into the canonical draft,
 * and the only save from there is the profile PUT with its CAS, batch and hand-typed reason.
 */

export const PASO_DE_PAGINA = 20;

export const AVISO_DE_PROFUNDIDAD =
  'El diario empieza cuando se instaló la tabla que lo escribe. Lo anterior no está registrado '
  + 'en ningún sitio: que aparezcan pocas revisiones NO significa que este contexto se haya '
  + 'tocado poco.';

/** The document journal keeps a fingerprint and a size, never the text: say so, or the absence reads as a bug. */
export const SIN_CUERPO =
  'De cada escritura se guardan la huella y el tamaño, nunca el texto. Acá no se puede leer lo '
  + 'que decía el fichero, ni restaurarlo desde el diario.';

export const PALABRAS_DE_OPERACION: Readonly<Record<PerfilRevision['operation'], string>> = {
  insert: 'Alta del perfil',
  update: 'Cambio del perfil',
  delete: 'Borrado del perfil',
};

/** Reuses the classes the journal styles already carry, so a deletion still paints as a deletion. */
export const CLASES_DE_OPERACION: Readonly<Record<PerfilRevision['operation'], string>> = {
  insert: 'alta',
  update: 'reescritura',
  delete: 'borrado',
};

export interface ActorDeRevision {
  readonly actor_tenant: string | null;
  readonly actor_alias: string | null;
}

/**
 * Who made the change. Both columns arrive NULL for anything the gateway did not attribute, and
 * that is shown as «no consta quién»: it is never filled with the operator who is watching.
 */
export function actorDeRevision(entrada: ActorDeRevision): string | undefined {
  const tenant = entrada.actor_tenant?.trim() ?? '';
  const alias = entrada.actor_alias?.trim() ?? '';
  if (tenant.length > 0 && alias.length > 0) return `${tenant}/${alias}`;
  if (alias.length > 0) return alias;
  return tenant.length > 0 ? tenant : undefined;
}

/** The whole snapshot: a restore replays the seven fields or it is not a restore. */
export function camposDeRevision(revision: PerfilRevision): AgentPerfilCampos {
  return {
    purpose: revision.purpose ?? '',
    role_summary: revision.role_summary ?? '',
    human_brief: revision.human_brief ?? '',
    responsibilities: [...revision.responsibilities],
    restrictions: [...revision.restrictions],
    tools: [...revision.tools],
    operating_rules: [...revision.operating_rules],
  };
}

/** Lists diff per entry and free texts per line, which is the unit a person reads. */
export function lineasDelCampo(revision: PerfilRevision, campo: CampoDelPerfil): string[] {
  if (campo === 'responsibilities' || campo === 'restrictions'
    || campo === 'tools' || campo === 'operating_rules') {
    return [...revision[campo]];
  }
  const texto = revision[campo];
  return texto === null || texto.length === 0 ? [] : texto.split('\n');
}

export type ClaseDeLinea = 'igual' | 'quitada' | 'agregada';

export interface LineaDeDiff {
  readonly clase: ClaseDeLinea;
  readonly texto: string;
}

/** Above this the table costs more than the answer is worth and the diff degrades, saying so. */
const TOPE_DE_TABLA = 40_000;

export function diffDeLineas(
  antes: readonly string[], despues: readonly string[],
): LineaDeDiff[] {
  if (antes.length * despues.length > TOPE_DE_TABLA) {
    return [
      ...antes.map((texto): LineaDeDiff => ({ clase: 'quitada', texto })),
      ...despues.map((texto): LineaDeDiff => ({ clase: 'agregada', texto })),
    ];
  }
  const filas = antes.length;
  const columnas = despues.length;
  const comunes: number[][] = Array.from(
    { length: filas + 1 }, () => new Array<number>(columnas + 1).fill(0),
  );
  for (let i = filas - 1; i >= 0; i -= 1) {
    for (let j = columnas - 1; j >= 0; j -= 1) {
      comunes[i][j] = antes[i] === despues[j]
        ? comunes[i + 1][j + 1] + 1
        : Math.max(comunes[i + 1][j], comunes[i][j + 1]);
    }
  }
  const salida: LineaDeDiff[] = [];
  let i = 0;
  let j = 0;
  while (i < filas && j < columnas) {
    if (antes[i] === despues[j]) {
      salida.push({ clase: 'igual', texto: antes[i] });
      i += 1;
      j += 1;
    } else if (comunes[i + 1][j] >= comunes[i][j + 1]) {
      salida.push({ clase: 'quitada', texto: antes[i] });
      i += 1;
    } else {
      salida.push({ clase: 'agregada', texto: despues[j] });
      j += 1;
    }
  }
  for (; i < filas; i += 1) salida.push({ clase: 'quitada', texto: antes[i] });
  for (; j < columnas; j += 1) salida.push({ clase: 'agregada', texto: despues[j] });
  return salida;
}

export interface CampoComparado {
  readonly campo: CampoDelPerfil;
  readonly titulo: string;
  readonly cambio: boolean;
  readonly lineas: readonly LineaDeDiff[];
}

/** The seven fields, always in the same order, so an unchanged one is an absence you can see. */
export function compararRevisiones(
  anterior: PerfilRevision, posterior: PerfilRevision,
): CampoComparado[] {
  const campos: readonly CampoDelPerfil[] = [...CAMPOS_DE_TEXTO, ...CAMPOS_DE_LISTA];
  return campos.map((campo) => {
    const lineas = diffDeLineas(
      lineasDelCampo(anterior, campo), lineasDelCampo(posterior, campo),
    );
    return {
      campo,
      titulo: ETIQUETAS[campo].titulo,
      cambio: lineas.some((linea) => linea.clase !== 'igual'),
      lineas,
    };
  });
}

export function camposCambiados(comparacion: readonly CampoComparado[]): CampoComparado[] {
  return comparacion.filter((campo) => campo.cambio);
}

export interface CambioDeDocumento {
  readonly huella: 'igual' | 'distinta' | 'sin-dato';
  readonly bytes: number;
  readonly movido: boolean;
}

export function compararDocumentos(
  anterior: DocumentoRevision, posterior: DocumentoRevision,
): CambioDeDocumento {
  const sinDato = anterior.sha256 === null || posterior.sha256 === null;
  return {
    huella: sinDato ? 'sin-dato' : anterior.sha256 === posterior.sha256 ? 'igual' : 'distinta',
    bytes: posterior.bytes - anterior.bytes,
    movido: anterior.path !== posterior.path,
  };
}

/** Enough to tell two writes apart on screen without pretending the whole hash fits in a row. */
export function huellaCorta(sha: string | null): string {
  return sha === null ? 'sin huella' : sha.slice(0, 12);
}

export const fechaDePerfil = (revision: PerfilRevision): string => revision.changed_at;
export const fechaDeDocumento = (revision: DocumentoRevision): string => revision.written_at;

interface ConId {
  readonly id: string;
}

/**
 * Newest first, and without trusting the order they arrived in: the `id` travels as a string, so
 * comparing it as text puts revision 9 above revision 10. Sorting is by date —which is what the
 * operator thinks they are reading— and the id only breaks ties, as a NUMBER when both are.
 */
export function ordenadas<T extends ConId>(
  entradas: readonly T[], fechaDe: (entrada: T) => string,
): T[] {
  return [...entradas].sort((a, b) => {
    const fechaA = Date.parse(fechaDe(a));
    const fechaB = Date.parse(fechaDe(b));
    const validaA = Number.isFinite(fechaA);
    const validaB = Number.isFinite(fechaB);
    if (validaA && validaB && fechaA !== fechaB) return fechaB - fechaA;
    if (validaA !== validaB) return validaA ? -1 : 1;
    const numA = Number(a.id);
    const numB = Number(b.id);
    if (Number.isFinite(numA) && Number.isFinite(numB) && numA !== numB) return numB - numA;
    return b.id.localeCompare(a.id);
  });
}

/**
 * Pages joined by id. Whatever comes back last wins for a repeated id, because the server is the
 * one telling the truth about that row; and a wider re-read of the same page is idempotent.
 */
export function fusionar<T extends ConId>(
  previas: readonly T[], nuevas: readonly T[], fechaDe: (entrada: T) => string,
): T[] {
  const porId = new Map<string, T>();
  for (const entrada of previas) porId.set(entrada.id, entrada);
  for (const entrada of nuevas) porId.set(entrada.id, entrada);
  return ordenadas([...porId.values()], fechaDe);
}

/** A cursor the console did not invent: it is only used if the page really carries one. */
export function cursorSiguiente(pagina: unknown): string | undefined {
  if (pagina === null || typeof pagina !== 'object' || Array.isArray(pagina)) return undefined;
  const bruto = (pagina as Record<string, unknown>).next_cursor;
  if (typeof bruto !== 'string' || bruto.trim().length === 0) return undefined;
  return bruto;
}

function tamano(pedido: TramoDeRevisiones): number {
  return pedido.limit ?? PASO_DE_PAGINA;
}

/**
 * The widest window the route accepts (`MAX_PAGE` in `agent-context-history.routes.ts`): above it
 * the answer is a 400 by contract, not «one more try».
 */
export const TOPE_DE_PAGINA = 200;

/**
 * What the reader can still do after this page. `ventana-agotada` means older entries may exist
 * and this gateway published no cursor to reach them: saying «fin» there would be a lie.
 */
export type PasoDelDiario = 'mas' | 'ventana-agotada' | 'fin';

export function pasoDelDiario(
  pagina: { readonly entries: readonly unknown[] }, pedido: TramoDeRevisiones,
): PasoDelDiario {
  if (cursorSiguiente(pagina) !== undefined) return 'mas';
  // The server drove this stretch by cursor and handed no other one: it is saying it ended, and a
  // full page does not override that. Re-reading from the head would only re-fetch what is shown.
  if (pedido.cursor !== undefined) return 'fin';
  if (pagina.entries.length < tamano(pedido)) return 'fin';
  return tamano(pedido) >= TOPE_DE_PAGINA ? 'ventana-agotada' : 'mas';
}

/** With a cursor it asks for the next stretch; without one, for a wider window of the same one. */
export function siguientePedido(
  pedido: TramoDeRevisiones, pagina: unknown,
): TramoDeRevisiones {
  const cursor = cursorSiguiente(pagina);
  if (cursor !== undefined) return { limit: tamano(pedido), cursor };
  return { limit: Math.min(tamano(pedido) + PASO_DE_PAGINA, TOPE_DE_PAGINA) };
}

export function clavePedido(pedido: TramoDeRevisiones): string {
  return `${String(tamano(pedido))}-${pedido.cursor ?? ''}`;
}
