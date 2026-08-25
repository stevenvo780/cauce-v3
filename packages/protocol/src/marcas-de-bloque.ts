/**
 * EL BLOQUE GESTIONADO: cómo Cauce escribe dentro de un fichero que no es suyo.
 *
 * ── Por qué vive acá y no en el adaptador ────────────────────────────────────────────────────
 *
 * Estas cuatro funciones nacieron en `@cauce/adapter-sdk/src/harnesses/contexto-fijo.ts`, que es
 * el sitio correcto para el SELLO —ése necesita `node:crypto` y necesita leer el disco del
 * contenedor—. La fusión de un bloque dentro de un texto no necesita ninguna de las dos cosas: es
 * manipulación de cadenas y nada más.
 *
 * Se mudan porque la consola tiene que enseñar EXACTAMENTE el fichero que va a quedar en el disco,
 * con lo humano intacto alrededor, y el gateway no puede importar `@cauce/adapter-sdk` —ese
 * paquete es el runtime del agente: arrastra el motor, el websocket, el lanzador de procesos y la
 * resolución de credenciales—. La alternativa era que el servidor tuviera su propia fusión, y dos
 * implementaciones de la misma fusión divergen a la primera corrección: el operador aprobaría una
 * vista previa y en el disco quedaría otra cosa, sin que nada diera error.
 *
 * ── La parte sutil, que ya costó una prueba descubrir ────────────────────────────────────────
 *
 * `parDeMarcas` busca la ÚLTIMA apertura que tenga cierre detrás, no la primera. Si una siembra se
 * cortó a medias queda una apertura huérfana, y leer desde la primera devuelve el texto roto MÁS
 * la apertura siguiente MÁS el bloque nuevo: un «bloque» que no es ninguno de los dos y cuyo
 * resumen no coincidiría nunca con nada. Con la última, el fichero a medio escribir queda como
 * texto inerte y el bloque vigente se lee limpio.
 *
 * Esa lógica está UNA sola vez a propósito. Dos copias son dos sitios donde volver a equivocarse,
 * y el segundo se arregla tarde y en silencio.
 */

/** La versión que llevan las marcas del contexto fijo. Subirla invalida los sellos de la flota. */
export const VERSION_CONTEXTO_FIJO = '1';

export const MARCA_INICIO =
  `<!-- CAUCE:CONTEXTO-FIJO v${VERSION_CONTEXTO_FIJO} — generado, no editar dentro de este bloque -->`;
export const MARCA_FIN = '<!-- CAUCE:FIN-CONTEXTO-FIJO -->';

/**
 * Las marcas del PERFIL, distintas de las del contexto fijo y en el mismo fichero.
 *
 * El fichero del arnés lleva DOS bloques y no uno: el contrato sellado (`MARCA_INICIO`) y el
 * perfil del alias (éstas). Están separados porque el sello resume el contrato —que incluye
 * `Tu rol:` con el `role_brief` de siempre, tope 1.200 puntos de código— y el perfil rico admite
 * 24.000. Meter el perfil dentro del bloque sellado haría que el sha del fichero no coincidiera
 * NUNCA con el que calcula el adaptador, y el recorte del sobre no se activaría jamás sin que
 * apareciera un solo error.
 */
export const VERSION_PERFIL = '1';
export const MARCA_PERFIL_INICIO =
  `<!-- CAUCE:PERFIL v${VERSION_PERFIL} — generado desde la configuración, no editar dentro de este bloque -->`;
export const MARCA_PERFIL_FIN = '<!-- CAUCE:FIN-PERFIL -->';

/**
 * El par de marcas que delimita el bloque VIGENTE, o `undefined` si no hay ninguno cerrado.
 *
 * Ver el encabezado del módulo: la ÚLTIMA apertura con cierre detrás, no la primera.
 */
function parDeMarcas(
  texto: string, marcaInicio: string, marcaFin: string
): { inicio: number; desde: number; fin: number } | undefined {
  let inicio = -1;
  for (
    let busca = texto.indexOf(marcaInicio);
    busca !== -1;
    busca = texto.indexOf(marcaInicio, busca + 1)
  ) {
    if (texto.indexOf(marcaFin, busca + marcaInicio.length) !== -1) inicio = busca;
  }
  if (inicio === -1) return undefined;
  const desde = inicio + marcaInicio.length;
  const fin = texto.indexOf(marcaFin, desde);
  if (fin === -1) return undefined;
  return { inicio, desde, fin };
}

/**
 * El contenido entre un par de marcas, SIN las marcas.
 *
 * Devuelve el texto y no su envoltorio para que cambiar la redacción de una marca no invalide
 * todos los sellos de la flota a la vez.
 */
export function bloqueEntreMarcas(
  texto: string, marcaInicio: string, marcaFin: string
): string | undefined {
  const par = parDeMarcas(texto, marcaInicio, marcaFin);
  if (!par) return undefined;
  return texto.slice(par.desde, par.fin).trim();
}

/**
 * Escribe un bloque dentro de un fichero conservando lo de fuera BYTE A BYTE.
 *
 * Si no había bloque, lo añade al final separado por una línea en blanco: nunca al principio,
 * porque lo primero de un `CLAUDE.md` suele ser el título que escribió una persona.
 */
export function conBloqueEntreMarcas(
  textoOriginal: string, bloque: string, marcaInicio: string, marcaFin: string
): string {
  const nuevo = `${marcaInicio}\n${bloque.trim()}\n${marcaFin}`;
  const par = parDeMarcas(textoOriginal, marcaInicio, marcaFin);
  if (!par) {
    /*
     * No hay bloque cerrado. Puede que no haya nada, o que haya una apertura huérfana de una
     * siembra cortada. En los dos casos se conserva TODO lo anterior y el bloque nuevo va detrás:
     * adivinar dónde terminaba un bloque a medio escribir es exactamente cómo se borra texto
     * ajeno, y ese texto puede ser el manual que escribió una persona.
     */
    const base = textoOriginal.trimEnd();
    return base.length === 0 ? `${nuevo}\n` : `${base}\n\n${nuevo}\n`;
  }
  return textoOriginal.slice(0, par.inicio) + nuevo + textoOriginal.slice(par.fin + marcaFin.length);
}

/** El bloque del contexto fijo que hay en un fichero, sin las marcas. */
export function bloqueGestionado(texto: string): string | undefined {
  return bloqueEntreMarcas(texto, MARCA_INICIO, MARCA_FIN);
}

/** El contexto fijo, fusionado dentro del fichero. */
export function conBloqueGestionado(textoOriginal: string, bloque: string): string {
  return conBloqueEntreMarcas(textoOriginal, bloque, MARCA_INICIO, MARCA_FIN);
}

/** El bloque del PERFIL que hay en un fichero, sin las marcas, o `undefined` si no está. */
export function bloqueDePerfil(texto: string): string | undefined {
  return bloqueEntreMarcas(texto, MARCA_PERFIL_INICIO, MARCA_PERFIL_FIN);
}

/** El perfil, fusionado dentro del fichero. */
export function conBloqueDePerfil(textoOriginal: string, bloque: string): string {
  return conBloqueEntreMarcas(textoOriginal, bloque, MARCA_PERFIL_INICIO, MARCA_PERFIL_FIN);
}

/**
 * Quita un bloque de un fichero conservando TODO lo de fuera byte a byte.
 *
 * Existe porque «la base es la fuente de verdad y el fichero se GENERA desde ella» sólo es cierto
 * si borrar en la base borra en el fichero. Sin esto, vaciar un campo desde la consola dejaba el
 * texto VIEJO escrito y el generador contestaba «está al día»: el agente seguía leyendo un
 * propósito que alguien ya había quitado, sin error y sin forma de enterarse.
 *
 * Se lleva también el salto de línea que quedaría suelto donde estaba el bloque, para que quitar y
 * volver a poner sea idempotente y no vaya acumulando líneas en blanco.
 */
export function sinBloqueEntreMarcas(
  textoOriginal: string, marcaInicio: string, marcaFin: string
): string {
  const par = parDeMarcas(textoOriginal, marcaInicio, marcaFin);
  if (!par) return textoOriginal;
  const antes = textoOriginal.slice(0, par.inicio).replace(/\n{2,}$/, '\n');
  const despues = textoOriginal.slice(par.fin + marcaFin.length).replace(/^\n+/, '');
  if (antes.trim().length === 0) return despues;
  return despues.length === 0 ? antes : `${antes.replace(/\n*$/, '\n')}\n${despues}`;
}

/** El fichero sin el bloque del perfil, con lo humano intacto. */
export function sinBloqueDePerfil(texto: string): string {
  return sinBloqueEntreMarcas(texto, MARCA_PERFIL_INICIO, MARCA_PERFIL_FIN);
}
