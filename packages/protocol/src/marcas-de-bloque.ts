/**
 * Utilidades para insertar, extraer y remover bloques gestionados por Cauce
 * delimitados por marcas HTML dentro de ficheros de texto.
 */

/** Versión de las marcas del bloque de contexto fijo. */
export const VERSION_CONTEXTO_FIJO = '1';

export const MARCA_INICIO =
  `<!-- CAUCE:CONTEXTO-FIJO v${VERSION_CONTEXTO_FIJO} — generado, no editar dentro de este bloque -->`;
export const MARCA_FIN = '<!-- CAUCE:FIN-CONTEXTO-FIJO -->';

/** Versión y marcas del bloque de perfil del agente. */
export const VERSION_PERFIL = '1';
export const MARCA_PERFIL_INICIO =
  `<!-- CAUCE:PERFIL v${VERSION_PERFIL} — generado desde la configuración, no editar dentro de este bloque -->`;
export const MARCA_PERFIL_FIN = '<!-- CAUCE:FIN-PERFIL -->';

/**
 * Encuentra la última apertura de marca que cuente con un cierre posterior válido.
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
    if (texto.includes(marcaFin, busca + marcaInicio.length)) inicio = busca;
  }
  if (inicio === -1) return undefined;
  const desde = inicio + marcaInicio.length;
  const fin = texto.indexOf(marcaFin, desde);
  if (fin === -1) return undefined;
  return { inicio, desde, fin };
}

/** Extrae el contenido entre un par de marcas, sin incluir los delimitadores. */
export function bloqueEntreMarcas(
  texto: string, marcaInicio: string, marcaFin: string
): string | undefined {
  const par = parDeMarcas(texto, marcaInicio, marcaFin);
  if (!par) return undefined;
  return texto.slice(par.desde, par.fin).trim();
}

/** Inserta o reemplaza el bloque delimitado por marcas dentro del texto original. */
export function conBloqueEntreMarcas(
  textoOriginal: string, bloque: string, marcaInicio: string, marcaFin: string
): string {
  const nuevo = `${marcaInicio}\n${bloque.trim()}\n${marcaFin}`;
  const par = parDeMarcas(textoOriginal, marcaInicio, marcaFin);
  if (!par) {
    const base = textoOriginal.trimEnd();
    return base.length === 0 ? `${nuevo}\n` : `${base}\n\n${nuevo}\n`;
  }
  return textoOriginal.slice(0, par.inicio) + nuevo + textoOriginal.slice(par.fin + marcaFin.length);
}

/** El bloque del contexto fijo que hay en un fichero, sin las marcas. */
export function bloqueGestionado(texto: string): string | undefined {
  return bloqueEntreMarcas(texto, MARCA_INICIO, MARCA_FIN);
}

/** Inserta o actualiza el bloque de contexto fijo dentro del fichero. */
export function conBloqueGestionado(textoOriginal: string, bloque: string): string {
  return conBloqueEntreMarcas(textoOriginal, bloque, MARCA_INICIO, MARCA_FIN);
}

/** El bloque del perfil que hay en un fichero, sin las marcas, o undefined si no está. */
export function bloqueDePerfil(texto: string): string | undefined {
  return bloqueEntreMarcas(texto, MARCA_PERFIL_INICIO, MARCA_PERFIL_FIN);
}

/** Inserta o actualiza el bloque de perfil dentro del fichero. */
export function conBloqueDePerfil(textoOriginal: string, bloque: string): string {
  return conBloqueEntreMarcas(textoOriginal, bloque, MARCA_PERFIL_INICIO, MARCA_PERFIL_FIN);
}

/** Quita un bloque delimitado por marcas conservando el resto del contenido. */
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

/** Devuelve el fichero sin el bloque de perfil. */
export function sinBloqueDePerfil(texto: string): string {
  return sinBloqueEntreMarcas(texto, MARCA_PERFIL_INICIO, MARCA_PERFIL_FIN);
}
