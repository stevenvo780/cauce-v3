import { readFile } from 'node:fs/promises';

const serviceUrl = new URL('../../ops/systemd/cauce-v3-ci-local.service', import.meta.url);

describe('local CI systemd contract', () => {
  it('runs only on main after a fast-forward pull and executes every required gate', async () => {
    const service = await readFile(serviceUrl, 'utf8');

    expect(service).toContain(
      'ExecStart=/usr/bin/bash -lc \'umask 022 && test -z "$(git status --porcelain=v1)" && test "$(git branch --show-current)" = main && git pull --ff-only origin main && test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" && pnpm typecheck && pnpm lint && CAUCE_REQUIRE_TESTCONTAINERS=1 pnpm test && CAUCE_RELEASE_VALIDATION=1 pnpm ops:validate\'',
    );
    expect(service).toContain('git status --porcelain=v1');
    expect(service).toContain('git rev-parse origin/main');
  });

  it('rejects history rewriting, hidden worktree changes, and partial test gates', async () => {
    const service = await readFile(serviceUrl, 'utf8');

    expect(service).not.toContain('--rebase');
    expect(service).not.toContain('--autostash');
    expect(service).not.toContain('pnpm test:unit');
    expect(service).not.toContain('pnpm test:pty');
    expect(service).not.toContain('ops/scripts/validate.sh');
    expect(service).toContain('CAUCE_REQUIRE_TESTCONTAINERS=1 pnpm test');
  });
});
