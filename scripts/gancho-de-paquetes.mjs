/**
 * Resolution hook registered by `paquetes-de-este-arbol.mjs`. See that file for rationale.
 *
 * Only intercepts EXACT `@cauce/...` specifiers for monorepo packages. Everything
 * else —`ws`, `zod`, `node:fs`, relative paths— falls through to the default
 * resolver untouched: a hook that rewrote too much would break real dependency
 * resolution and the failure would surface far from here.
 */

/** Path to each package's COMPILED entry, relative to the repo root. */
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
