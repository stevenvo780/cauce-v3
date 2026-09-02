import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const wrapperUrl = new URL('../../scripts/archify-cauce.mjs', import.meta.url);
const lockUrl = new URL('../../scripts/archify.lock.json', import.meta.url);
const specificationUrl = new URL(
  '../../docs/diagramas/cauce-v3.architecture.json',
  import.meta.url,
);
const artifactUrl = new URL(
  '../../docs/diagramas/cauce-v3.architecture.html',
  import.meta.url,
);
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

describe('Archify integration contract', () => {
  it('pins exact installed bytes and never forwards the ambient environment', async () => {
    const wrapper = await readFile(wrapperUrl, 'utf8');
    const lock = JSON.parse(await readFile(lockUrl, 'utf8')) as Record<string, unknown>;

    expect(lock).toMatchObject({
      schemaVersion: 1,
      name: 'archify',
      version: '2.16.0',
      commit: 'c826e6c3a7abad19c0f3cd1ca57207d54b1ad8de',
      installedFileCount: 190,
    });
    expect(lock.installedTreeSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(wrapper).toContain('safeInheritedEnvironment');
    expect(wrapper).toContain("ARCHIFY_UPDATE_CHECK_DISABLED: '1'");
    expect(wrapper).not.toMatch(/env:\s*\{\s*\.\.\.process\.env/gu);
  });

  it('ships an offline artifact with the real Telegram persistence path', async () => {
    const artifact = await readFile(artifactUrl, 'utf8');
    const specification = JSON.parse(await readFile(specificationUrl, 'utf8')) as {
      meta: { repository: { revision: string } };
      components: { sources?: { path: string }[] }[];
      connections: { from: string; to: string; label: string }[];
    };
    const evidenceMatch = /<script id="archify-source-evidence-data" type="application\/json">([^<]+)<\/script>/u
      .exec(artifact);
    const autoLoadingUrl = /<(?:iframe|img|link|script|source)\b[^>]*(?:href|src)=["']https?:\/\//iu;

    expect(artifact).not.toMatch(autoLoadingUrl);
    expect(artifact).not.toMatch(/url\(\s*["']?https?:\/\//iu);
    expect(evidenceMatch).not.toBeNull();
    const evidence = JSON.parse(evidenceMatch?.[1] ?? '{}') as {
      repository?: { revision?: string };
    };
    expect(specification.meta.repository.revision).toMatch(/^[a-f0-9]{40}$/u);
    expect(evidence.repository?.revision).toBe(specification.meta.repository.revision);
    expect(() => {
      execFileSync(
        'git',
        ['merge-base', '--is-ancestor', specification.meta.repository.revision, 'HEAD'],
        { cwd: repositoryRoot, stdio: 'pipe' },
      );
    }, 'Archify revision must be an ancestor of HEAD').not.toThrow();
    const evidencePaths = specification.components.flatMap(
      (component) => component.sources?.map((source) => source.path) ?? [],
    );
    expect(evidencePaths.length).toBeGreaterThan(0);
    const staleEvidence = execFileSync(
      'git',
      [
        'diff',
        '--name-only',
        `${specification.meta.repository.revision}..HEAD`,
        '--',
        ...evidencePaths,
      ],
      { cwd: repositoryRoot, encoding: 'utf8' },
    ).trim();
    expect(
      staleEvidence,
      'a cited evidence path changed since the pinned revision; run: pnpm arch:refresh',
    ).toBe('');
    expect(specification.connections).toContainEqual(expect.objectContaining({
      from: 'telegram_bridge',
      to: 'postgres',
      label: 'SQL/store durable',
    }));
    expect(specification.connections).not.toContainEqual(expect.objectContaining({
      from: 'telegram_bridge',
      to: 'gateway',
    }));
  });
});
