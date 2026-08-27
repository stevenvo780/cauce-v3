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
  return [...text.trim()].length;
}

export type RoleBriefTono = 'ok' | 'cerca' | 'pasado';

export function tonoRoleBrief(largo: number): RoleBriefTono {
  if (largo > ROLE_BRIEF_MAX) return 'pasado';
  return largo > ROLE_BRIEF_MAX - ROLE_BRIEF_CERCA ? 'cerca' : 'ok';
}

/**
 * GUARDA TEMPORAL — zeus 2026-08-22, y tiene fecha de retiro.
 *
 * El arreglo que unifica el tope en PUNTOS DE CÓDIGO toca `packages/protocol` y
 * `packages/adapter-sdk`, o sea el RUNTIME: el esquema que rechaza el sobre vive dentro de cada
 * contenedor de alias, no en el gateway. Ese rollout no salió todavía. Los adaptadores que HOY
 * corren en producción siguen midiendo `self_role` con `z.string().max(1200)`, que cuenta
 * unidades UTF-16.
 *
 * Y esta pantalla es justamente lo que vuelve ALCANZABLE ese agujero: hasta hoy nadie podía
 * escribir un brief sin pasar por psql. Un rol de 1200 puntos de código con emojis mide 1300 en
 * UTF-16: el store lo acepta, la base lo acepta, la pantalla diría «guardado»… y el alias deja de
 * consumir entregas, sin un solo error a la vista.
 *
 * Así que mientras el runtime desplegado mida en UTF-16, la consola obedece al MÁS ESTRICTO de los
 * dos. No es una restricción de producto: es no publicar un botón que puede dejar mudo a un agente.
 *
 * PARA RETIRARLA: cuando los 15 contenedores de alias corran un adapter-sdk con
 * `ROLE_BRIEF_MAX_CODE_POINTS`, se borra esta función y su uso en RoleBriefTab.tsx. Comprobalo por
 * efecto, no por el número de versión: guardá un brief de 1200 puntos con emoji y mirá que el alias
 * siga cerrando entregas.
 */
export function bloqueoPorRuntimeDesplegado(text: string): string | undefined {
  const recortado = text.trim();
  const utf16 = recortado.length;
  const puntos = [...recortado].length;
  if (utf16 <= ROLE_BRIEF_MAX || puntos > ROLE_BRIEF_MAX) return undefined;
  return (
    `Son ${puntos} caracteres, que la base acepta, pero ${utf16} unidades UTF-16 — y los ` +
    'adaptadores que corren hoy en producción todavía miden así. Guardarlo dejaría al alias ' +
    'SORDO sin dar ningún error. Quitá algún emoji o acortá el texto; la restricción se levanta ' +
    'cuando salga el runtime nuevo.'
  );
}
