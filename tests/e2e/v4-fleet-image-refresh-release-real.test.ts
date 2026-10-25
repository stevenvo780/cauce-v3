import { describe, expect, it } from 'vitest';
import { imageRefreshFixture } from './v4-fleet-image-refresh.helpers.js';

describe('restauración entre releases con Docker real', () => {
  const scenario = imageRefreshFixture();
  it('restaura el adaptador con la release anterior montada aunque el ejecutor use otra', async () => {
    expect(await scenario('two-releases')).toMatchObject({ runtime_verified: true, original_id: true,
      old_release_retained: true, new_release_not_mounted: true });
  });
});
