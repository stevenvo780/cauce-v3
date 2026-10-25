import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startRealPtyFixture } from './real-pty-agent.fixtures.js';

const COMPUTER_DOCKERFILE = `FROM docker:29-cli AS docker
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus dbus-user-session ca-certificates \\
 && rm -rf /var/lib/apt/lists/*
COPY --from=docker /usr/local/bin/docker /usr/bin/docker
RUN useradd -m -u 1500 -s /bin/bash cauce && ln -s /usr/local/bin/python3 /usr/bin/python3
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
`;
const BOOTSTRAP = `import base64,io,json,sys,tempfile,zipfile
request=json.loads(sys.stdin.buffer.readline())
with tempfile.TemporaryDirectory(prefix='cauce-move-') as work:
 with zipfile.ZipFile(io.BytesIO(base64.b64decode(request.pop('bundle')))) as archive: archive.extractall(work)
 sys.path.insert(0,work)
 from v4_mover_host import dispatch
 dispatch(request)
`;

function command(file: string, args: string[], input = '', timeout = 180_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${file} exceeded its deadline`)); }, timeout);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (value: Buffer) => { stdout += value.toString(); });
    child.stderr.on('data', (value: Buffer) => { stderr = `${stderr}${value.toString()}`.slice(-4000); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${file} exited ${String(code)}: ${stderr.replace(/-----BEGIN[\s\S]*/u, '[redacted]')}`));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

it('moves a real relay identity between managers, preserves modes and rolls back without duplicate agents', async () => {
  const owner = `h7-pty-${randomUUID().slice(0, 8)}`;
  const prefix = `zz-canary-${owner}`;
  const owned: string[] = [];
  const volumes: string[] = [];
  const computerImage = `${prefix}:computer`;
  let computerBuilt = false;
  const fixture = await startRealPtyFixture({ owner, resourcePrefix: prefix });
  const docker = (args: string[], input = '') => command('docker', args, input);
  const onManager = (name: string, args: string[], input = '') => docker(['exec', '-i', name, ...args], input);
  try {
    await docker(['build', '--label', `cauce.e2e.owner=${owner}`, '-t', computerImage, '-'], COMPUTER_DOCKERFILE);
    computerBuilt = true;
    const bundle = (await command('python3', ['-I', '-B', '-c',
      "import sys;sys.path.insert(0,'ops/scripts');from v4_mover_host import bundle;print(bundle())"])).trim();
    const managers = [`${prefix}-source`, `${prefix}-destination`];
    for (const manager of managers) {
      owned.push(manager);
      await docker(['run', '-d', '--name', manager, '--label', `cauce.e2e.owner=${owner}`, '--privileged', '--cgroupns=private',
        '--network', 'host', '--tmpfs', '/run', '--tmpfs', '/run/lock', '-v', '/var/run/docker.sock:/var/run/docker.sock', computerImage]);
      await onManager(manager, ['systemctl', 'is-system-running', '--wait']).catch(() => undefined);
      await onManager(manager, ['mkdir', '-p', '/var/log/journal']);
      await onManager(manager, ['systemd-tmpfiles', '--create', '--prefix', '/var/log/journal']);
      await onManager(manager, ['systemctl', 'restart', 'systemd-journald']);
      await onManager(manager, ['journalctl', '--flush']);
      const group = (await onManager(manager, ['stat', '-c', '%g', '/var/run/docker.sock'])).trim();
      await onManager(manager, ['groupadd', '-o', '-g', group, 'h7-docker']);
      await onManager(manager, ['usermod', '-aG', 'h7-docker', 'cauce']);
      await onManager(manager, ['loginctl', 'enable-linger', 'cauce']);
      await onManager(manager, ['systemctl', 'start', 'user@1500.service']);
    }
    const source = managers[0]; const destination = managers[1];
    if (!source || !destination) throw new Error('manager fixture missing');
    const runtimes = [`${prefix}-old`, `${prefix}-new`];
    const stateDirectory = `/home/node/.cauce/${fixture.targetAlias}`;
    for (const runtime of runtimes) {
      const volume = `${runtime}-state`;
      await docker(['volume', 'create', '--label', `cauce.e2e.owner=${owner}`, volume]);
      volumes.push(volume);
      owned.push(runtime);
      await docker(['run', '-d', '--name', runtime, '--label', `cauce.e2e.owner=${owner}`, '--network', 'host',
        '--label', `cauce.fleet.runtime_key=${fixture.targetAlias}`, '--label', `cauce.fleet.alias=${fixture.targetAlias}`,
        '--label', `cauce.fleet.tenant=${fixture.tenant}`, '--label', 'cauce.fleet.owner=cauce',
        '--label', `cauce.fleet.host=${runtime.endsWith('-old') ? 'sourcehost' : 'destinationhost'}`,
        '--mount', `type=volume,source=${volume},target=${stateDirectory}`,
        '--entrypoint', '/bin/sh', fixture.agentImage, '-c', 'sleep 600']);
      await docker(['exec', '--user', '0', runtime, 'chown', '1000:1000', stateDirectory]);
      await docker(['exec', '--user', '0', runtime, 'chmod', '0700', stateDirectory]);
    }
    const oldRuntime = runtimes[0]; const newRuntime = runtimes[1];
    if (!oldRuntime || !newRuntime) throw new Error('runtime fixture missing');
    const sourceId = (await docker(['inspect', '--format', '{{.Id}}', oldRuntime])).trim();
    const destinationId = (await docker(['inspect', '--format', '{{.Id}}', newRuntime])).trim();
    const alias = fixture.targetAlias;
    const config = { schemaVersion: 2, systemPrincipals: {}, historicalAliases: {}, aliases: { [alias]: {
      tenant: fixture.tenant, room: 'pty-lab', membershipRole: 'member', container: oldRuntime, user: 'node', home: '/home/node',
      stateDirectory: `/home/node/.cauce/${alias}`, harness: 'codex', systemdUser: 'cauce', dockerHost: 'sourcehost',
    } } };
    const placement = (container: string, host: string) => ({ mode: 'container', container_name: container, host_id: host,
      runtime_user: 'node', home_directory: '/home/node', state_directory: `/home/node/.cauce/${alias}`, systemd_user: 'cauce' });
    const common: Record<string, unknown> = { alias, tenant: fixture.tenant, runtime_key: alias, migration_id: owner, config,
      source: { systemd_user: 'cauce', container_id: sourceId }, placement: placement(newRuntime, 'destinationhost') };
    const call = async (manager: string, action: string, override: Record<string, unknown> = {}, input = '') => {
      const output = await onManager(manager, ['python3', '-I', '-B', '-c', BOOTSTRAP],
        `${JSON.stringify({ ...common, ...override, action: `terminal-${action}`, bundle })}\n${input}`);
      return action === 'export' ? output : JSON.parse(output) as Record<string, unknown>;
    };
    const credentials = JSON.parse(await readFile(join(fixture.directory, 'agent-bundle.json'), 'utf8')) as {
      client_cert_pem: string; client_key_pem: string; ca_pem: string; alias_key_hex: string;
    };
    const material = { 'client.crt': credentials.client_cert_pem, 'client.key': credentials.client_key_pem,
      'ca.crt': credentials.ca_pem, 'alias-key.hex': credentials.alias_key_hex };
    const payload = JSON.stringify({ relay: { RELAY_HOST: '127.0.0.1', RELAY_PORT: String(fixture.relayPorts.agent), RELAY_SERVER_NAME: 'localhost' },
      material: Object.fromEntries(Object.entries(material).map(([name, value]) => [name, Buffer.from(value).toString('base64')])) });
    await docker(['exec', '--user', 'node', fixture.agentContainer, 'python3', '-c',
      "import os,signal;[(os.kill(int(p),signal.SIGTERM)) for p in os.listdir('/proc') if p.isdigit() and int(p)!=os.getpid() and b'cauce_pty_agent' in open('/proc/'+p+'/cmdline','rb').read()]"]);
    await fixture.database.pool.query('UPDATE agents SET container_name=$3 WHERE tenant_id=$1 AND alias=$2', [fixture.tenant, alias, sourceId]);
    await call(source, 'install', { placement: placement(oldRuntime, 'sourcehost'), migration_id: `${owner}-seed` }, payload);
    const profileUnit = `cauce-v3-profile-expectation@${alias}.service`;
    await onManager(source, ['env', `UNIT=${profileUnit}`, 'python3', '-c',
      "import os,pathlib;p=pathlib.Path('/home/cauce/.config/systemd/user')/os.environ['UNIT'];p.write_text('[Service]\\nExecStart=/bin/sleep infinity\\n[Install]\\nWantedBy=default.target\\n');os.chown(p,1500,1500)"]);
    const managerSystemctl = (manager: string, args: string[]) => onManager(manager,
      ['runuser', '-u', 'cauce', '--', 'env', 'XDG_RUNTIME_DIR=/run/user/1500', 'systemctl', '--user', ...args]);
    await managerSystemctl(source, ['daemon-reload']);
    await managerSystemctl(source, ['enable', '--now', profileUnit]);
    const snapshot = await call(source, 'preflight');
    common.terminal_source = snapshot;
    await call(destination, 'destination-preflight');
    await call(source, 'stop');
    expect((await managerSystemctl(source, ['show', '--property=ActiveState', '--value', `cauce-v3-pty@${alias}.service`])).trim()).toBe('inactive');
    expect((await managerSystemctl(source, ['show', '--property=UnitFileState', '--value', profileUnit])).trim()).toBe('disabled');
    const transfer = await call(source, 'export');
    if (typeof transfer !== 'string') throw new Error('private transfer missing');
    await fixture.database.pool.query('UPDATE agents SET container_name=$3 WHERE tenant_id=$1 AND alias=$2', [fixture.tenant, alias, destinationId]);
    const installed = await call(destination, 'install', {}, transfer);
    expect(typeof installed === 'object' && installed.verified).toBe(true);
    const unchanged = await call(destination, 'install', {}, transfer);
    expect(typeof unchanged === 'object' && unchanged.pty).toMatchObject({ status: 'unchanged' });
    const modes = await onManager(destination, ['stat', '-c', '%a', `/home/cauce/.config/cauce-v3/pty-pki/${alias}/client.key`,
      `/home/cauce/.config/cauce-v3/pty-pki/${alias}/alias-key.hex`]);
    expect(modes.trim().split('\n')).toEqual(['600', '400']);
    const session = await fixture.login();
    await fixture.waitForTarget(session.cookie);
    const targets = await fixture.request('/v3/console/terminal/targets', { headers: { cookie: session.cookie } });
    expect(targets.body).toContain(destinationId);
    expect(fixture.relayLog()).not.toContain('duplicate agent');
    const requestId = randomUUID(); const ownerToken = randomUUID();
    const opened = await fixture.request('/v3/console/terminal/sessions', { method: 'POST',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, origin: fixture.gatewayUrl },
      body: { tenant_id: fixture.tenant, alias, mode: 'shell', cols: 100, rows: 30, request_id: requestId, owner_token: ownerToken } });
    expect(opened.status).toBe(201);
    const admission = JSON.parse(opened.body) as {
      session_id: string; ticket: string; authority_proof: string; owner_generation: string;
    };
    const socket = await fixture.connect(admission.ticket, admission.session_id, admission.authority_proof, 100, 30);
    await socket.waitControl(frame => frame.type === 'ready');
    const nonce = `PTY_MOVE_${randomUUID()}`;
    await docker(['exec', '-i', '--user', 'node', newRuntime, 'python3', '-c',
      "import pathlib,sys;pathlib.Path('/tmp/pty-move-destination').write_text(sys.stdin.read())"], `${nonce}\n`);
    socket.socket.send(JSON.stringify({ type: 'input', data: 'cat /tmp/pty-move-destination; id -u\n' }));
    await socket.waitOutput(output => output.includes(nonce) && /\b1000\b/u.test(output));
    const closed = await fixture.request(`/v3/console/terminal/sessions/${admission.session_id}`, { method: 'DELETE',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, origin: fixture.gatewayUrl },
      body: { request_id: requestId, owner_token: ownerToken, owner_generation: admission.owner_generation } });
    expect(closed.status).toBe(204);
    await socket.waitForClose();
    await call(destination, 'cleanup');
    await call(destination, 'cleanup');
    await fixture.database.pool.query('UPDATE agents SET container_name=$3 WHERE tenant_id=$1 AND alias=$2', [fixture.tenant, alias, sourceId]);
    await call(source, 'start');
    expect((await managerSystemctl(source, ['show', '--property=ActiveState', '--value', profileUnit])).trim()).toBe('active');
    expect((await managerSystemctl(source, ['show', '--property=UnitFileState', '--value', `cauce-v3-pty@${alias}.service`])).trim()).toBe('enabled');
    expect((await onManager(destination, ['python3', '-c',
      `import pathlib;h=pathlib.Path('/home/cauce');print(any(p.exists() for p in [h/'.config/cauce-v3/pty/${alias}.env',h/'.config/cauce-v3/pty-pki/${alias}',h/'.config/cauce-v3/pty/${alias}.migration.json']))`])).trim()).toBe('False');
    process.stdout.write('terminal-migration-e2e: real source fence, destination relay and WebSocket shell nonce, idempotence and rollback PASS\n');
  } catch (error) {
    for (const manager of owned.filter(name => name.endsWith('-source') || name.endsWith('-destination'))) {
      const journal = await onManager(manager, ['journalctl', '--no-pager', '-o', 'cat', '-n', '100',
        `_SYSTEMD_USER_UNIT=cauce-v3-pty@${fixture.targetAlias}.service`]).catch(() => 'journal unavailable');
      process.stdout.write(`terminal-migration-manager ${manager}:\n${journal}\n`);
    }
    throw error;
  } finally {
    for (const name of owned.reverse()) await docker(['rm', '-f', name]);
    for (const volume of volumes) await docker(['volume', 'rm', volume]);
    if (computerBuilt) await docker(['image', 'rm', computerImage]);
    await fixture.close();
    expect((await docker(['ps', '-aq', '--filter', `label=cauce.e2e.owner=${owner}`])).trim()).toBe('');
    expect((await docker(['volume', 'ls', '-q', '--filter', `label=cauce.e2e.owner=${owner}`])).trim()).toBe('');
  }
}, 10 * 60_000);
