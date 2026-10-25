import { describe, expect, it } from 'vitest';
import { imageRefreshFixture } from './v4-fleet-image-refresh.helpers.js';

describe('restauración entre releases con Docker real', () => {
  const scenario = imageRefreshFixture();
  it('restaura el adaptador con la release vigente y conserva su volumen de estado', async () => {
    expect(await scenario('two-releases')).toMatchObject({ runtime_verified: true, original_id: false,
      current_release_mounted: true, previous_release_available: true, state_volume_preserved: true });
  });
});
