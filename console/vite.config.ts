import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { ansiPaletteCss, xtermAnsiPalette } from './vite/ansi-palette';

const ANSI_CSS_ID = 'virtual:cauce/xterm-ansi.css';
const ANSI_CSS_RESOLVED = `\0${ANSI_CSS_ID}`;

function xtermAnsiCss(): Plugin {
  return {
    name: 'cauce-xterm-ansi-css',
    resolveId(id) {
      return id === ANSI_CSS_ID ? ANSI_CSS_RESOLVED : null;
    },
    load(id) {
      if (id !== ANSI_CSS_RESOLVED) return null;
      const bundle = createRequire(import.meta.url).resolve('@xterm/xterm');
      return ansiPaletteCss(xtermAnsiPalette(readFileSync(bundle, 'utf8')));
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), xtermAnsiCss()],
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
      pool: 'forks',
      poolOptions: { // a cap below the CPU count: uncapped, 149 jsdom files starve each other under load
        forks: { minForks: 1, maxForks: Math.max(2, Math.floor(cpus().length / 4)) },
      },
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
