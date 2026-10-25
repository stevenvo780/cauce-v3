import { describe } from 'vitest';
import { registerRehearsalDockerContext } from './s2-espacio-estandar.rehearsal.js';

registerRehearsalDockerContext();

describe('prepared standard-space rehearsal on the assigned laboratory', async () => {
  const previousRehearsal = process.env.CAUCE_S2_DEPLOYMENT_REHEARSAL;
  const previousCommit = process.env.CAUCE_S2_PREPARED_COMMIT;
  process.env.CAUCE_S2_DEPLOYMENT_REHEARSAL = '1';
  process.env.CAUCE_S2_PREPARED_COMMIT = '5dcb70e733ede767d7d7281930ed4b87113a73c8';
  try { await import('./s2-espacio-estandar.test.js'); }
  finally {
    if (previousRehearsal === undefined) delete process.env.CAUCE_S2_DEPLOYMENT_REHEARSAL;
    else process.env.CAUCE_S2_DEPLOYMENT_REHEARSAL = previousRehearsal;
    if (previousCommit === undefined) delete process.env.CAUCE_S2_PREPARED_COMMIT;
    else process.env.CAUCE_S2_PREPARED_COMMIT = previousCommit;
  }
});
