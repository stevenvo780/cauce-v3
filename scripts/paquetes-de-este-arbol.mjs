#!/usr/bin/env node
/**
 * Registers the Node resolution hook to redirect `@cauce/*` packages
 * to the local work tree at runtime.
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./gancho-de-paquetes.mjs', import.meta.url, {
  data: { raiz: pathToFileURL(new URL('..', import.meta.url).pathname).href }
});
