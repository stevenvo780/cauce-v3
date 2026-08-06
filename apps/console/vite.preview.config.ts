import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Config aparte, a propósito: el banco de pruebas visual NO debe entrar en el bundle que se
 * despliega. `pnpm build` sigue construyendo sólo `index.html`.
 */
export default defineConfig({
  root: 'preview',
  base: './',
  plugins: [react()],
  build: {
    target: 'es2022',
    outDir: '../dist-preview',
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
