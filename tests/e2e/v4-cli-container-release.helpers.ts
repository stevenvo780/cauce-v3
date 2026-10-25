import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { applyMigrations, createPool, type DatabasePool } from '@cauce/store';
import { seedSyntheticCompanyContexts } from '../../packages/store/src/seed-dev-cli.js';
import { arrancarPostgresDePrueba, COMANDO_POSTGRES_DE_PRUEBA, saludDePostgresDePrueba } from '../helpers/contenedor-de-prueba.js';

export const RELEASE_OWNER = 'e2e-a9-sigue-1025';
const root = process.cwd();
export interface ReleaseCommand { code: number; stdout: string; stderr: string }

export async function releaseCommand(file: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeout?: number } = {}): Promise<ReleaseCommand> {
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = ''; let stderr = ''; let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      if (child.pid !== undefined) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    }, options.timeout ?? 120_000);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', () => { clearTimeout(timer); reject(new Error('owned release command did not start')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (expired) reject(new Error('owned release command exceeded its deadline'));
      else resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function checked(file: string, args: string[], timeout?: number): Promise<string> {
  const result = await releaseCommand(file, args, timeout === undefined ? {} : { timeout });
  if (result.code !== 0) throw new Error(`owned release ${file} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function snapshotBuildContext(directory: string): Promise<{ files: number; digest: string; revision: string }> {
  const paths = ['.dockerignore', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'tsconfig.build.json',
    'vitest.config.ts', 'packages', 'services', 'console', 'deploy', 'ops/cli/space_archive.py', 'ops/cli/space_backup_validate.py',
    'tests/terminal-pty/certs.mjs', 'tests/terminal-pty/certs.d.mts'];
  const listing = await checked('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...paths]);
  const selected = [...new Set(listing.split('\0').filter(Boolean))];
  for (const path of selected) {
    if (path.split('/').some(part => ['node_modules', 'dist', 'private', 'credentials', 'sessions'].includes(part)
      || part.startsWith('.env') || ['auth.json', 'settings.local.json'].includes(part))) throw new Error('release context contains a forbidden source path');
    const source = join(root, path);
    const details = await lstat(source);
    if (!details.isFile()) throw new Error('release source snapshot requires regular files');
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await cp(source, join(directory, path));
  }
  return { files: selected.length,
    digest: await checked('python3', [join(root, 'ops/scripts/source-digest.py'), '--domain', 'runtime', '--root', directory]),
    revision: await checked('git', ['rev-parse', 'HEAD']) };
}

async function certificates(directory: string) {
  const authority = join(directory, 'ca.crt'), authorityKey = join(directory, 'ca.key');
  const certificate = join(directory, 'server.crt'), key = join(directory, 'server.key');
  const wrong = join(directory, 'wrong-ca.crt');
  const config = join(directory, 'server.cnf'), csr = join(directory, 'server.csr');
  for (const [cert, privateKey, name] of [[authority, authorityKey, 'owned-release-ca'], [wrong, join(directory, 'wrong-ca.key'), 'owned-wrong-ca']]) {
    await checked('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', privateKey ?? '', '-out', cert ?? '',
      '-subj', `/CN=${name ?? ''}`, '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  }
  await writeFile(config, '[req]\ndistinguished_name=dn\nprompt=no\nreq_extensions=ext\n[dn]\nCN=postgres\n[ext]\n'
    + 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:postgres\n', { mode: 0o600 });
  await checked('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-config', config]);
  await checked('openssl', ['x509', '-req', '-in', csr, '-CA', authority, '-CAkey', authorityKey, '-set_serial', `0x${randomBytes(16).toString('hex')}`,
    '-out', certificate, '-days', '2', '-sha256', '-extfile', config, '-extensions', 'ext']);
  await Promise.all([authority, authorityKey, certificate, key, wrong].map(path => chmod(path, 0o600)));
  return { authority, certificate, key, wrong };
}

export async function startContainerReleaseFixture() {
  if (process.env.CAUCE_TEST_DATABASE_URL || process.getuid?.() !== 1000) throw new Error('release CLI requires an owned lab runner with uid 1000');
  const run = randomUUID().slice(0, 8);
  const prefix = `zz-canary-${RELEASE_OWNER}-release-${run}`;
  const project = `zz-canary-a9-release-${run}`;
  const directory = await mkdtemp('/datos/zz-canary-release-');
  const receipts = join(root, '.delegados/v4/recibos', RELEASE_OWNER, 'container-release', run);
  await mkdir(receipts, { recursive: true, mode: 0o700 });
  const imageTag = `${prefix}:runtime`;
  const network = `${project}_backend`;
  let database: StartedTestContainer | undefined;
  let pool: DatabasePool | undefined;
  let imageId = '';
  let networkCreated = false;
  const password = randomBytes(24).toString('base64url');
  const secrets = [password];
  const receipt = (name: string, value: Record<string, unknown>) => writeFile(join(receipts, `${name}.json`), `${JSON.stringify({ run, ...value }, null, 2)}\n`, { mode: 0o600 });
  const close = async () => {
    const errors: unknown[] = [];
    const attempt = async (action: () => Promise<unknown>) => { try { await action(); } catch (error) { errors.push(error); } };
    const leftovers = await releaseCommand('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}-plataforma`]);
    if (leftovers.code !== 0) errors.push(new Error('could not inspect owned Compose one-offs'));
    else for (const id of leftovers.stdout.trim().split('\n').filter(Boolean)) await attempt(() => checked('docker', ['rm', '-f', id]));
    await attempt(async () => pool?.end());
    await attempt(async () => database?.stop());
    if (networkCreated) await attempt(() => checked('docker', ['network', 'rm', network]));
    if (imageId) await attempt(async () => {
      const actual = await checked('docker', ['image', 'inspect', '--format', '{{.Id}} {{index .Config.Labels "cauce.e2e.owner"}}', imageTag]);
      if (actual !== `${imageId} ${RELEASE_OWNER}`) throw new Error('owned release image changed identity');
      await checked('docker', ['image', 'rm', imageTag]);
    });
    await attempt(() => rm(directory, { recursive: true, force: true }));
    await receipt('cleanup', { completed: errors.length === 0, errors: errors.length, postgres: database?.getId() ?? null,
      network, image: imageId, compose_project: `${project}-plataforma` });
    if (errors.length) throw new AggregateError(errors, 'owned release cleanup incomplete');
  };
  try {
    const build = join(directory, 'build'); await mkdir(build);
    const snapshot = await snapshotBuildContext(build);
    const latest = (await checked('git', ['ls-files', 'packages/store/migrations/*.sql'])).split('\n').filter(path => !path.includes('/down/')).sort().at(-1)?.split('/').at(-1);
    if (!latest) throw new Error('release schema compatibility marker is unavailable');
    const built = await releaseCommand('docker', ['build', '--target', 'runtime', '--label', `cauce.e2e.owner=${RELEASE_OWNER}`,
      '--build-arg', `CAUCE_RELEASE_COMMIT=${snapshot.revision}`, '--build-arg', `CAUCE_SOURCE_DIGEST=${snapshot.digest}`,
      '--build-arg', `CAUCE_SCHEMA_COMPATIBLE_THROUGH=${latest}`, '-t', imageTag, '-f', join(build, 'deploy/Dockerfile'), build], { timeout: 1_200_000 });
    await writeFile(join(receipts, 'release-build.log'), built.stdout + built.stderr, { mode: 0o600 });
    if (built.code !== 0) throw new Error('official release runtime build failed; see release-build.log');
    imageId = await checked('docker', ['image', 'inspect', '--format', '{{.Id}}', imageTag]);
    await receipt('image', { image: imageId, tag: imageTag, dockerfile: 'deploy/Dockerfile', target: 'runtime', snapshot });
    await checked('docker', ['network', 'create', '--label', `cauce.e2e.owner=${RELEASE_OWNER}`, network]); networkCreated = true;
    const tls = await certificates(directory);
    const passwordFile = join(directory, 'postgres-password'); await writeFile(passwordFile, password, { mode: 0o600 });
    database = await arrancarPostgresDePrueba(() => new GenericContainer('postgres:16-alpine')
      .withName(`${prefix}-postgres`).withLabels({ 'cauce.e2e.owner': RELEASE_OWNER }).withNetworkMode(network).withNetworkAliases('postgres')
      .withEntrypoint(['/opt/cauce/postgres-tls-entrypoint.sh'])
      .withCommand([...COMANDO_POSTGRES_DE_PRUEBA, '-c', 'ssl=on', '-c', 'ssl_cert_file=/run/cauce-pg/server.crt',
        '-c', 'ssl_key_file=/run/cauce-pg/server.key', '-c', 'ssl_ca_file=/run/cauce-pg/ca.crt', '-c', 'log_connections=on'])
      .withEnvironment({ POSTGRES_DB: 'cauce_test_release', POSTGRES_USER: 'cauce_test', POSTGRES_PASSWORD_FILE: '/run/secrets/postgres_password' })
      .withCopyFilesToContainer([
        { source: join(root, 'deploy/postgres/postgres-tls-entrypoint.sh'), target: '/opt/cauce/postgres-tls-entrypoint.sh', mode: 0o555 },
        ...[[passwordFile, 'postgres_password'], [tls.authority, 'postgres_ca'], [tls.certificate, 'postgres_server_cert'], [tls.key, 'postgres_server_key']]
          .map(([source, name]) => ({ source: source ?? '', target: `/run/secrets/${name ?? ''}`, mode: 0o600 })),
      ]).withExposedPorts(5432).withHealthCheck(saludDePostgresDePrueba('cauce_test', 'cauce_test_release'))
      .withWaitStrategy(Wait.forHealthCheck()).start());
    const localUrl = `postgresql://cauce_test:${encodeURIComponent(password)}@${database.getHost()}:${String(database.getMappedPort(5432))}/cauce_test_release`;
    pool = createPool(localUrl); await applyMigrations(pool); await seedSyntheticCompanyContexts(localUrl);
    const privateUrl = `postgresql://cauce_test:${encodeURIComponent(password)}@postgres:5432/cauce_test_release`;
    secrets.push(localUrl, privateUrl);
    const urlFile = join(directory, 'database-url'); await writeFile(urlFile, `${privateUrl}\n`, { mode: 0o600 });
    const settings = async (name: string, ca: string) => {
      const path = join(directory, name);
      await writeFile(path, [`COMPOSE_PROJECT_NAME=${project}`, `CAUCE_RUNTIME_IMAGE=${imageId}`, `CAUCE_DATABASE_URL_SECRET_PATH=${urlFile}`,
        `CAUCE_POSTGRES_CA_PATH=${ca}`, ''].join('\n'), { mode: 0o600 });
      return path;
    };
    const goodSettings = await settings('settings-good.txt', tls.authority), wrongSettings = await settings('settings-wrong.txt', tls.wrong);
    const natives = join(directory, 'natives');
    const context = join(natives, 'ContextBeta/director/context'); await mkdir(context, { recursive: true });
    const marker = `RELEASE_TLS_${run.toUpperCase()}`; await writeFile(join(context, 'mission.md'), marker, { mode: 0o600 });
    const invoke = async (wrongCa = false, dryRun = false) => {
      const result = await releaseCommand('bash', [join(root, 'ops/cli/cauce'), 'platform', 'contenedor', 'contexto', 'sembrar',
        '--empresa', 'context_beta', '--nativos', natives, ...(dryRun ? ['--simular'] : [])],
      { env: { CAUCE_ENV_FILE: wrongCa ? wrongSettings : goodSettings }, timeout: 180_000 });
      if (secrets.some(secret => (result.stdout + result.stderr).includes(secret))) throw new Error('container CLI exposed private fixture material');
      return result;
    };
    await receipt('resources', { postgres: database.getId(), image: imageId, network, compose_project: `${project}-plataforma`,
      scope: 'official-runtime-image; real-compose; TLS-verify-full; synthetic-owned-database' });
    const observeOneoff = async () => {
      const listing = await checked('docker', ['ps', '-q', '--filter', `label=com.docker.compose.project=${project}-plataforma`]);
      if (!listing) return undefined;
      const ids = listing.split('\n'); if (ids.length !== 1) throw new Error('owned Compose project has ambiguous running one-offs');
      const format = '{"image":{{json .Image}},"user":{{json .Config.User}},"readonly":{{json .HostConfig.ReadonlyRootfs}},'
        + '"cap_drop":{{json .HostConfig.CapDrop}},"security_opt":{{json .HostConfig.SecurityOpt}},"network":{{json .HostConfig.NetworkMode}},'
        + '"mounts":{{json .Mounts}}}';
      return JSON.parse(await checked('docker', ['inspect', '--format', format, ids[0] ?? ''])) as {
        image: string; user: string; readonly: boolean; cap_drop: string[]; security_opt: string[]; network: string;
        mounts: { Destination: string; RW: boolean }[];
      };
    };
    return { pool, invoke, observeOneoff, imageId, network, marker, receipt, receipts, postgresId: database.getId(), close };
  } catch (error) { await close(); throw error; }
}
