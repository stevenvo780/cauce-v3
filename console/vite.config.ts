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
      // Resolve @cauce/protocol to current workspace during tests
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
      testTimeout: 15000,
      coverage: {
        reporter: ['text', 'html'],
      },
    },
  };
});
