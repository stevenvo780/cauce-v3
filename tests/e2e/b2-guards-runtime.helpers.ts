import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import { browserDocker, browserErrorStderr } from './browser-owned-lifecycle.js';
import { isaTenant, type startContextFixture } from './context-multiuser-continuity.fixtures.js';
import { prepareChatRuntimeIdentity } from './chat-runtime-identity.fixtures.js';

type Fixture = Awaited<ReturnType<typeof startContextFixture>>;
async function cleanupRuntime(run: string, names: string[], image: string) {
  const errors: unknown[] = [];
  for (const name of names) {
    try {
      const owner = (await browserDocker(['inspect', '--format', '{{index .Config.Labels "cauce.e2e.owner"}}', name])).stdout.trim();
      if (owner !== run) throw new Error('owned guard container identity changed');
      await browserDocker(['rm', '-f', name], { timeout: 60_000 });
    } catch (error) { if (!browserErrorStderr(error).includes('No such')) errors.push(error); }
  }
  try {
    const owner = (await browserDocker(['image', 'inspect', '--format', '{{index .Config.Labels "cauce.e2e.owner"}}', image])).stdout.trim();
    if (owner !== run) throw new Error('owned guard image identity changed');
    await browserDocker(['image', 'rm', image], { timeout: 60_000 });
  } catch (error) { if (!browserErrorStderr(error).includes('No such')) errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'guard runtime cleanup failed');
}
export async function prepareGuardRuntime(fixture: Fixture, evidence: string) {
  if ((await browserDocker(['info', '--format', '{{.Name}}'])).stdout.trim() !== 'docker-lab') throw new Error('guards require docker-lab');
  const run = randomUUID().slice(0, 12);
  const image = `zz-canary-b2-guards:${run}`;
  const manager = `zz-canary-b2-manager-${run}`;
  const agent = `zz-canary-b2-agent-${run}`;
  const repo = process.cwd();
  try {
  const recipe = await readFile(join(repo, 'tests/e2e/lab-runner/Dockerfile'));
  const cliImage = `cauce-e2e-lab-runner:${createHash('sha256').update(recipe).digest('hex').slice(0, 12)}`;
  const build = await browserDocker(['build', '--progress=plain', '--tag', image, '--label', `cauce.e2e.owner=${run}`,
    '--build-arg', `CLI_IMAGE=${cliImage}`, '--file', join(repo, 'tests/e2e/b2-guards-runtime.Dockerfile'), join(repo, 'tests/e2e')],
  { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
  await writeFile(join(evidence, 'runtime-build.log'), build.stdout + build.stderr, { mode: 0o600 });
  const runtimeKey = await prepareChatRuntimeIdentity(fixture, isaTenant);
  const tls = fixture.pki.adapterCerts[0];
  if (!tls) throw new Error('owned adapter certificate absent');
  const environment = {
    HOME: '/home/node', NODE_ENV: 'test', CAUCE_ENVIRONMENT: 'test', CAUCE_TENANT: isaTenant.tenant,
    CAUCE_ALIAS: isaTenant.target, CAUCE_ROOM: isaTenant.room, CAUCE_INSTANCE_ID: `b2-${run}`,
    CAUCE_RUNTIME_KEY: runtimeKey, CAUCE_STATE_DIR: '/home/node/adapter-state', CAUCE_HEARTBEAT_MS: '250',
    CAUCE_RELAY_URL: `${fixture.gatewayUrl.replace('https:', 'wss:')}/v3/ws`,
    CAUCE_TLS_CERT_FILE: tls.cert, CAUCE_TLS_KEY_FILE: tls.key, CAUCE_TLS_CA_FILE: fixture.pki.ca.cert,
  };
  await browserDocker(['create', '--name', agent, '--label', `cauce.e2e.owner=${run}`, '--network', 'host',
    '--user', 'node', '--stop-signal', 'SIGTERM', '--tmpfs', '/home/node:rw,exec,uid=1000,gid=1000,mode=700', '--mount', `type=bind,src=${repo},dst=${repo},readonly`,
    '--mount', `type=bind,src=${fixture.directory},dst=${fixture.directory},readonly`,
    '--mount', `type=bind,src=${repo}/packages/adapter-sdk,dst=/opt/cauce-v3-adapter/${isaTenant.target}/releases/b2-owned/packages/adapter-sdk,readonly`,
    '--mount', `type=bind,src=${repo}/packages/protocol,dst=/opt/cauce-v3-adapter/${isaTenant.target}/releases/b2-owned/packages/protocol,readonly`,
    '--mount', `type=bind,src=${repo}/node_modules,dst=/opt/cauce-v3-adapter/${isaTenant.target}/releases/b2-owned/node_modules,readonly`,
    ...Object.entries(environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--workdir', repo,
    '--entrypoint', 'node', image, `/opt/cauce-v3-adapter/${isaTenant.target}/releases/b2-owned/packages/adapter-sdk/dist/src/bin/codex.js`]);
  await browserDocker(['run', '--detach', '--name', manager, '--label', `cauce.e2e.owner=${run}`, '--privileged', '--cgroupns=private',
    '--network', 'none', '--tmpfs', '/run', '--tmpfs', '/run/lock', '--tmpfs', '/tmp', '--tmpfs', '/home/node:rw,exec,uid=1000,gid=1000,mode=700',
    '--mount', `type=bind,src=${repo},dst=${repo},readonly`,
    '--mount', 'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock', '--env', 'container=docker', image]);
  const execute = (args: string[]) => browserDocker(['exec', manager, ...args], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  const user = (args: string[]) => execute(['runuser', '-u', 'node', '--', 'env', 'HOME=/home/node',
    'XDG_RUNTIME_DIR=/run/user/1000', 'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus', ...args]);
  await execute(['python3', join(repo, 'tests/e2e/b2-guards-runtime.setup.py'), JSON.stringify({ repo, agent, alias: isaTenant.target })]);
  await user(['systemctl', '--user', 'daemon-reload']);
  await user(['systemctl', '--user', 'start', `cauce-v3-container-${isaTenant.target}.service`]);
  await execute(['docker', 'exec', '--user', 'root', agent, 'mkdir', '-p', '/workspace']);
  await execute(['docker', 'exec', '--user', 'root', agent, 'chown', 'node:node', '/workspace']);
  await writeFile(join(evidence, 'runtime.json'), JSON.stringify({ run, image, manager, agent,
    image_id: (await browserDocker(['image', 'inspect', '--format', '{{.Id}}', image])).stdout.trim(),
    systemd: (await execute(['systemctl', '--version'])).stdout.split('\n')[0],
    tmux: (await execute(['docker', 'exec', '--user', 'node', agent, 'tmux', '-V'])).stdout.trim(),
    codex: (await execute(['docker', 'exec', '--user', 'node', agent, 'codex', '--version'])).stdout.trim(),
    daemon: 'docker-lab', provider_turn: false, base_image: 'cauce-c7-openclaw-real:2026.7.1-2', physical_session: `cauce-${runtimeKey}`,
  }, null, 2), { mode: 0o600 });
  return { run, image, manager, agent, execute, user, session: `cauce-${runtimeKey}`,
    helper: (command: string) => browserDocker(['exec', '--user', 'node', agent, 'node',
      `/opt/cauce-v3-adapter/${isaTenant.target}/releases/b2-owned/packages/adapter-sdk/dist/src/bin/shared-session.js`, command,
      '--alias', isaTenant.target, '--harness', 'codex', '--workspace', '/workspace', '--state', '/home/node/adapter-state']),
    close: () => cleanupRuntime(run, [manager, agent], image) };
  } catch (error) {
    try { await cleanupRuntime(run, [manager, agent], image); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'guard setup and cleanup failed'); }
    throw error;
  }
}

export async function fireUserTimer(runtime: Awaited<ReturnType<typeof prepareGuardRuntime>>, name: string, expectedExit = 0) {
  await runtime.user(['systemctl', '--user', 'stop', `${name}.timer`]);
  const previousTrigger = (await runtime.user(['systemctl', '--user', 'show', '--property=LastTriggerUSecMonotonic', '--value', `${name}.timer`])).stdout.trim();
  const previousStart = (await runtime.user(['systemctl', '--user', 'show', '--property=ExecMainStartTimestampMonotonic', '--value', `${name}.service`])).stdout.trim();
  await runtime.user(['systemctl', '--user', 'reset-failed']);
  await runtime.user(['systemctl', '--user', 'start', `${name}.timer`]);
  await expect.poll(async () => {
    const trigger = (await runtime.user(['systemctl', '--user', 'show', '--property=LastTriggerUSecMonotonic', '--value', `${name}.timer`])).stdout.trim();
    const service = (await runtime.user(['systemctl', '--user', 'show', '--property=ActiveState,ExecMainStartTimestampMonotonic', `${name}.service`])).stdout;
    const start = /^ExecMainStartTimestampMonotonic=(.+)$/m.exec(service)?.[1];
    const state = /^ActiveState=(.+)$/m.exec(service)?.[1];
    return trigger !== '0' && trigger !== previousTrigger && start !== undefined && start !== '0'
      && start !== previousStart && ['inactive', 'failed'].includes(state ?? '');
  }, { timeout: 180_000, interval: 250 }).toBe(true);
  const exit = (await runtime.user(['systemctl', '--user', 'show', '--property=ExecMainStatus', '--value', `${name}.service`])).stdout.trim();
  expect(exit).toBe(String(expectedExit));
}

export async function guardArtifacts(directory: string) { await mkdir(directory, { recursive: true, mode: 0o700 }); }
