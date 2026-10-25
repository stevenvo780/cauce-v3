import { describe } from 'vitest';
import { registerRehearsalDockerContext } from './s2-espacio-estandar.rehearsal.js';

registerRehearsalDockerContext();

describe('standard-space rehearsal on the assigned laboratory', async () => {
  const previous = process.env.CAUCE_S2_DEPLOYMENT_REHEARSAL;
  process.env.CAUCE_S2_DEPLOYMENT_REHEARSAL = '1';
  try { await import('./s2-espacio-estandar.test.js'); }
  finally {
    if (previous === undefined) delete process.env.CAUCE_S2_DEPLOYMENT_REHEARSAL;
    else process.env.CAUCE_S2_DEPLOYMENT_REHEARSAL = previous;
  }
});
