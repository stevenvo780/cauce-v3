import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function createComposeTestStack(sourceOps, name) {
  assert.match(name, /^[a-z0-9-]+$/u);
  const project = `cauce-ops-${name}-${randomUUID().replaceAll('-', '')}`;
  const temporary = await mkdtemp(path.join(os.tmpdir(), `${project}-`));
  const ops = path.join(temporary, 'ops');
  const env = { ...process.env, COMPOSE_PROJECT_NAME: project, CAUCE_TEST_GATEWAY_PORT: '0', COMPOSE_DISABLE_ENV_FILE: '1' };
  for (const key of ['COMPOSE_FILE', 'COMPOSE_PATH_SEPARATOR', 'COMPOSE_ENV_FILES', 'COMPOSE_PROFILES']) delete env[key];
  function docker(args) {
    const result = spawnSync('docker', args, { env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.error?.message ?? result.stderr}`);
    return result.stdout.trim();
  }
  try {
    const config = JSON.parse(docker(['compose', '-f', path.join(sourceOps, 'compose.test.yaml'), 'config', '--format', 'json']));
    assert.equal(config.name, project);
    const sourceRoot = path.dirname(sourceOps);
    const digest = spawnSync('python3', [path.join(sourceOps, 'scripts/source-digest.py'), '--domain', 'runtime'],
      { cwd: sourceRoot, encoding: 'utf8', timeout: 30_000 });
    assert.equal(digest.status, 0, digest.stderr);
    const harnessDigest = spawnSync('python3', ['-c', [
      'import pathlib, sys',
      'root = pathlib.Path(sys.argv[1])',
      "sys.path.insert(0, str(root / 'ops/scripts'))",
      'from digest_lib import fold_digest, tracked_files',
      "files = tracked_files(root, ['ops/harness'])",
      'assert all(not path.is_symlink() for path in files)',
      'print(fold_digest((path.relative_to(root).as_posix(), path) for path in files))',
    ].join('\n'), sourceRoot], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(harnessDigest.status, 0, harnessDigest.stderr);
    const schema = (await readdir(path.join(sourceRoot, 'packages/store/migrations'))).filter(file => file.endsWith('.sql')).sort().at(-1);
    const identities = new Map();
    for (const service of Object.values(config.services)) {
      const runtime = service.image === 'cauce-v3-test-runtime:local';
      const qa = service.image === 'cauce-v3-test-qa:local';
      const image = runtime ? env.CAUCE_OPS_TEST_RUNTIME_IMAGE ?? service.image
        : qa ? env.CAUCE_OPS_TEST_QA_IMAGE ?? service.image : service.image;
      if (!identities.has(image)) {
        const format = runtime || qa
          ? '{{.Id}}|{{index .Config.Labels "io.cauce.source.digest"}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "io.cauce.schema.compatible-through"}}|{{index .Config.Labels "io.cauce.qa-harness.digest"}}'
          : '{{.Id}}';
        const fields = docker(['image', 'inspect', image, '--format', format]);
        identities.set(image, fields.split('|'));
      }
      const [id, sourceDigest, imageRevision, imageSchema, imageHarnessDigest] = identities.get(image);
      assert.match(id, /^sha256:[a-f0-9]{64}$/u);
      if (runtime || qa) {
        assert.equal(sourceDigest, digest.stdout.trim(), `${image}: runtime source digest differs from this checkout`);
        assert.match(imageRevision, /^[a-f0-9]{40}$/u, `${image}: release revision is not traceable`);
        assert.equal(imageSchema, schema, `${image}: schema compatibility differs from this checkout`);
        if (qa) assert.equal(imageHarnessDigest, harnessDigest.stdout.trim(), `${image}: QA harness source differs from this checkout`);
      }
      service.image = id;
      service.pull_policy = 'never';
      service.mem_limit = '512m';
      service.cpus = 0.5;
      delete service.build;
    }
    for (const relative of ['scripts/compose.sh', 'scripts/compose-files.sh', 'cli/cauce', 'tests/cauce-pila-test.cli.mjs']) {
      const target = path.join(ops, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(sourceOps, relative), target);
    }
    await writeFile(path.join(ops, 'compose.test.yaml'), `${JSON.stringify(config)}\n`);
    process.stdout.write(`compose fixture: project=${project} source=${digest.stdout.trim()} schema=${schema}\n`);
    function compose(args, options = {}) {
      assert.equal(env.COMPOSE_PROJECT_NAME, project);
      assert.match(project, /^cauce-ops-[a-z0-9-]+-[a-f0-9]{32}$/u);
      return spawnSync(path.join(ops, 'scripts/compose.sh'), ['test', ...args],
        { encoding: 'utf8', timeout: 60_000, ...options, env });
    }
    return {
      compose, env, project, cli: path.join(ops, 'cli/cauce'),
      async cleanup() {
        const result = compose(['down', '--volumes', '--remove-orphans']);
        try {
          assert.equal(result.status, 0, `cleanup ${project}: ${result.error?.message ?? result.stderr}`);
          assert.equal(docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]), '');
          assert.equal(docker(['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]), '');
          assert.equal(docker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]), '');
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
