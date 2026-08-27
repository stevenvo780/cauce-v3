import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export const RAIZ_CSS = resolve(process.cwd(), 'src');

/**
 * Lee un fichero CSS resolviendo recursivamente sus directivas `@import`.
 * Acepta tanto rutas absolutas como relativas a `src`.
 */
export function leerCss(ruta: string): string {
  const abs = isAbsolute(ruta) ? ruta : resolve(RAIZ_CSS, ruta);
  const contenido = readFileSync(abs, 'utf8');
  return contenido.replace(/@import\s+['"]([^'"]+)['"];/g, (_, importPath: string) => {
    const subAbs = resolve(abs, '..', importPath);
    return leerCss(subAbs);
  });
}

export function leerCssDesdeRaiz(rutaRelativa: string): string {
  return leerCss(resolve(RAIZ_CSS, rutaRelativa));
}
