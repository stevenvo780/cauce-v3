import { describe, expect, it } from 'vitest';
import { imageRefreshFixture } from './v4-fleet-image-refresh.helpers.js';

describe('refresco de imagen con Docker y helper de ciclo de vida reales', () => {
  const scenario = imageRefreshFixture();

  it('sustituye la imagen cuando stop y start reales completan', async () => {
    expect(await scenario('success')).toMatchObject({ status: 'succeeded', new_image: true, replaced: true });
  });

  it('restaura y verifica el adaptador cuando el contenedor original nunca se detuvo', async () => {
    expect(await scenario('live-container-rollback')).toMatchObject({ original_id: true, original_image: true,
      running: true, container_never_stopped: true, adapter_running: true, receipt: 'rolled_back' });
  });

  it('restaura y verifica el adaptador tras un fallo real al arrancar la imagen nueva', async () => {
    const result = await scenario('broken-image', 'bad');
    expect(result).toMatchObject({ original_id: true, original_image: true, running: true,
      adapter_running: true, receipt: 'rolled_back' });
    expect(result.failure).toMatchObject({ type: 'SafeFailure', message: expect.stringContaining('cause=SafeFailure:') });
    expect(result.failure_cause).toEqual(expect.stringContaining('runtime effect or observation failed'));
  });

  it('conserva parado el adaptador que ya lo estaba antes del refresco fallido', async () => {
    expect(await scenario('idle-container-rollback', 'bad')).toMatchObject({ original_id: true, original_image: true,
      running: true, adapter_running: false, receipt: 'rolled_back' });
  });
});
