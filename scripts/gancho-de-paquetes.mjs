/**
 * El gancho de resolución que registra `paquetes-de-este-arbol.mjs`. Ver allí el porqué.
 *
 * Sólo intercepta los especificadores `@cauce/...` EXACTOS de los paquetes del monorepo. Todo lo
 * demás —`ws`, `zod`, `node:fs`, las rutas relativas— cae al resolvedor de siempre sin tocarse:
 * un gancho que reescribiera de más rompería la resolución de dependencias reales y el fallo se
 * vería lejos de aquí.
 */

/** Dónde vive el punto de entrada COMPILADO de cada paquete, relativo a la raíz del árbol. */
const ENTRADAS = {
  '@cauce/protocol': 'packages/protocol/dist/index.js',
  '@cauce/store': 'packages/store/dist/index.js',
  '@cauce/adapter-sdk': 'packages/adapter-sdk/dist/src/index.js'
};

let raizDelArbol;

export function initialize(data) {
  raizDelArbol = data?.raiz;
}

export async function resolve(specifier, context, nextResolve) {
  const entrada = raizDelArbol === undefined ? undefined : ENTRADAS[specifier];
  if (entrada === undefined) return nextResolve(specifier, context);
  return {
    url: new URL(entrada, `${raizDelArbol.replace(/\/?$/, '/')}`).href,
    shortCircuit: true
  };
}
