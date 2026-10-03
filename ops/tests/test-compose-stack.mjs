import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const selectors = [
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_TLS',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
  'DOCKER_API_VERSION',
  'COMPOSE_FILE',
  'COMPOSE_PATH_SEPARATOR',
  'COMPOSE_ENV_FILES',
  'COMPOSE_PROFILES',
];

export function testComposeEnvironment(sourceEnvironment, projectName) {
  for (const selector of selectors) {
    if (sourceEnvironment[selector]) {
      throw new Error(`Compose test refuses inherited selector ${selector}`);
    }
  }
  return {
    ...sourceEnvironment,
    COMPOSE_DISABLE_ENV_FILE: '1',
    COMPOSE_PROJECT_NAME: projectName,
  };
}

export async function createTestComposeStack(sourceEnvironment = process.env) {
  const startedAt = new Date().toISOString();
  const projectName = `cauce-test-${process.pid}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const environment = testComposeEnvironment(sourceEnvironment, projectName);
  const selectedContext = spawnSync('docker', ['context', 'show'], {
    encoding: 'utf8', env: environment, timeout: 10_000,
  });
  if (selectedContext.error || selectedContext.status !== 0) {
    throw new Error(`no se pudo comprobar el contexto Docker local: ${selectedContext.error?.message ?? selectedContext.stderr}`);
  }
  const contextName = selectedContext.stdout.trim();
  if (!/^[a-zA-Z0-9_.-]+$/u.test(contextName)) {
    throw new Error(`nombre de contexto Docker no válido para la pila de pruebas: ${contextName}`);
  }
  const context = spawnSync('docker', [
    'context', 'inspect', contextName, '--format', '{{.Endpoints.docker.Host}}',
  ], { encoding: 'utf8', env: environment, timeout: 10_000 });
  if (context.error || context.status !== 0) {
    throw new Error(`no se pudo comprobar el contexto Docker local: ${context.error?.message ?? context.stderr}`);
  }
  if (!context.stdout.trim().startsWith('unix://')) {
    throw new Error(`Compose test rechaza el endpoint Docker no local: ${context.stdout.trim()}`);
  }
  environment.DOCKER_CONTEXT = contextName;
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'cauce-test-compose-'));
  const overrideFile = path.join(temporaryDirectory, 'ports.yaml');
  try {
    await writeFile(overrideFile, 'services:\n  gateway:\n    ports: !reset []\n', { mode: 0o600 });
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
  return { projectName, environment, overrideFile, temporaryDirectory, startedAt };
}

function commandFailure(result, label) {
  if (result.error) return new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) return new Error(`${label}: exit ${result.status}: ${result.stderr ?? ''}`.trim());
  return null;
}

function resourceIds(output) {
  return output.split('\n').map(value => value.trim()).filter(Boolean);
}

export async function teardownTestComposeStack(stack, { compose, docker }) {
  const failures = [];
  const resources = { containers: 0, networks: 0, volumes: 0 };
  try {
    const down = compose(['down', '--volumes', '--remove-orphans'], { timeoutMs: 120_000 });
    const failure = commandFailure(down, 'compose down del proyecto propio');
    if (failure) failures.push(failure);
  } catch (error) {
    failures.push(error);
  }

  const label = `label=com.docker.compose.project=${stack.projectName}`;
  for (const [kind, key, args] of [
    ['contenedores', 'containers', ['ps', '-aq', '--filter', label]],
    ['redes', 'networks', ['network', 'ls', '-q', '--filter', label]],
    ['volúmenes', 'volumes', ['volume', 'ls', '-q', '--filter', label]],
  ]) {
    try {
      const result = docker(args, { timeoutMs: 30_000 });
      const probeFailure = commandFailure(result, `verificar ${kind} del proyecto propio`);
      if (probeFailure) failures.push(probeFailure);
      else {
        const remaining = resourceIds(result.stdout);
        resources[key] = remaining.length;
        if (remaining.length > 0) failures.push(new Error(`${kind} residuales del proyecto ${stack.projectName}: ${remaining.join(', ')}`));
      }
    } catch (error) {
      failures.push(error);
    }
  }

  try {
    await rm(stack.temporaryDirectory, { recursive: true, force: true });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, `falló el teardown de ${stack.projectName}`);
  return resources;
}

export async function withTestComposeStack(stack, operation, teardown = teardownTestComposeStack) {
  let result;
  let operationError;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }

  let teardownError;
  try {
    await teardown(stack);
  } catch (error) {
    teardownError = error;
  }

  if (operationError && teardownError) {
    throw new AggregateError(
      [operationError, teardownError],
      `fallaron la prueba y el teardown de ${stack.projectName}`,
      { cause: operationError },
    );
  }
  if (operationError) throw operationError;
  if (teardownError) throw teardownError;
  return result;
}
