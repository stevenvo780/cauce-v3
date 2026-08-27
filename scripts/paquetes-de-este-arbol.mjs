#!/usr/bin/env node
/**
 * Registra el gancho de resolución de Node para redirigir los paquetes `@cauce/*`
 * al árbol de trabajo local en tiempo de ejecución.
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./gancho-de-paquetes.mjs', import.meta.url, {
  data: { raiz: pathToFileURL(new URL('..', import.meta.url).pathname).href }
});
