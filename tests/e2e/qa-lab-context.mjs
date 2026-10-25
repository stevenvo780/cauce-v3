import { register } from 'node:module';
import { isMainThread } from 'node:worker_threads';

if (isMainThread && !new URL(import.meta.url).search) register(import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'vitest') return { url: new URL('?context', import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
}

export const expect = { getState: () => ({}) };

export function afterAll() {
  throw new Error('QA laboratory context cannot register Vitest hooks');
}

export function afterEach() {
  throw new Error('QA laboratory context cannot register Vitest hooks');
}
