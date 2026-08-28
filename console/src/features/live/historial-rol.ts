import type { RoleBriefHistory, RoleBriefHistoryEntry } from '../../api/types';
import { contarRoleBrief } from './role-brief';

/**
 * THE RULES OF THE DECLARED-ROLE LOG, outside the component.
 *
 * They live here for the same reason `role-brief.ts` and `directiva.ts` do: exporting functions from a component file
 * breaks Vite's fast refresh and this console's lint runs with `--max-warnings 0`. And because "what changed in this
 * entry" and "in what order they go" are decisions that must be testable without mounting a panel.
 *
 * The log is written by a trigger of the legacy projection. It keeps historical changes, including raw `UPDATE`s
 * predating the canonical profile. It does not replace the profile audit nor does it authorize a direct write: a
 * restore only prepares a `role_summary` draft.
 */

export const AVISO_DE_PROFUNDIDAD =
  'El diario arranca el 23 de agosto de 2026, que es cuando se instaló el disparador que lo '
  + 'escribe. Lo anterior a esa fecha NO está registrado en ningún sitio: que aparezcan pocos '
  + 'cambios no significa que este rol se haya tocado poco.';

/**
 * From newest to oldest, and without trusting the order they arrived in.
 *
 * Sorting here —and not trusting the server's `ORDER BY`— has a measured reason: in this very repository there was a
 * query that sorted by `id` when `id` is TEXT, and that places revision 9 above revision 10. The `id` of this log
 * arrives as a string ('1'), so the risk is exactly the same. We sort by `changed_at`, which is what the operator
 * thinks they see, and `id` is only the tiebreaker —compared as a NUMBER when both of them are—.
 *
 * Entries without a date go to the end instead of being discarded: an entry without `changed_at` is odd server data,
 * not a reason to hide from the operator that this change existed.
 */
export function entradasMasNuevasPrimero(entradas: RoleBriefHistoryEntry[]): RoleBriefHistoryEntry[] {
  return [...entradas].sort((a, b) => {
    const fechaA = Date.parse(a.changed_at ?? '');
    const fechaB = Date.parse(b.changed_at ?? '');
    const validaA = Number.isFinite(fechaA);
    const validaB = Number.isFinite(fechaB);
    if (validaA && validaB && fechaA !== fechaB) return fechaB - fechaA;
    if (validaA !== validaB) return validaA ? -1 : 1;
    return comparaIds(a.id, b.id);
  });
}

/** `'10'` goes above `'9'`: `id` travels as a string and comparing them as text inverts them. */
function comparaIds(a: string | null | undefined, b: string | null | undefined): number {
  const numA = Number(a);
  const numB = Number(b);
  if (Number.isFinite(numA) && Number.isFinite(numB) && numA !== numB) return numB - numA;
  return (b ?? '').localeCompare(a ?? '');
}

export type ClaseDeCambio = 'alta' | 'reescritura' | 'borrado' | 'sin-texto';

export interface CambioResumido {
  clase: ClaseDeCambio;
  titulo: string;
  /** The detail that can be asserted by looking at THIS entry alone. */
  detalle: string;
  /** Length difference in code points. `undefined` when it does not apply. */
  delta?: number;
  /** If this entry left the alias without a declared role. This is the most costly change. */
  dejaSinRol: boolean;
}

/**
 * What happened in an entry, told plainly.
 *
 * The four classes come from crossing `previous_brief` and `new_brief`, and `null` is NOT the same as the empty string
 * in either of them: the store converts '' to NULL before storing because the database CHECK requires length >= 1, so
 * `null` means "this alias had no role", which is a real state of the system and not a hole in the data.
 *
 * `sin-texto` exists because the trigger fires on ANY `UPDATE` of the row, including one that only moved the
 * template. Saying "the role was rewritten" there would be inventing a change that did not happen, and that is exactly
 * the kind of statement that makes nobody trust the log.
 */
export function resumirCambio(entrada: RoleBriefHistoryEntry): CambioResumido {
  const antes = entrada.previous_brief ?? null;
  const despues = entrada.new_brief ?? null;

  if (antes === null && despues !== null) {
    return {
      clase: 'alta',
      titulo: 'Se le puso rol por primera vez',
      detalle: `Antes no tenía rol declarado; quedó con ${String(contarRoleBrief(despues))} caracteres.`,
      dejaSinRol: false,
    };
  }

  if (antes !== null && despues === null) {
    return {
      clase: 'borrado',
      titulo: 'Se le quitó el rol',
      detalle: `Tenía ${String(contarRoleBrief(antes))} caracteres y la proyección quedó sin rol declarado.`,
      dejaSinRol: true,
    };
  }

  if (antes === despues) {
    return {
      clase: 'sin-texto',
      titulo: 'Se guardó sin tocar el texto',
      detalle: 'El rol quedó igual. Cambió alguna otra cosa de la fila —la plantilla, por ejemplo—: '
        + 'el disparador anota cualquier cambio, no sólo los del texto.',
      dejaSinRol: false,
    };
  }

  const largoAntes = contarRoleBrief(antes ?? '');
  const largoDespues = contarRoleBrief(despues ?? '');
  const delta = largoDespues - largoAntes;
  return {
    clase: 'reescritura',
    titulo: 'Se reescribió el rol',
    detalle: `Pasó de ${String(largoAntes)} a ${String(largoDespues)} caracteres.`,
    delta,
    dejaSinRol: false,
  };
}

/**
 * How the link to a role template changed, if it did.
 *
 * It matters because editing the text by hand UNLINKS the template: a trigger sets `role_template_slug` to NULL. So
 * someone who touched a single letter of the text may have broken —unknowingly— the relationship "this alias wears
 * the orchestrator role". If it is not said here, it is not said anywhere.
 */
export function cambioDePlantilla(entrada: RoleBriefHistoryEntry): string | undefined {
  const antes = entrada.previous_template_slug ?? null;
  const despues = entrada.new_template_slug ?? null;
  if (antes === despues) return undefined;
  if (antes !== null && despues === null) {
    return `Quedó desvinculado de la plantilla «${antes}»: editar el texto a mano rompe el vínculo.`;
  }
  if (antes === null && despues !== null) return `Pasó a llevar la plantilla «${despues}».`;
  if (antes !== null && despues !== null) return `Cambió de la plantilla «${antes}» a «${despues}».`;
  return undefined;
}

/**
 * Who made the change. Old rows usually have both columns as NULL; the newer governed
 * writes can declare the actor. It is never filled with the operator who is watching.
 */
export function actorDeEntrada(entrada: RoleBriefHistoryEntry): string | undefined {
  const tenant = entrada.actor_tenant?.trim();
  const alias = entrada.actor_alias?.trim();
  if (alias && tenant) return `${tenant}/${alias}`;
  return alias ?? tenant ?? undefined;
}

/**
 * What is copied to the canonical draft when restoring an entry: the text BEFORE the change.
 *
 * `clase: 'borra'` means that value was NULL. The UI labels it as emptying `role_summary`; it does not claim to delete
 * the full profile nor does it write anything until the operator saves.
 */
export type Restauracion =
  | { clase: 'texto'; texto: string }
  | { clase: 'borra' };

export function restauracionDe(entrada: RoleBriefHistoryEntry): Restauracion {
  const antes = entrada.previous_brief ?? null;
  return antes === null ? { clase: 'borra' } : { clase: 'texto', texto: antes };
}

/**
 * The entries ready to render, or the reason there are none.
 *
 * It distinguishes THREE outcomes that look alike and are not, which is the bug this console pays most dearly for:
 * "could not look" (the gateway does not publish the log), "looked and never changed" (`entries: []`, measured), and
 * "there are changes". The first two rendered the same —an empty list— and that turns a read failure into the
 * reassuring claim that nothing happened.
 */
export type EstadoDelDiario =
  | { clase: 'no-publicado'; motivo: string }
  | { clase: 'vacio' }
  | { clase: 'entradas'; entradas: RoleBriefHistoryEntry[] };

export function estadoDelDiario(historial: RoleBriefHistory | undefined): EstadoDelDiario {
  if (!historial?.publicado) {
    return {
      clase: 'no-publicado',
      motivo: historial?.motivo ?? 'el servidor no dio un motivo.',
    };
  }
  const entradas = historial.entries ?? [];
  if (entradas.length === 0) return { clase: 'vacio' };
  return { clase: 'entradas', entradas: entradasMasNuevasPrimero(entradas) };
}
