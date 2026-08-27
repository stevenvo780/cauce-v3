import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const longDecimal = /(?<![0-9])[1-9][0-9]{8,18}(?![0-9])/u;

async function source(path: string): Promise<string> {
  return readFile(resolve(root, path), 'utf8');
}

describe('tracked operational material does not inventory external identities', () => {
  it('keeps orphan diagnostics tenant-scoped and body-free', async () => {
    const cli = await source('ops/cli/cauce-huerfanas');
    expect(cli).toContain('m.tenant_id');
    expect(cli).not.toMatch(/CASE\s+m\.origin->>'conversation_id'/u);
    expect(cli).toContain("char_length(coalesce(m.body->>'text', ''))");
    expect(cli).not.toMatch(/\bAS\s+pedido\b/u);
    expect(cli).not.toMatch(longDecimal);

    const compatibility = await source('ops/guardias/cauce-huerfanas.sh');
    expect(compatibility).toContain('../cli/cauce-huerfanas');
    expect(compatibility).not.toContain('SELECT');
  });

  it('keeps direct-channel identities out of runbooks, mocks and scheduled prompts', async () => {
    for (const path of [
      'ops/guardias/hegel-ventas-checkin.py',
      'apps/console/src/features/config/ConfigPage.tsx',
      'ops/observability/alertmanager.yaml',
    ]) {
      expect(await source(path), path).not.toMatch(longDecimal);
    }
  });
});
