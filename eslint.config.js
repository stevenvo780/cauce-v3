import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', '**/dist/**', 'node_modules/**', '.serena/**', 'console/**', 'ops/artifacts/**'] },
  {
    files: ['**/*.{js,mjs}'],
    ...js.configs.recommended,
    languageOptions: {
      globals: {
        console: 'readonly', process: 'readonly', URL: 'readonly', Buffer: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', fetch: 'readonly', URLSearchParams: 'readonly',
        AbortController: 'readonly', AbortSignal: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly',
        crypto: 'readonly', structuredClone: 'readonly', WebSocket: 'readonly',
        performance: 'readonly', queueMicrotask: 'readonly', setImmediate: 'readonly'
      }
    }
  },
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
    },
    rules: {
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      '@typescript-eslint/require-await': 'off'
    }
  },
  {
    files: ['packages/adapter-sdk/src/**/*.ts'],
    rules: {
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
      '@typescript-eslint/only-throw-error': 'off',
      '@typescript-eslint/no-base-to-string': 'off'
    }
  },
  {
    files: ['packages/adapter-sdk/test/**/*.{ts,mjs}'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'require-yield': 'off'
    }
  }
);
