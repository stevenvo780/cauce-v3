import type { RoleBriefHistory, RoleBriefHistoryEntry } from '../../api/types';
import { contarRoleBrief } from './role-brief';

/**
 * LAS REGLAS DEL DIARIO DEL ROL DECLARADO, fuera del componente.
 *
 * Viven acá por lo mismo que `role-brief.ts` y `directiva.ts`: exportar funciones desde un fichero
 * de componentes rompe el fast refresh de Vite y el lint de esta consola corre con
 * `--max-warnings 0`. Y porque «qué cambió en esta entrada» y «en qué orden van» son decisiones
 * que tienen que poder probarse sin montar un cajón.
 *
 * El diario lo escribe un trigger de la proyección legacy. Conserva los cambios históricos,
 * incluidos los `UPDATE` crudos previos al perfil canónico. No sustituye el audit del perfil ni
 * autoriza una escritura directa: una restauración sólo prepara un borrador de `role_summary`.
 */

export const AVISO_DE_PROFUNDIDAD =
  'El diario arranca el 23 de agosto de 2026, que es cuando se instaló el disparador que lo '
  + 'escribe. Lo anterior a esa fecha NO está registrado en ningún sitio: que aparezcan pocos '
  + 'cambios no significa que este rol se haya tocado poco.';

/**
 * De más nuevo a más viejo, y sin fiarse del orden en que llegó.
 *
 * Ordenar acá —y no confiar en el `ORDER BY` del servidor— tiene un motivo medido: en este mismo
 * repositorio había una consulta que ordenaba por `id` cuando `id` es TEXTO, y eso pone la
 * revisión 9 por encima de la 10. El `id` de este diario llega como cadena ('1'), así que el
 * riesgo es exactamente el mismo. Se ordena por `changed_at`, que es lo que el operador cree que
 * está viendo, y el `id` sólo desempata —comparado como NÚMERO cuando los dos lo son—.
 *
 * Las entradas sin fecha se van al final en vez de descartarse: una entrada sin `changed_at` es
 * un dato raro del servidor, no una razón para ocultarle al operador que ese cambio existió.
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

/** `'10'` va por encima de `'9'`: el `id` viaja como cadena y compararlo como texto los invierte. */
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
  /** El detalle que se puede afirmar mirando SÓLO esta entrada. */
  detalle: string;
  /** Diferencia de longitud en puntos de código. `undefined` cuando no aplica. */
  delta?: number;
  /** Si esta entrada dejó al alias sin rol declarado. Es el cambio que más caro sale. */
  dejaSinRol: boolean;
}

/**
 * Qué pasó en una entrada, dicho en castellano y sin adornar.
 *
 * Las cuatro clases salen de cruzar `previous_brief` y `new_brief`, y `null` NO es lo mismo que
 * cadena vacía en ninguna de las dos: el store convierte '' en NULL antes de guardar porque el
 * CHECK de la base exige longitud >= 1, así que `null` significa «este alias no tenía rol», que es
 * un estado real del sistema y no un hueco del dato.
 *
 * `sin-texto` existe porque el disparador se dispara con CUALQUIER `UPDATE` de la fila, incluido
 * uno que sólo movió la plantilla. Decir «se reescribió el rol» ahí sería inventar un cambio que
 * no ocurrió, y es justo el tipo de afirmación que hace que nadie se fíe del registro.
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
 * Cómo cambió el vínculo con una plantilla de rol, si es que cambió.
 *
 * Importa porque editar el texto a mano DESVINCULA la plantilla: un disparador pone
 * `role_template_slug` a NULL. O sea que alguien que tocó una letra del texto puede haber roto,
 * sin enterarse, la relación «este alias lleva el rol de orquestador». Si no se dice acá, no se
 * dice en ningún sitio.
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
 * Quién hizo el cambio. Las filas antiguas suelen traer ambas columnas en NULL; las escrituras
 * gobernadas más nuevas sí pueden declarar actor. Nunca se rellena con el operador que mira.
 */
export function actorDeEntrada(entrada: RoleBriefHistoryEntry): string | undefined {
  const tenant = entrada.actor_tenant?.trim();
  const alias = entrada.actor_alias?.trim();
  if (alias && tenant) return `${tenant}/${alias}`;
  return alias ?? tenant ?? undefined;
}

/**
 * Qué se copia al borrador canónico al recuperar una entrada: el texto ANTERIOR al cambio.
 *
 * `clase: 'borra'` significa que ese valor era NULL. La UI lo rotula como vaciado de
 * `role_summary`; no afirma que borre el perfil completo ni escribe hasta que el operador guarda.
 */
export type Restauracion =
  | { clase: 'texto'; texto: string }
  | { clase: 'borra' };

export function restauracionDe(entrada: RoleBriefHistoryEntry): Restauracion {
  const antes = entrada.previous_brief ?? null;
  return antes === null ? { clase: 'borra' } : { clase: 'texto', texto: antes };
}

/**
 * Las entradas listas para pintar, o el motivo por el que no hay ninguna.
 *
 * Distingue TRES desenlaces que se parecen y no lo son, que es el defecto que esta consola paga
 * más caro: «no se pudo mirar» (el gateway no publica el diario), «se miró y no cambió nunca»
 * (`entries: []`, medido) y «hay cambios». Los dos primeros se pintaban igual —una lista vacía— y
 * eso convierte un fallo de lectura en la afirmación tranquilizadora de que no pasó nada.
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
