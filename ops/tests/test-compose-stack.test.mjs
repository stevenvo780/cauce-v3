#!/usr/bin/env node
// cauce:requiere docker-compose
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createTestComposeStack,
  testComposeEnvironment,
  teardownTestComposeStack,
  withTestComposeStack,
} from './test-compose-stack.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const helper = path.join(here, 'test-compose-stack.mjs');
const childSource = [
  `import { createTestComposeStack } from ${JSON.stringify(helper)};`,
  'const stack = await createTestComposeStack();',
  'process.stdout.write(JSON.stringify({ projectName: stack.projectName, environment: stack.environment, overrideFile: stack.overrideFile, temporaryDirectory: stack.temporaryDirectory }));',
].join('\n');

function runContext() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) reject(new Error(stderr || `child exited ${code}`));
      else resolve(JSON.parse(stdout));
    });
  });
}

const [first, second] = await Promise.all([runContext(), runContext()]);
assert.match(first.projectName, /^cauce-test-[a-z0-9-]+$/u);
assert.match(second.projectName, /^cauce-test-[a-z0-9-]+$/u);
assert.notEqual(first.projectName, second.projectName);
assert.equal(first.environment.COMPOSE_PROJECT_NAME, first.projectName);
assert.equal(second.environment.COMPOSE_PROJECT_NAME, second.projectName);
assert.equal(first.environment.CAUCE_TEST_GATEWAY_PORT, undefined);
assert.equal(second.environment.CAUCE_TEST_GATEWAY_PORT, undefined);
assert.match(await readFile(first.overrideFile, 'utf8'), /ports:\s*!reset\s*\[\]/u);
assert.match(await readFile(second.overrideFile, 'utf8'), /ports:\s*!reset\s*\[\]/u);
const composeFile = path.resolve(here, '../compose.test.yaml');
const config = spawnSync('docker', [
  'compose', '-f', composeFile, '-f', first.overrideFile, 'config', '--format', 'json',
], { encoding: 'utf8', env: first.environment, timeout: 30_000 });
assert.equal(config.status, 0, config.stderr);
assert.equal(JSON.parse(config.stdout).services.gateway.ports, undefined, 'gateway has no host-published port');
const noResources = {
  compose: () => ({ status: 0, stdout: '', stderr: '' }),
  docker: () => ({ status: 0, stdout: '', stderr: '' }),
};
await teardownTestComposeStack(first, noResources);
await teardownTestComposeStack(second, noResources);

for (const selector of [
  'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH', 'DOCKER_API_VERSION', 'COMPOSE_FILE',
  'COMPOSE_PATH_SEPARATOR', 'COMPOSE_ENV_FILES', 'COMPOSE_PROFILES',
]) {
  assert.throws(
    () => testComposeEnvironment({ PATH: '/usr/bin', [selector]: 'inherited-selector' }, 'cauce-test-fixture'),
    new RegExp(selector, 'u'),
  );
}
assert.equal(
  testComposeEnvironment({ PATH: '/usr/bin', DOCKER_CONFIG: '/private/docker-config' }, 'cauce-test-fixed')
    .DOCKER_CONFIG,
  '/private/docker-config',
  'the selected Docker credential profile is preserved',
);

const operationError = new Error('partial up failure');
const teardownError = new Error('teardown failure');
let teardownCalled = false;
await assert.rejects(
  withTestComposeStack({ projectName: 'cauce-test-fixture' }, () => { throw operationError; }, async () => {
    teardownCalled = true;
    throw teardownError;
  }),
  error => error instanceof AggregateError
    && error.errors.includes(operationError)
    && error.errors.includes(teardownError),
);
assert.equal(teardownCalled, true, 'teardown runs after a partial startup failure');

const partialStack = await createTestComposeStack({ PATH: '/usr/bin' });
const partialCalls = [];
await assert.rejects(
  withTestComposeStack(partialStack, () => {
    const up = { status: null, error: new Error('simulated timeout after creating postgres') };
    if (up.error) throw new Error(`compose up: ${up.error.message}`);
  }, stack => teardownTestComposeStack(stack, {
    compose(args) {
      partialCalls.push(args);
      return { status: 0, stdout: '', stderr: '' };
    },
    docker: () => ({ status: 0, stdout: '', stderr: '' }),
  })),
  /simulated timeout after creating postgres/u,
);
assert.deepEqual(partialCalls, [['down', '--volumes', '--remove-orphans']]);

const teardownStack = await createTestComposeStack({ PATH: '/usr/bin' });
const composeCalls = [];
const dockerCalls = [];
await assert.rejects(
  teardownTestComposeStack(teardownStack, {
    compose(args) {
      composeCalls.push(args);
      return { status: 0, stdout: '', stderr: '' };
    },
    docker(args) {
      dockerCalls.push(args);
      return {
        status: 0,
        stdout: args.includes('network') ? 'owned-network\n' : '',
        stderr: '',
      };
    },
  }),
  /owned-network/u,
);
await assert.rejects(readFile(teardownStack.overrideFile, 'utf8'), { code: 'ENOENT' });
assert.deepEqual(composeCalls, [['down', '--volumes', '--remove-orphans']]);
assert.deepEqual(dockerCalls.map(args => args.slice(0, 2)), [['ps', '-aq'], ['network', 'ls'], ['volume', 'ls']]);
assert.ok(dockerCalls.every(args => args.some(argument => argument === `label=com.docker.compose.project=${teardownStack.projectName}`)));

const failedDownStack = await createTestComposeStack();
const probesAfterFailedDown = [];
await assert.rejects(
  teardownTestComposeStack(failedDownStack, {
    compose() { throw new Error('simulated compose down timeout'); },
    docker(args) {
      probesAfterFailedDown.push(args);
      return { status: 0, stdout: '', stderr: '' };
    },
  }),
  /simulated compose down timeout/u,
);
assert.equal(probesAfterFailedDown.length, 3, 'resource verification still runs when compose down throws');

console.log('test compose stacks ok: concurrent projects, selector policy, partial-failure teardown, and owned-resource checks');
