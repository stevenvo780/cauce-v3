import { defineConfig } from 'vite';
import base from '../vite.config.ts';

export default defineConfig(async env => {
  const cacheDir = process.env.CAUCE_QA_VITE_CACHE_DIR;
  if (!cacheDir) throw new Error('QA cache directory is required');
  const config = await (typeof base === 'function' ? base(env) : base);
  return { ...config, cacheDir };
});
