#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const lockPath = join(scriptDirectory, 'archify.lock.json');
const specificationPath = join(repositoryRoot, 'docs/diagramas/cauce-v3.architecture.json');
const artifactPath = join(repositoryRoot, 'docs/diagramas/cauce-v3.architecture.html');
const safeInheritedEnvironment = [
  'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TEMP', 'TMP', 'TERM',
  'PATHEXT', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA', 'ARCHIFY_CHROME',
];
const remoteFontBlock = `  <!-- Async font load: a blackholed network must not block first paint.
       The body font stack falls back to system monospace until it lands. -->
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap"
        rel="stylesheet" media="print" onload="this.media='all'">
  <noscript>
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  </noscript>
`;

async function readLock() {
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  if (lock.schemaVersion !== 1 || lock.name !== 'archify') {
    throw new Error(`invalid Archify lock: ${lockPath}`);
  }
  return lock;
}

async function collectFiles(root, directory = root, result = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Archify install contains a symbolic link: ${path}`);
    if (entry.isDirectory()) await collectFiles(root, path, result);
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

async function treeDigest(root) {
  const files = await collectFiles(root);
  files.sort((left, right) => {
    const a = relative(root, left);
    const b = relative(root, right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const tree = createHash('sha256');
  for (const file of files) {
    const path = relative(root, file).split('\\').join('/');
    const digest = createHash('sha256').update(await readFile(file)).digest('hex');
    tree.update(`${path}\0${digest}\n`);
  }
  return { digest: tree.digest('hex'), fileCount: files.length };
}

function candidateRoots() {
  return [
    resolve(repositoryRoot, '.agents/skills/archify'),
    process.env.ARCHIFY_SKILL_ROOT ? resolve(process.env.ARCHIFY_SKILL_ROOT) : null,
    process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME, 'skills/archify') : null,
    resolve(homedir(), '.codex/skills/archify'),
  ].filter(Boolean);
}

async function locatePinnedInstall(lock) {
  const failures = [];
  for (const root of [...new Set(candidateRoots())]) {
    try {
      const release = JSON.parse(await readFile(join(root, 'skill-release.json'), 'utf8'));
      if (release.version !== lock.version) {
        failures.push(`${root}: version ${release.version ?? 'unknown'}`);
        continue;
      }
      const tree = await treeDigest(root);
      if (tree.fileCount !== lock.installedFileCount || tree.digest !== lock.installedTreeSha256) {
        failures.push(`${root}: tree digest mismatch`);
        continue;
      }
      return { root, tree };
    } catch (error) {
      if (error?.code !== 'ENOENT') failures.push(`${root}: ${error.message}`);
    }
  }
  const detail = failures.length > 0 ? ` Inspected: ${failures.join('; ')}` : '';
  throw new Error(`Archify ${lock.version} is not installed with the pinned bytes.${detail}`);
}

async function offlineInstall(sourceRoot) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'cauce-archify-offline-'));
  const root = join(temporaryRoot, 'archify');
  try {
    await cp(sourceRoot, root, { recursive: true, force: false, errorOnExist: true });
    const templatePath = join(root, 'assets/template.html');
    const template = await readFile(templatePath, 'utf8');
    if (!template.includes(remoteFontBlock)) {
      throw new Error('pinned Archify template no longer contains the expected remote-font block');
    }
    const offlineTemplate = template.replace(
      remoteFontBlock,
      '  <!-- Remote web fonts removed by the Cauce offline-artifact wrapper. -->\n',
    );
    if (/fonts\.(?:googleapis|gstatic)\.com/u.test(offlineTemplate)) {
      throw new Error('derived Archify template still references remote font infrastructure');
    }
    await writeFile(templatePath, offlineTemplate, 'utf8');
    return {
      root,
      cleanup: async () => rm(temporaryRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

function childEnvironment(command) {
  const inherited = Object.fromEntries(safeInheritedEnvironment.flatMap((key) => (
    process.env[key] === undefined ? [] : [[key, process.env[key]]]
  )));
  return {
    ...inherited,
    CI: '1',
    NO_COLOR: '1',
    ARCHIFY_UPDATE_CHECK_DISABLED: '1',
    ...(command === 'visual-check' ? { ARCHIFY_CHROME_NO_SANDBOX: '1' } : {}),
  };
}

async function assertOfflineArtifact() {
  const artifact = await readFile(artifactPath, 'utf8');
  const autoLoadingUrl = /<(?:iframe|img|link|script|source)\b[^>]*(?:href|src)=["']https?:\/\//iu;
  if (autoLoadingUrl.test(artifact) || /url\(\s*["']?https?:\/\//iu.test(artifact)) {
    throw new Error('rendered architecture contains an auto-loading remote resource');
  }
}

function argumentsFor(command, cli) {
  const common = ['--quality', 'showcase', '--repo-root', repositoryRoot];
  if (command === 'verify-install') return null;
  if (command === 'doctor') return [cli, 'doctor'];
  if (command === 'validate') {
    return [cli, 'validate', 'architecture', specificationPath, ...common, '--json'];
  }
  if (command === 'render') {
    return [cli, 'deliver', 'architecture', specificationPath, artifactPath, ...common, '--json'];
  }
  if (command === 'preview') {
    return [cli, 'preview', 'architecture', specificationPath, artifactPath, ...common, '--no-open'];
  }
  if (command === 'visual-check') return [cli, 'visual-check', artifactPath, '--json'];
  throw new Error(`unknown command: ${command}`);
}

async function run() {
  const command = process.argv[2] ?? 'validate';
  const lock = await readLock();
  const install = await locatePinnedInstall(lock);
  if (command === 'verify-install') {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      version: lock.version,
      commit: lock.commit,
      root: install.root,
      files: install.tree.fileCount,
      treeSha256: install.tree.digest,
    }, null, 2)}\n`);
    return;
  }

  if (command === 'visual-check') await assertOfflineArtifact();
  const derived = command === 'render' || command === 'preview'
    ? await offlineInstall(install.root)
    : undefined;
  try {
    const cli = join(derived?.root ?? install.root, 'bin/archify.mjs');
    const invocation = argumentsFor(command, cli);
    const child = spawn(process.execPath, invocation, {
      cwd: repositoryRoot,
      env: childEnvironment(command),
      stdio: 'inherit',
    });
    const exitCode = await new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', code => resolveExit(code ?? 1));
    });
    if (exitCode === 0 && command === 'render') await assertOfflineArtifact();
    process.exitCode = exitCode;
  } finally {
    await derived?.cleanup();
  }
}

run().catch(error => {
  process.stderr.write(`archify-cauce: ${error.message}\n`);
  process.exitCode = 1;
});
