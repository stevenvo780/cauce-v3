import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function publicGitOrigin(origin) {
  let url;
  try {
    url = new URL(origin.trim());
  } catch {
    const scp = /^(?:[^@/\s]+@)?([A-Za-z0-9.-]+):([^?#\s]+)$/u.exec(origin.trim());
    if (!scp) throw new Error('Repository origin is not a supported public Git URL');
    url = new URL(`https://${scp[1]}/${scp[2]}`);
  }
  if (!['https:', 'http:', 'ssh:'].includes(url.protocol)) {
    throw new Error('Repository origin is not a supported public Git URL');
  }
  const protocol = url.protocol === 'ssh:' ? 'https:' : url.protocol;
  return `${protocol}//${url.host}${url.pathname}`;
}

export function publicOriginEnvironment(repositoryRoot) {
  const origin = execFileSync('git', ['remote', 'get-url', 'origin'], {
    cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const publicOrigin = publicGitOrigin(origin);
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'cauce-evidence-git-'));
  const repository = join(temporaryRoot, 'repository');
  const cleanup = () => rmSync(temporaryRoot, { recursive: true, force: true });
  const git = (args) => execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git(['clone', '--quiet', '--shared', '--no-checkout', '--local', repositoryRoot, repository]);
    git(['-C', repository, 'remote', 'set-url', 'origin', publicOrigin]);
    return {
      environment: {
        GIT_DIR: join(repository, '.git'), GIT_WORK_TREE: repositoryRoot,
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      },
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
