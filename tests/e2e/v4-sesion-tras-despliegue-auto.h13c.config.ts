import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeConfig } from 'vitest/config';
import configuration from '../../vitest.config.js';

const candidate: unknown = JSON.parse(readFileSync(join(process.cwd(),
  '.delegados/v4/recibos/h13c-e2e-mantenimiento-adaptador-parado-1025/c-candidate.json'), 'utf8'));
if (typeof candidate !== 'object' || candidate === null || !('revision' in candidate)
    || typeof candidate.revision !== 'string' || !/^[a-f0-9]{40}$/u.test(candidate.revision)) {
  throw new Error('the final automatic update candidate requires an exact Git revision');
}
export default mergeConfig(configuration, { test: { env: { H13_AUTO_B_SOURCE: candidate.revision } } });
