import { readFile } from 'node:fs/promises';

const serviceUrl = new URL('../../ops/systemd/cauce-v3-ci-local.service', import.meta.url);
const scriptUrl = new URL('../../ops/scripts/ci-nocturno.sh', import.meta.url);

describe('local CI systemd contract', () => {
  it('delegates the nightly gate to the disposable-worktree script', async () => {
    const service = await readFile(serviceUrl, 'utf8');

    expect(service).toContain(
      "ExecStart=/usr/bin/bash -lc 'umask 022 && exec /datos/workspaces/zeus/cauce-v3/ops/scripts/ci-nocturno.sh'",
    );
    expect(service).toContain('TimeoutStartSec=14400');
  });

  it('sets a non-interactive, color-free environment so pnpm never waits on a TTY', async () => {
    const service = await readFile(serviceUrl, 'utf8');

    expect(service).toContain('Environment=CI=true');
    expect(service).toContain('Environment=NO_COLOR=1');
  });

  it('rejects history rewriting, hidden worktree changes, and partial test gates', async () => {
    const script = await readFile(scriptUrl, 'utf8');

    expect(script).not.toContain('--rebase');
    expect(script).not.toContain('--autostash');
    expect(script).not.toContain('pnpm test:unit');
    expect(script).not.toContain('pnpm test:pty');
    expect(script).not.toContain('ops/scripts/validate.sh');
    expect(script).toContain('CAUCE_REQUIRE_TESTCONTAINERS=1 pnpm test');
    expect(script).toContain('CAUCE_RELEASE_VALIDATION=1 pnpm ops:validate');
    expect(script).toContain('git worktree add --detach');
  });
});
