import { readFile } from 'node:fs/promises';

const stackHealthUrl = new URL('../../ops/scripts/stack-health.sh', import.meta.url);

describe('retired shadow-router readiness integration', () => {
  it('requires semantic shadow-router readiness whenever the production profile configures it', async () => {
    const stackHealth = await readFile(stackHealthUrl, 'utf8');
    expect(stackHealth).toMatch(/grep -qx shadow-router <<<"\$configured"/u);
    expect(stackHealth).toContain(
      '/run/cauce-shadow/router/router.sock /health/ready ready',
    );
    expect(stackHealth).toMatch(
      /prod exec -T shadow-router[\s\S]*deploy\/unix-readiness-probe\.mjs/u,
    );
    expect(stackHealth).toContain('configured relay/Telegram/terminal/shadow services');
  });
});
