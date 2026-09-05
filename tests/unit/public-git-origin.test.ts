import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicGitOrigin, publicOriginEnvironment } from '../../scripts/public-git-origin.mjs';

describe('public Git origin for evidence tools', () => {
  it('strips authentication and query data without changing repository identity', () => {
    expect(publicGitOrigin('https://user:fixture-secret@example.test/org/repo.git?token=fixture#private'))
      .toBe('https://example.test/org/repo.git');
    expect(publicGitOrigin('https://example.test/org/repo.git'))
      .toBe('https://example.test/org/repo.git');
  });

  it('normalizes SSH origins without forwarding authentication', () => {
    expect(publicGitOrigin('git@example.test:org/repo.git'))
      .toBe('https://example.test/org/repo.git');
    expect(publicGitOrigin('ssh://git@example.test/org/repo.git'))
      .toBe('https://example.test/org/repo.git');
  });

  it('rejects unsupported origins without echoing their input', () => {
    for (const origin of ['invalid fixture-secret origin', 'file:///private/fixture-secret']) {
      expect(() => publicGitOrigin(origin)).toThrow('Repository origin is not a supported public Git URL');
      expect(() => publicGitOrigin(origin)).not.toThrow('fixture-secret');
    }
  });

  it('shadows credential URL rewrites only inside the evidence process', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cauce-public-origin-'));
    const git = (args: string[], env = process.env): string => execFileSync('git', args, {
      cwd: directory, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    try {
      git(['init']);
      git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'fixture']);
      git(['remote', 'add', 'origin', 'https://example.test/org/repo.git']);
      git(['config', 'url.https://fixture:fixture-secret@example.test/.insteadOf', 'https://example.test/']);
      const before = git(['remote', 'get-url', 'origin']);
      const evidence = publicOriginEnvironment(directory);
      try {
        const env = { ...process.env, ...evidence.environment };
        expect(git(['remote', 'get-url', 'origin'], env)).toBe('https://example.test/org/repo.git');
        expect(git(['rev-parse', '--show-toplevel'], env)).toBe(directory);
        expect(git(['rev-parse', 'HEAD'], env)).toBe(git(['rev-parse', 'HEAD']));
      } finally {
        evidence.cleanup();
      }
      expect(git(['remote', 'get-url', 'origin'])).toBe(before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
