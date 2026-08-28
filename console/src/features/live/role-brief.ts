/**
 * Las reglas del tope del rol declarado (`agents.role_brief`), fuera del componente.
 *
 * Viven en su propio módulo por una razón mecánica y una de fondo. La mecánica: exportar
 * constantes y funciones desde un fichero de componentes rompe el fast refresh de Vite y
 * `npm run lint` corre con `--max-warnings 0`, así que el editor no compilaba en CI por dos
 * avisos de `react-refresh/only-export-components`. La de fondo: el tope no es cosa de la
 * pantalla —es el mismo número que el CHECK de la base y el esquema del protocolo— y tenerlo
 * aparte deja claro que la pantalla lo OBEDECE, no lo define.
 */

/**
 * El tope NO es cosmético: el CHECK de la migración 020 y `self_role` del protocolo coinciden en
 * 1200, y pasarse deja al alias SORDO —el sobre se rechaza contra el esquema y el agente deja de
 * recibir— sin que aparezca ningún error a la vista. Por eso el contador avisa ANTES del borde y
 * el botón se apaga: es el único aviso que va a existir.
 *
 * Es un ESPEJO a mano de `ROLE_BRIEF_MAX_CODE_POINTS` (packages/protocol/src/schemas.ts), que es
 * donde vive el número para las capas que sí pueden importarlo. La consola no depende de
 * `@cauce/protocol` —se compila sola, contra el gateway por HTTP— así que copiarlo es la única
 * opción; si aquel cambia, este cambia en el mismo lote. La unidad tiene que seguir siendo el
 * PUNTO DE CÓDIGO: ver `contarRoleBrief()` acá abajo.
 */
export const ROLE_BRIEF_MAX = 1200;

/** A cuántos caracteres del tope se empieza a avisar, antes de que sea tarde. */
export const ROLE_BRIEF_CERCA = 120;

/**
 * Cuenta lo MISMO que va a contar el servidor, y por eso recorta antes de medir.
 *
 * Dos decisiones, las dos copiadas de `normalizeRoleBrief` (packages/store/src/configuration.ts):
 *
 * 1. Se recorta primero (`trim()`), porque el store recorta y RECIÉN DESPUÉS mide. Contando el
 *    texto crudo, pegar un `.md` que termina en salto de línea bloqueaba acá un guardado que el
 *    servidor habría aceptado sin chistar —y la pantalla no explicaba por qué, porque el salto
 *    de línea no se ve—. Un contador que no mide lo que mide el que decide es un contador que
 *    miente.
 * 2. Se cuentan PUNTOS DE CÓDIGO, igual que `char_length` de Postgres. `String.length` cuenta
 *    unidades UTF-16, así que un brief con emojis se declararía pasado de largo cuando la base
 *    lo acepta —o al revés, según dónde cayera el corte—.
 */
export function contarRoleBrief(text: string): number {
  return Array.from(text.trim()).length;
}

export type RoleBriefTono = 'ok' | 'cerca' | 'pasado';

export function tonoRoleBrief(largo: number): RoleBriefTono {
  if (largo > ROLE_BRIEF_MAX) return 'pasado';
  return largo > ROLE_BRIEF_MAX - ROLE_BRIEF_CERCA ? 'cerca' : 'ok';
}

/**
 * Guarda de compatibilidad con runtime: los adaptadores en ejecución validan longitud
 * UTF-16 con `z.string().max(1200)`. Para evitar que un brief con emojis supere el límite UTF-16
 * al ser procesado por el adaptador, se valida contra el más estricto entre UTF-16 y puntos de código.
 */
export function bloqueoPorRuntimeDesplegado(text: string): string | undefined {
  const recortado = text.trim();
  const utf16 = recortado.length;
  const puntos = Array.from(recortado).length;
  if (utf16 <= ROLE_BRIEF_MAX || puntos > ROLE_BRIEF_MAX) return undefined;
  return (
    `Son ${String(puntos)} caracteres, que la base acepta, pero ${String(utf16)} unidades UTF-16 — y los ` +
    'adaptadores que corren hoy en producción todavía miden así. Guardarlo dejaría al alias ' +
    'SORDO sin dar ningún error. Quitá algún emoji o acortá el texto; la restricción se levanta ' +
    'cuando salga el runtime nuevo.'
  );
}
