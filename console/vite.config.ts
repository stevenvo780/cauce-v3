import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    server: {
      port: 4173,
      proxy: {
        '/v3': {
          target: env.CAUCE_API_PROXY_TARGET || 'http://127.0.0.1:3000',
          changeOrigin: false,
          ws: true,
        },
      },
    },
    build: {
      target: 'es2022',
      sourcemap: true,
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom'],
            xterm: ['@xterm/xterm', '@xterm/addon-fit'],
          },
        },
      },
    },
    test: {
      /*
       * `@cauce/protocol` se resuelve a ESTE árbol y SÓLO en las pruebas.
       *
       * Dos motivos, y los dos ya costaron una medición falsa:
       *
       * 1. `node_modules/@cauce/protocol` es un enlace que sale del checkout principal, así que
       *    sin este alias una prueba de este worktree mide el protocolo de OTRA RAMA. La
       *    dirección peligrosa no es la roja: es que una rama que borre una guarda salga VERDE
       *    porque la guarda sigue viva en el árbol del vecino.
       * 2. Va en `test` y no en `resolve` a propósito: la aplicación NO importa `@cauce/protocol`
       *    —arrastraría `zod` entero al bundle del navegador— y por eso `perfil.ts` reimplementa
       *    la cuenta de unidades. `perfil.test.ts` es quien comprueba que las dos dan el MISMO
       *    número, que es lo que impide que se separen.
       */
      alias: [
        {
          find: /^@cauce\/protocol$/,
          replacement: fileURLToPath(new URL('../packages/protocol/src/index.ts', import.meta.url)),
        },
      ],
      environment: 'jsdom',
      globals: true,
      setupFiles: './src/test/setup.ts',
      css: true,
      restoreMocks: true,
      clearMocks: true,
      coverage: {
        reporter: ['text', 'html'],
      },
    },
  };
});
