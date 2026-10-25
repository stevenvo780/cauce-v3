import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { applyMigrations, createPool } from '@cauce/store';
import { GenericContainer, Wait } from 'testcontainers';
import { arrancarPostgresDePrueba, COMANDO_POSTGRES_DE_PRUEBA, saludDePostgresDePrueba } from '../helpers/contenedor-de-prueba.js';
import { provisionTestLogin, runtimeRoleRequested, TEST_RUNTIME_LOGIN, type TestDatabase } from '../helpers/postgres.js';

const execute = promisify(execFile);
const root = process.cwd();
export async function authorityDatabase(owner: string, run: string): Promise<TestDatabase> {
  const password = randomUUID();
  const container = await arrancarPostgresDePrueba(() => new GenericContainer('postgres:16-alpine')
    .withName(`zz-canary-${owner}-pg-${run}`).withLabels({ 'cauce.e2e.owner': owner })
    .withCommand([...COMANDO_POSTGRES_DE_PRUEBA])
    .withEnvironment({ POSTGRES_DB: 'cauce_test', POSTGRES_USER: 'cauce_test', POSTGRES_PASSWORD: password })
    .withExposedPorts(5432).withHealthCheck(saludDePostgresDePrueba('cauce_test', 'cauce_test')).withWaitStrategy(Wait.forHealthCheck()).start());
  const adminUrl = `postgresql://cauce_test:${password}@${container.getHost()}:${String(container.getMappedPort(5432))}/cauce_test`;
  const adminPool = createPool(adminUrl);
  try {
    await applyMigrations(adminPool);
    const url = runtimeRoleRequested() ? await provisionTestLogin(adminPool, adminUrl, TEST_RUNTIME_LOGIN, 'cauce_runtime') : adminUrl;
    return { container, pool: url === adminUrl ? adminPool : createPool(url), url, adminPool, adminUrl };
  } catch (error) { await adminPool.end(); await container.stop(); throw error; }
}

export async function authorityRuntimeImage(directory: string, image: string, owner: string, receipts: string, revision: string) {
  const context = join(directory, 'runtime-source');
  await mkdir(context);
  const paths = ['.dockerignore', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'tsconfig.build.json',
    'vitest.config.ts', 'packages', 'services', 'console', 'deploy', 'ops/cli/space_archive.py', 'ops/cli/space_archive_stream.py', 'ops/cli/space_backup_validate.py',
    'tests/terminal-pty/certs.mjs', 'tests/terminal-pty/certs.d.mts', 'ops/scripts/source-digest.py', 'ops/scripts/digest_lib.py'];
  const listing = await execute('git', ['ls-tree', '-rz', '--full-tree', revision, '--', ...paths], { maxBuffer: 16 * 1024 * 1024 });
  const files = listing.stdout.split('\0').filter(Boolean).map(entry => {
    const [metadata, path] = entry.split('\t');
    if (!path || !metadata || !/^(100644|100755) blob [a-f0-9]{40}$/.test(metadata)
      || path.startsWith('/') || path.split('/').some(part => part === '..' || part === '.')) throw new Error('runtime archive requires regular source files');
    if (path.split('/').some(part => ['node_modules', 'dist', 'private', 'credentials', 'sessions'].includes(part)
      || part.startsWith('.env') || ['auth.json', 'settings.local.json'].includes(part))) throw new Error('forbidden runtime source path');
    return path;
  });
  const archive = join(directory, 'runtime-source.tar');
  const presentPaths = paths.filter(path => files.some(file => file === path || file.startsWith(`${path}/`)));
  await execute('git', ['archive', '--format=tar', '--output', archive, revision, '--', ...presentPaths]);
  await execute('tar', ['-xf', archive, '-C', context]);
  await rm(archive);
  const digest = (await execute('python3', [join(context, 'ops/scripts/source-digest.py'), '--domain', 'runtime', '--root', context])).stdout.trim();
  const migrations = files.filter(path => /^packages\/store\/migrations\/[^/]+\.sql$/.test(path)).sort();
  const latest = migrations.at(-1)?.split('/').at(-1);
  if (!latest) throw new Error('runtime migration marker absent');
  const built = await execute('docker', ['build', '--target', 'runtime', '--label', `cauce.e2e.owner=${owner}`,
    '--build-arg', `CAUCE_RELEASE_COMMIT=${revision}`, '--build-arg', `CAUCE_SOURCE_DIGEST=${digest}`,
    '--build-arg', `CAUCE_SCHEMA_COMPATIBLE_THROUGH=${latest}`, '-t', image, '-f', join(context, 'deploy/Dockerfile'), context],
  { timeout: 1_200_000, maxBuffer: 32 * 1024 * 1024 }).catch(async (error: unknown) => {
    const failed = error as { stdout?: string; stderr?: string };
    await writeFile(join(receipts, 'runtime-build.log'), (failed.stdout ?? '') + (failed.stderr ?? ''), { mode: 0o600 });
    throw new Error('canonical runtime build failed; see runtime-build.log');
  });
  await writeFile(join(receipts, 'runtime-build.log'), built.stdout + built.stderr, { mode: 0o600 });
  const imageId = (await execute('docker', ['image', 'inspect', '--format', '{{.Id}}', image])).stdout.trim();
  await writeFile(join(receipts, 'runtime-build.json'), JSON.stringify({ image, imageId, revision, sourceDigest: digest, sourceKind: 'public HEAD archive',
    sourceFiles: files.length, dockerfileSha256: createHash('sha256').update(await readFile(join(context, 'deploy/Dockerfile'))).digest('hex') }, null, 2), { mode: 0o600 });
  return imageId;
}

export async function authorityAdapterBundle(directory: string, receipts: string, revision: string): Promise<string> {
  const source = join(directory, 'adapter-source'), bundle = join(directory, 'adapter-bundle');
  const env = { ...process.env, PNPM_CONFIG_STORE_DIR: join(directory, 'pnpm-store'), PNPM_CONFIG_PACKAGE_IMPORT_METHOD: 'copy' };
  await execute('git', ['clone', '--quiet', '--no-hardlinks', '--no-checkout', root, source]);
  await execute('git', ['-C', source, 'checkout', '--quiet', '--detach', revision]);
  const installed = await execute('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts', '--package-import-method', 'copy'],
    { cwd: source, env, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 }).catch(async (error: unknown) => {
    const failed = error as { stdout?: string; stderr?: string };
    await writeFile(join(receipts, 'adapter-install.log'), (failed.stdout ?? '') + (failed.stderr ?? ''), { mode: 0o600 });
    throw new Error('canonical adapter dependency install failed; see adapter-install.log');
  });
  await writeFile(join(receipts, 'adapter-install.log'), installed.stdout + installed.stderr, { mode: 0o600 });
  const built = await execute('bash', [join(source, 'ops/scripts/build-adapter-release.sh'), bundle],
    { cwd: source, env, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
  await writeFile(join(receipts, 'adapter-build.log'), built.stdout + built.stderr, { mode: 0o600 });
  await writeFile(join(receipts, 'adapter-build.json'), JSON.stringify({ revision, builder: 'ops/scripts/build-adapter-release.sh',
    digest: (await execute('python3', [join(root, 'ops/container-runtime/cauce-container-runtime.py'), 'bundle-digest', bundle])).stdout.trim() }, null, 2), { mode: 0o600 });
  await rm(source, { recursive: true, force: true });
  return bundle;
}
