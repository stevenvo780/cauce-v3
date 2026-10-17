import { defineConfig } from 'vite';
import base from '../vite.config.ts';

export default defineConfig(async env => {
  const cacheDir = process.env.CAUCE_QA_VITE_CACHE_DIR;
  if (!cacheDir) throw new Error('QA cache directory is required');
  const config = await (typeof base === 'function' ? base(env) : base);
  // A request the mocks do not answer must fail the same way in every run; under the release gate another suite
  // may hold the default API port, so the proxy points at a port nothing listens on (discard, 9).
  const proxy = Object.fromEntries(Object.entries(config.server?.proxy ?? {})
    .map(([path, rule]) => [path, { ...rule, target: 'http://127.0.0.1:9' }]));
  return { ...config, cacheDir, server: { ...config.server, proxy } };
});
