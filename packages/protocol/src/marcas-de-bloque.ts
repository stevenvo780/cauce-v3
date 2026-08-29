/**
 * Utilities for inserting, extracting and removing Cauce-managed blocks
 * delimited by HTML markers within text files.
 */

/** Version of the fixed-context block markers. */
export const VERSION_CONTEXTO_FIJO = '1';

export const MARCA_INICIO =
  `<!-- CAUCE:CONTEXTO-FIJO v${VERSION_CONTEXTO_FIJO} — generado, no editar dentro de este bloque -->`;
export const MARCA_FIN = '<!-- CAUCE:FIN-CONTEXTO-FIJO -->';

/** Version and markers of the agent profile block. */
export const VERSION_PERFIL = '1';
export const MARCA_PERFIL_INICIO =
  `<!-- CAUCE:PERFIL v${VERSION_PERFIL} — generado desde la configuración, no editar dentro de este bloque -->`;
export const MARCA_PERFIL_FIN = '<!-- CAUCE:FIN-PERFIL -->';

/**
 * Finds the latest opening marker that has a valid closing marker after it.
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

/** Extracts the content between a pair of markers, excluding the delimiters. */
export function bloqueEntreMarcas(
  texto: string, marcaInicio: string, marcaFin: string
): string | undefined {
  const par = parDeMarcas(texto, marcaInicio, marcaFin);
  if (!par) return undefined;
  return texto.slice(par.desde, par.fin).trim();
}

/** Inserts or replaces the marker-delimited block within the original text. */
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

/** The fixed-context block present in a file, without the markers. */
export function bloqueGestionado(texto: string): string | undefined {
  return bloqueEntreMarcas(texto, MARCA_INICIO, MARCA_FIN);
}

/** Inserts or updates the fixed-context block inside the file. */
export function conBloqueGestionado(textoOriginal: string, bloque: string): string {
  return conBloqueEntreMarcas(textoOriginal, bloque, MARCA_INICIO, MARCA_FIN);
}

/** The profile block present in a file, without the markers, or undefined if absent. */
export function bloqueDePerfil(texto: string): string | undefined {
  return bloqueEntreMarcas(texto, MARCA_PERFIL_INICIO, MARCA_PERFIL_FIN);
}

/** Inserts or updates the profile block inside the file. */
export function conBloqueDePerfil(textoOriginal: string, bloque: string): string {
  return conBloqueEntreMarcas(textoOriginal, bloque, MARCA_PERFIL_INICIO, MARCA_PERFIL_FIN);
}

/** Removes a marker-delimited block while keeping the rest of the content. */
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

/** Returns the file without the profile block. */
export function sinBloqueDePerfil(texto: string): string {
  return sinBloqueEntreMarcas(texto, MARCA_PERFIL_INICIO, MARCA_PERFIL_FIN);
}
