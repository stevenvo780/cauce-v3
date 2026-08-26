import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile,
} from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const helper = join(repository, 'ops/scripts/release-writer-state.py');
const pin = join(repository, 'ops/scripts/pin-production-release.py');
const captureWriter = join(repository, 'ops/scripts/capture-release-writer-snapshot.sh');
const scratch: string[] = [];

const digest = (content: string | Buffer): string =>
  `sha256:${createHash('sha256').update(content).digest('hex')}`;

type Fixture = {
  ops: string;
  bin: string;
  state: string;
  snapshot: string;
  envFile: string;
  env: NodeJS.ProcessEnv;
};

afterEach(async () => {
  await Promise.all(scratch.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

async function fixture(options: { remote?: boolean; includeLocalPeer?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'cauce-writer-state-'));
  scratch.push(root);
  const ops = join(root, 'ops');
  const bin = join(root, 'bin');
  const host = join(ops, 'generated/systemd');
  const system = join(ops, 'generated/container-systemd');
  const rootless = join(system, 'rootless');
  const managerHome = join(root, 'manager-home');
  const installedRootless = join(managerHome, '.config/systemd/user');
  const guardRoot = join(root, 'remote-guards');
  await Promise.all([
    mkdir(host, { recursive: true }), mkdir(system, { recursive: true }),
    mkdir(rootless, { recursive: true }), mkdir(bin, { recursive: true }),
    mkdir(installedRootless, { recursive: true }), mkdir(guardRoot, { recursive: true }),
  ]);
  const aliases = {
    ...(options.includeLocalPeer ? {
      argos: {
        tenant: 'Steven',
        room: 'grp.steven',
        container: 'ctrl-infra',
        user: 'dev',
        home: '/home/dev',
        stateDirectory: '/home/dev/.local/state/cauce-v3/argos',
        harness: 'claude',
        membershipRole: 'agent',
        systemdUser: userInfo().username,
      },
    } : {}),
    kant: {
      tenant: 'Steven',
      room: 'grp.steven',
      container: 'ctrl-infra',
      user: 'dev',
      home: '/home/dev',
      stateDirectory: '/home/dev/.local/state/cauce-v3/kant',
      harness: 'codex',
      membershipRole: 'operator',
      systemdUser: userInfo().username,
      ...(options.remote ? { dockerHost: 'kratos' } : {}),
    },
  };
  await writeFile(join(ops, 'container-aliases.json'), `${JSON.stringify({
    schemaVersion: 2,
    systemPrincipals: {},
    historicalAliases: {},
    aliases,
  })}\n`);
  const unitContent = '[Service]\nExecStart=/bin/true\n';
  for (const [directory, prefix] of [
    [host, 'cauce-v3-alias-'],
    [system, 'cauce-v3-container-'],
    [rootless, 'cauce-v3-container-'],
  ] as const) {
    const checksums: string[] = [];
    for (const alias of Object.keys(aliases).sort()) {
      const name = `${prefix}${alias}.service`;
      await writeFile(join(directory, name), unitContent);
      checksums.push(`${digest(unitContent).slice(7)}  ${name}`);
    }
    await writeFile(join(directory, 'SHA256SUMS'), `${checksums.join('\n')}\n`);
  }
  await writeFile(
    join(installedRootless, 'cauce-v3-container-kant.service'),
    unitContent,
  );
  const state = join(root, 'state.json');
  const envFile = join(root, 'prod.env');
  await writeFile(state, '{"active":true,"enabled":true,"pid":1234}\n');
  await writeFile(envFile, '# private lock authority for the fixture\n', { mode: 0o600 });
  const fakeSystemctl = join(bin, 'systemctl');
  await writeFile(fakeSystemctl, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(state)};
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const user = args[0] === '--user';
const operation = args[user ? 1 : 0];
if (operation === 'show') {
  if (state.replaceGeneratedSourceOnShow && !state.generatedSourceReplaced) {
    fs.writeFileSync(${JSON.stringify(join(rootless, 'cauce-v3-container-kant.service'))}, state.replaceGeneratedSourceOnShow);
    state.generatedSourceReplaced = true;
    fs.writeFileSync(statePath, JSON.stringify(state));
  }
  if (state.replaceManifestOnShow && !state.manifestReplaced) {
    fs.writeFileSync(${JSON.stringify(join(ops, 'container-aliases.json'))}, state.replaceManifestOnShow);
    state.manifestReplaced = true;
    fs.writeFileSync(statePath, JSON.stringify(state));
  }
  const units = args.slice(args.findIndex((item) => item.startsWith('--property=')) + 1);
  for (const name of units) {
    const rootlessUnit = name === 'cauce-v3-container-kant.service';
    const active = rootlessUnit && user && state.active;
    const activeState = rootlessUnit && user && state.activeState
      ? state.activeState : (active ? 'active' : 'inactive');
    const fragment = rootlessUnit && user
      ? (state.fragmentPath || ${JSON.stringify(join(installedRootless, 'cauce-v3-container-kant.service'))}) : '';
    process.stdout.write([
      'Id=' + name,
      'LoadState=' + (fragment ? 'loaded' : 'not-found'),
      'UnitFileState=' + (fragment
        ? (state.unitFileState || (state.enabled ? 'enabled' : 'disabled')) : 'not-found'),
      'ActiveState=' + activeState,
      'SubState=' + (state.subState || (active ? 'running' : 'dead')),
      'MainPID=' + (activeState === 'active' ? state.pid : 0),
      'FragmentPath=' + fragment,
      'DropInPaths=',
      'NeedDaemonReload=no',
      '',
      '',
    ].join('\\n'));
  }
  process.exit(0);
}
if (operation === 'disable' && args.includes('--now')) {
  state.disableCalled = true;
  state.enabled = false;
  if (state.failFenceAfterDisableBeforeStop) {
    fs.writeFileSync(statePath, JSON.stringify(state));
    process.exit(20);
  }
  state.active = false;
  state.pid = 0;
  fs.writeFileSync(statePath, JSON.stringify(state));
  process.exit(state.lostFenceResponse ? 20 : 0);
}
if (operation === 'enable') {
  if (state.failEnableBeforeMutation) process.exit(18);
  state.enabled = true;
  fs.writeFileSync(statePath, JSON.stringify(state));
  process.exit(state.lostRestoreResponse ? 18 : 0);
}
if (operation === 'start') {
  state.active = true;
  state.pid = 4567;
  fs.writeFileSync(statePath, JSON.stringify(state));
  process.exit(state.lostStartResponse ? 18 : 0);
}
process.exit(19);
`);
  await chmod(fakeSystemctl, 0o755);
  if (options.remote) {
    const fakeSsh = join(bin, 'ssh');
    await writeFile(fakeSsh, `#!/bin/sh
set -eu
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift 2 ;;
    --) shift; break ;;
    *) exit 91 ;;
  esac
done
[ "$#" -gt 0 ] || exit 92
[ "$1" = "$FAKE_SSH_DESTINATION" ] || exit 93
shift
[ "\${FAKE_SSH_UNREACHABLE:-0}" != 1 ] || exit 255
if [ "\${FAKE_SSH_LOSE_GUARD:-0}" = 1 ] && [ "$#" -eq 1 ]; then
  case "$1" in
    *CAUCE_WRITER_REMOTE_GUARD_READY*)
      /bin/sh -c "$1" & child=$!
      /bin/sleep 0.2
      kill "$child" 2>/dev/null || true
      wait "$child" 2>/dev/null || true
      exit 24 ;;
  esac
fi
if [ "$#" -eq 1 ]; then /bin/sh -c "$1"; exit $?; fi
exec "$@"
`);
    await chmod(fakeSsh, 0o755);
  }
  return {
    ops,
    bin,
    state,
    snapshot: join(root, 'writer-snapshot.json'),
    envFile,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      CAUCE_WRITER_TEST_MODE: '1',
      CAUCE_WRITER_TEST_SYSTEMCTL: fakeSystemctl,
      CAUCE_WRITER_TEST_ACCOUNT_UID: String(process.getuid?.() ?? 0),
      CAUCE_WRITER_TEST_ACCOUNT_HOME: managerHome,
      CAUCE_WRITER_TEST_GUARD_ROOT: guardRoot,
      FAKE_WRITER_STATE: state,
      ...(options.remote ? {
        FAKE_SSH_DESTINATION: `${userInfo().username}@kratos`,
        CAUCE_WRITER_TEST_SSH: join(bin, 'ssh'),
      } : {}),
      CAUCE_ENV_FILE: envFile,
    },
  };
}

function run(value: Fixture, args: string[], input?: string) {
  return spawnSync('python3', [helper, '--ops-root', value.ops, ...args], {
    encoding: 'utf8', env: value.env, input,
  });
}

function runMutating(value: Fixture, args: string[], input?: string) {
  return spawnSync('python3', [
    pin, 'locked-exec', '--env-file', value.envFile, '--',
    'python3', helper, '--ops-root', value.ops, ...args,
  ], { encoding: 'utf8', env: value.env, input });
}

function guardedArguments(value: Fixture, args: string[]): string[] {
  return [
    pin, 'locked-exec', '--env-file', value.envFile, '--',
    'python3', helper, '--ops-root', value.ops, 'guarded-exec', '--',
    '/usr/bin/python3', helper, '--ops-root', value.ops, ...args,
  ];
}

function runGuardedMutating(value: Fixture, args: string[], input?: string) {
  return spawnSync('python3', guardedArguments(value, args), {
    encoding: 'utf8', env: value.env, input,
  });
}

const fleet = (active: boolean, extra: object[] = []): string => JSON.stringify({
  schemaVersion: 3,
  leases: [{ tenant_id: 'Steven', alias: 'kant', active }, ...extra],
});

describe('durable release writer state', () => {
  test('captures, content-addresses, fences and exactly restores canonical units and leases', async () => {
    const value = await fixture();
    const captured = run(value, ['capture', '--compose-writer', 'relay-worker'], fleet(true));
    expect(captured.status, captured.stderr).toBe(0);
    const content = captured.stdout;
    const published = runMutating(value, ['publish', '--path', value.snapshot], content);
    expect(published.status, published.stderr).toBe(0);
    const snapshotSha = published.stdout.trim();
    expect(snapshotSha).toBe(digest(content));
    expect((await stat(value.snapshot)).mode & 0o777).toBe(0o600);

    const checkCaptured = run(value, [
      'check', '--snapshot', value.snapshot, '--expected-sha256', snapshotSha,
      '--mode', 'captured', '--fleet-stdin', '--compose-writer', 'relay-worker',
    ], fleet(true));
    expect(checkCaptured.status, checkCaptured.stderr).toBe(0);

    await writeFile(value.state, '{"active":true,"enabled":true,"pid":1234,"lostFenceResponse":true}\n');
    const fencedResponse = runMutating(value, [
      'fence', '--snapshot', value.snapshot, '--expected-sha256', snapshotSha,
    ]);
    expect(fencedResponse.status).toBe(1);
    const fenced = run(value, [
      'check', '--snapshot', value.snapshot, '--expected-sha256', snapshotSha,
      '--mode', 'fenced', '--fleet-stdin', '--compose-writer', 'relay-worker',
    ], fleet(false));
    expect(fenced.status, fenced.stderr).toBe(0);

    await writeFile(value.state, '{"active":false,"enabled":false,"pid":0,"lostStartResponse":true}\n');
    const restoredResponse = runMutating(value, [
      'restore', '--snapshot', value.snapshot, '--expected-sha256', snapshotSha,
    ]);
    expect(restoredResponse.status).toBe(1);
    const restored = run(value, [
      'check', '--snapshot', value.snapshot, '--expected-sha256', snapshotSha,
      '--mode', 'restored', '--fleet-stdin', '--compose-writer', 'relay-worker',
    ], fleet(true));
    expect(restored.status, restored.stderr).toBe(0);
  });

  test('captures, fences and restores a rootless writer through its declared remote host', async () => {
    const value = await fixture({ remote: true });
    const captured = run(value, ['capture', '--compose-writer', 'relay-worker'], fleet(true));
    expect(captured.status, captured.stderr).toBe(0);
    const document = JSON.parse(captured.stdout) as {
      schemaVersion: number;
      aliases: { host: string; systemdUser: string }[];
    };
    expect(document.schemaVersion).toBe(2);
    expect(document.aliases).toEqual([
      expect.objectContaining({ host: 'kratos', systemdUser: userInfo().username }),
    ]);
    const published = runMutating(value, ['publish', '--path', value.snapshot], captured.stdout);
    expect(published.status, published.stderr).toBe(0);
    const snapshotSha = published.stdout.trim();

    await writeFile(value.state,
      '{"active":true,"enabled":true,"pid":1234,"lostFenceResponse":true}\n');
    expect(runGuardedMutating(value, [
      'fence', '--snapshot', value.snapshot, '--expected-sha256', snapshotSha,
    ]).status).toBe(1);
    const fencedCheck = runGuardedMutating(value, [
      'check', '--snapshot', value.snapshot, '--expected-sha256', snapshotSha,
      '--mode', 'fenced', '--fleet-stdin', '--compose-writer', 'relay-worker',
    ], fleet(false));
    expect(fencedCheck.status, fencedCheck.stderr).toBe(0);

    await writeFile(value.state,
      '{"active":false,"enabled":false,"pid":0,"lostStartResponse":true}\n');
    expect(runGuardedMutating(value, [
      'restore', '--snapshot', value.snapshot, '--expected-sha256', snapshotSha,
    ]).status).toBe(1);
    const restoredCheck = runGuardedMutating(value, [
      'check', '--snapshot', value.snapshot, '--expected-sha256', snapshotSha,
      '--mode', 'restored', '--fleet-stdin', '--compose-writer', 'relay-worker',
    ], fleet(true));
    expect(restoredCheck.status, restoredCheck.stderr).toBe(0);
  });

  test('holds a remote manager lock for an entire authenticated child transaction', async () => {
    const value = await fixture({ remote: true });
    const guarded = runMutating(value, ['guarded-exec', '--', '/bin/true']);
    expect(guarded.status, guarded.stderr).toBe(0);
    const lock = join(
      dirname(value.state), 'remote-guards',
      `kratos-${userInfo().username}`, 'release-writer-transition.lock',
    );
    expect((await stat(lock)).mode & 0o777).toBe(0o600);
  });

  test('serializes controllers with independent local locks on the same remote manager', async () => {
    const value = await fixture({ remote: true });
    const otherEnvFile = join(dirname(value.state), 'other-prod.env');
    const marker = join(dirname(value.state), 'guarded-child-started');
    await writeFile(otherEnvFile, '# independent controller lock authority\n', { mode: 0o600 });
    const firstArgs = [
      pin, 'locked-exec', '--env-file', value.envFile, '--',
      'python3', helper, '--ops-root', value.ops, 'guarded-exec', '--',
      '/usr/bin/python3', '-c',
      `import pathlib,time; pathlib.Path(${JSON.stringify(marker)}).write_text('ready'); time.sleep(2)`,
    ];
    const first = spawn('python3', firstArgs, { env: value.env, stdio: ['ignore', 'pipe', 'pipe'] });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await stat(marker);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    await stat(marker);
    const second = spawnSync('python3', [
      pin, 'locked-exec', '--env-file', otherEnvFile, '--',
      'python3', helper, '--ops-root', value.ops, 'guarded-exec', '--', '/bin/true',
    ], { encoding: 'utf8', env: { ...value.env, CAUCE_ENV_FILE: otherEnvFile } });
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('could not acquire its transition lock');
    const firstExit = await new Promise<number | null>((resolveExit) => {
      first.once('close', (code) => resolveExit(code));
    });
    expect(firstExit).toBe(0);
  }, 10_000);

  test('terminates the guarded child when a remote guard session is lost', async () => {
    const value = await fixture({ remote: true });
    value.env.FAKE_SSH_LOSE_GUARD = '1';
    const result = runMutating(value, [
      'guarded-exec', '--', '/usr/bin/python3', '-c', 'import time; time.sleep(5)',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('remote writer guard was lost during the release transition');
  }, 10_000);

  test('rejects a forged local pipe in place of the canonical SSH guard set', async () => {
    const value = await fixture({ remote: true });
    const captured = run(value, ['capture'], fleet(true));
    expect(captured.status, captured.stderr).toBe(0);
    const published = runMutating(value, ['publish', '--path', value.snapshot], captured.stdout);
    expect(published.status, published.stderr).toBe(0);
    const managersSha = digest(JSON.stringify([['kratos', userInfo().username]]));
    const probe = [
      'import os,subprocess,sys',
      'read_fd,write_fd=os.pipe()',
      'env=os.environ.copy()',
      `env['CAUCE_WRITER_REMOTE_GUARD_FD']=str(read_fd)`,
      `env['CAUCE_WRITER_REMOTE_GUARD_MANAGERS_SHA256']=${JSON.stringify(managersSha)}`,
      `env['CAUCE_WRITER_REMOTE_GUARDS']='[]'`,
      `command=['/usr/bin/python3',${JSON.stringify(helper)},'--ops-root',${JSON.stringify(value.ops)},'check','--snapshot',${JSON.stringify(value.snapshot)},'--expected-sha256',${JSON.stringify(published.stdout.trim())},'--mode','fenced']`,
      `status=subprocess.run(command,env=env,pass_fds=(int(env['CAUCE_RELEASE_TRANSITION_LOCK_FD']),read_fd)).returncode`,
      'os.close(read_fd); os.close(write_fd); raise SystemExit(status)',
    ].join(';');
    const forged = spawnSync('python3', [
      pin, 'locked-exec', '--env-file', value.envFile, '--',
      '/usr/bin/python3', '-c', probe,
    ], { encoding: 'utf8', env: value.env });
    expect(forged.status).toBe(1);
    expect(forged.stderr).toContain('remote guard set is invalid');
  });

  test('rejects tampered remote guard process identity inside a real guarded transaction', async () => {
    const value = await fixture({ remote: true });
    const captured = run(value, ['capture'], fleet(true));
    const published = runMutating(value, ['publish', '--path', value.snapshot], captured.stdout);
    expect(published.status, published.stderr).toBe(0);
    const probe = [
      'import json,os,subprocess',
      `rows=json.loads(os.environ['CAUCE_WRITER_REMOTE_GUARDS'])`,
      `rows[0]['startTime']+=1`,
      `env=os.environ.copy()`,
      `env['CAUCE_WRITER_REMOTE_GUARDS']=json.dumps(rows,separators=(',',':'),sort_keys=True)`,
      `fds=[int(env['CAUCE_RELEASE_TRANSITION_LOCK_FD']),*[int(row['fd']) for row in rows]]`,
      `command=['/usr/bin/python3',${JSON.stringify(helper)},'--ops-root',${JSON.stringify(value.ops)},'check','--snapshot',${JSON.stringify(value.snapshot)},'--expected-sha256',${JSON.stringify(published.stdout.trim())},'--mode','fenced']`,
      `raise SystemExit(subprocess.run(command,env=env,pass_fds=tuple(fds)).returncode)`,
    ].join(';');
    const rejected = runMutating(value, [
      'guarded-exec', '--', '/usr/bin/python3', '-c', probe,
    ]);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('process differs from canonical SSH authority');
  });

  test('pins generated unit authority before slow systemd inventory', async () => {
    const value = await fixture();
    const installed = join(
      dirname(value.state), 'manager-home/.config/systemd/user',
      'cauce-v3-container-kant.service',
    );
    const replacement = '[Service]\nExecStart=/bin/false\n';
    await writeFile(installed, replacement);
    await writeFile(value.state, JSON.stringify({
      active: true,
      enabled: true,
      pid: 1234,
      replaceGeneratedSourceOnShow: replacement,
    }));
    const rejected = run(value, ['capture'], fleet(true));
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('differs from generated authority');
  });

  test('requires exact 0644 mode for local and remote installed unit fragments', async () => {
    for (const remote of [false, true]) {
      const value = await fixture({ remote });
      const installed = join(
        dirname(value.state), 'manager-home/.config/systemd/user',
        'cauce-v3-container-kant.service',
      );
      await chmod(installed, 0o600);
      const rejected = run(value, ['capture'], fleet(true));
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toMatch(/fragment (?:is unsafe|authentication.*unavailable)/u);
    }
  });

  test('rejects boolean values where the snapshot contract requires integers', async () => {
    const value = await fixture();
    const captured = run(value, ['capture'], fleet(true));
    expect(captured.status, captured.stderr).toBe(0);
    const original = JSON.parse(captured.stdout) as Record<string, unknown> & {
      aliases: { units: { mainPid: number | boolean }[] }[];
    };
    original.aliases[0]!.units[0]!.mainPid = false;
    let content = `${JSON.stringify(original)}\n`;
    await writeFile(value.snapshot, content, { mode: 0o600 });
    let rejected = run(value, [
      'validate', '--snapshot', value.snapshot, '--expected-sha256', digest(content),
    ]);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('unit file/process state is invalid');

    const countBoolean = JSON.parse(captured.stdout) as Record<string, unknown>;
    countBoolean.writersExpectedCandidate = false;
    content = `${JSON.stringify(countBoolean)}\n`;
    await writeFile(value.snapshot, content, { mode: 0o600 });
    rejected = run(value, [
      'validate', '--snapshot', value.snapshot, '--expected-sha256', digest(content),
    ]);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('candidate writer count is inconsistent');
  });

  test('fails closed on an unreachable remote manager or an unaccredited remote fragment', async () => {
    const unreachable = await fixture({ remote: true });
    unreachable.env.FAKE_SSH_UNREACHABLE = '1';
    const unavailable = run(unreachable, ['capture'], fleet(true));
    expect(unavailable.status).toBe(1);
    expect(unavailable.stderr).toContain('inventory for host kratos is unavailable');

    const tampered = await fixture({ remote: true });
    const rogueFragment = join(
      dirname(tampered.state), 'manager-home/.config/systemd/user',
      'cauce-v3-container-kant.service',
    );
    await writeFile(rogueFragment, '[Service]\nExecStart=/bin/false\n');
    await writeFile(tampered.state, JSON.stringify({
      active: true, enabled: true, pid: 1234,
    }));
    const rejected = run(tampered, ['capture'], fleet(true));
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('differs from generated authority');
  });

  test('rejects an active homonymous writer outside the alias declared host', async () => {
    const value = await fixture({ remote: true, includeLocalPeer: true });
    const rejected = run(value, ['capture'], fleet(true));
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('outside its declared host placement');
  });

  test('rejects non-canonical host routing before invoking SSH', async () => {
    const value = await fixture({ remote: true });
    const manifestPath = join(value.ops, 'container-aliases.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      aliases: { kant: { dockerHost: string } };
    };
    manifest.aliases.kant.dockerHost = 'kratos;invalid';
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    const rejected = run(value, ['capture'], fleet(true));
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('container alias manifest is invalid');
  });

  test('invalidates a published recovery snapshot when its canonical manifest drifts', async () => {
    const value = await fixture();
    const captured = run(value, ['capture'], fleet(true));
    expect(captured.status, captured.stderr).toBe(0);
    const published = runMutating(value, ['publish', '--path', value.snapshot], captured.stdout);
    expect(published.status, published.stderr).toBe(0);
    const manifestPath = join(value.ops, 'container-aliases.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      aliases: { kant: { room: string } };
    };
    manifest.aliases.kant.room = 'grp.changed';
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    const rejected = run(value, [
      'validate', '--snapshot', value.snapshot,
      '--expected-sha256', published.stdout.trim(),
    ]);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('differs from the canonical alias manifest');
  });

  test('rechecks manifest identity after inventory and before any unit mutation', async () => {
    const value = await fixture({ remote: true });
    const captured = run(value, ['capture'], fleet(true));
    expect(captured.status, captured.stderr).toBe(0);
    const published = runMutating(value, ['publish', '--path', value.snapshot], captured.stdout);
    expect(published.status, published.stderr).toBe(0);
    const manifestPath = join(value.ops, 'container-aliases.json');
    const changed = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      aliases: { kant: { room: string } };
    };
    changed.aliases.kant.room = 'grp.changed-during-inventory';
    await writeFile(value.state, JSON.stringify({
      active: true,
      enabled: true,
      pid: 1234,
      replaceManifestOnShow: `${JSON.stringify(changed)}\n`,
    }));
    const rejected = runGuardedMutating(value, [
      'fence', '--snapshot', value.snapshot, '--expected-sha256', published.stdout.trim(),
    ]);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('differs from the canonical alias manifest');
    const finalState = JSON.parse(await readFile(value.state, 'utf8')) as {
      disableCalled?: boolean;
    };
    expect(finalState.disableCalled).not.toBe(true);
  });

  test('persistently fences active units across a simulated boot and restores exact enablement', async () => {
    const value = await fixture();
    const captured = run(value, ['capture', '--compose-writer', 'relay-worker'], fleet(true));
    expect(captured.status, captured.stderr).toBe(0);
    const published = runMutating(value, ['publish', '--path', value.snapshot], captured.stdout);
    const snapshotSha = published.stdout.trim();

    await writeFile(value.state, '{"active":true,"enabled":true,"pid":1234,"lostFenceResponse":true}\n');
    const fence = runMutating(value, [
      'fence', '--snapshot', value.snapshot, '--expected-sha256', snapshotSha,
    ]);
    expect(fence.status).toBe(1);
    const fenced = run(value, [
      'check', '--snapshot', value.snapshot, '--expected-sha256', snapshotSha,
      '--mode', 'fenced', '--fleet-stdin', '--compose-writer', 'relay-worker',
    ], fleet(false));
    expect(fenced.status, fenced.stderr).toBe(0);

    const persisted = JSON.parse(await readFile(value.state, 'utf8')) as {
      active: boolean; enabled: boolean; pid: number;
    };
    if (persisted.enabled) persisted.active = true;
    persisted.pid = persisted.active ? 9999 : 0;
    await writeFile(value.state, JSON.stringify(persisted));
    const afterBoot = run(value, [
      'check', '--snapshot', value.snapshot, '--expected-sha256', snapshotSha,
      '--mode', 'fenced', '--fleet-stdin', '--compose-writer', 'relay-worker',
    ], fleet(false));
    expect(afterBoot.status, afterBoot.stderr).toBe(0);

    await writeFile(value.state, '{"active":false,"enabled":false,"pid":0,"lostRestoreResponse":true}\n');
    const restore = runMutating(value, [
      'restore', '--snapshot', value.snapshot, '--expected-sha256', snapshotSha,
    ]);
    expect(restore.status).toBe(1);
    const restored = run(value, [
      'check', '--snapshot', value.snapshot, '--expected-sha256', snapshotSha,
      '--mode', 'restored', '--fleet-stdin', '--compose-writer', 'relay-worker',
    ], fleet(true));
    expect(restored.status, restored.stderr).toBe(0);
  });

  test('reconciles failures before and between systemd enablement and process phases', async () => {
    const value = await fixture();
    const captured = run(value, ['capture'], fleet(true));
    expect(captured.status, captured.stderr).toBe(0);
    const published = runMutating(value, ['publish', '--path', value.snapshot], captured.stdout);
    const snapshotSha = published.stdout.trim();

    expect(runMutating(value, [
      'fence', '--snapshot', value.snapshot, '--expected-sha256', snapshotSha,
    ]).status).toBe(0);
    await writeFile(value.state,
      '{"active":false,"enabled":false,"pid":0,"failEnableBeforeMutation":true}\n');
    const failedEnable = runMutating(value, [
      'restore', '--snapshot', value.snapshot, '--expected-sha256', snapshotSha,
    ]);
    expect(failedEnable.status).toBe(1);
    expect(JSON.parse(await readFile(value.state, 'utf8'))).toMatchObject({
      active: false, enabled: false, pid: 0,
    });

    await writeFile(value.state, '{"active":false,"enabled":false,"pid":0}\n');
    expect(runMutating(value, [
      'restore', '--snapshot', value.snapshot, '--expected-sha256', snapshotSha,
    ]).status).toBe(0);
    expect(JSON.parse(await readFile(value.state, 'utf8'))).toMatchObject({
      active: true, enabled: true,
    });

    await writeFile(value.state,
      '{"active":true,"enabled":true,"pid":4567,"failFenceAfterDisableBeforeStop":true}\n');
    const partialFence = runMutating(value, [
      'fence', '--snapshot', value.snapshot, '--expected-sha256', snapshotSha,
    ]);
    expect(partialFence.status).toBe(1);
    expect(JSON.parse(await readFile(value.state, 'utf8'))).toMatchObject({
      active: true, enabled: false, pid: 4567,
    });

    await writeFile(value.state, '{"active":true,"enabled":false,"pid":4567}\n');
    const retriedFence = runMutating(value, [
      'fence', '--snapshot', value.snapshot, '--expected-sha256', snapshotSha,
    ]);
    expect(retriedFence.status, retriedFence.stderr).toBe(0);
    expect(run(value, [
      'check', '--snapshot', value.snapshot, '--expected-sha256', snapshotSha,
      '--mode', 'fenced', '--fleet-stdin',
    ], fleet(false)).status).toBe(0);
    const restoredAfterRetry = runMutating(value, [
      'restore', '--snapshot', value.snapshot, '--expected-sha256', snapshotSha,
    ]);
    expect(restoredAfterRetry.status, restoredAfterRetry.stderr).toBe(0);
    expect(JSON.parse(await readFile(value.state, 'utf8'))).toMatchObject({
      active: true, enabled: true,
    });
  });

  test('fences enabled-inactive units and rejects active units without reversible enablement', async () => {
    const value = await fixture();
    await writeFile(value.state, '{"active":false,"enabled":true,"pid":0}\n');
    const captured = run(value, ['capture'], fleet(false));
    expect(captured.status, captured.stderr).toBe(0);
    const published = runMutating(value, ['publish', '--path', value.snapshot], captured.stdout);
    const snapshotSha = published.stdout.trim();
    expect(runMutating(value, [
      'fence', '--snapshot', value.snapshot, '--expected-sha256', snapshotSha,
    ]).status).toBe(0);
    expect(run(value, [
      'check', '--snapshot', value.snapshot, '--expected-sha256', snapshotSha,
      '--mode', 'fenced', '--fleet-stdin',
    ], fleet(false)).status).toBe(0);
    expect(runMutating(value, [
      'restore', '--snapshot', value.snapshot, '--expected-sha256', snapshotSha,
    ]).status).toBe(0);
    const restored = JSON.parse(await readFile(value.state, 'utf8')) as {
      active: boolean; enabled: boolean;
    };
    expect(restored).toMatchObject({ active: false, enabled: true });

    const unsafe = await fixture();
    await writeFile(unsafe.state, '{"active":true,"enabled":false,"pid":1234}\n');
    const unsafeCaptured = run(unsafe, ['capture'], fleet(true));
    expect(unsafeCaptured.status).toBe(1);
    expect(unsafeCaptured.stderr).toContain('not exactly and reversibly enabled');
  });

  test.each([
    'enabled-runtime', 'linked', 'linked-runtime', 'static', 'indirect', 'generated', 'transient',
  ])('rejects the non-reversible loaded unit-file state %s', async (unitFileState) => {
    const value = await fixture();
    await writeFile(value.state, JSON.stringify({
      active: false, enabled: false, pid: 0, unitFileState,
    }));
    const rejected = run(value, ['capture'], fleet(false));
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('lacks an exact reversible state');
  });

  test('rejects failed units because their exact failed/substate cannot be restored', async () => {
    const value = await fixture();
    await writeFile(value.state, JSON.stringify({
      active: false,
      activeState: 'failed',
      enabled: true,
      pid: 0,
      subState: 'failed',
    }));
    const rejected = run(value, ['capture'], fleet(false));
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('unsupported state');
  });

  test('compose model requires unless-stopped for dispatcher and every writer', async () => {
    const value = await fixture();
    const runtime = `registry.invalid/cauce/runtime@sha256:${'1'.repeat(64)}`;
    const consoleImage = `registry.invalid/cauce/console@sha256:${'2'.repeat(64)}`;
    const model = (restart: string) => JSON.stringify({ services: {
      migrator: { image: runtime, restart: 'no' },
      gateway: { image: runtime, restart: 'unless-stopped' },
      dispatcher: { image: runtime, restart },
      'outbox-metrics': { image: runtime, restart: 'unless-stopped' },
      'relay-worker': { image: runtime, restart },
      console: { image: consoleImage, restart: 'always' },
    } });
    const accepted = run(value, [
      'compose-model', '--runtime-image', runtime, '--console-image', consoleImage,
    ], model('unless-stopped'));
    expect(accepted.status, accepted.stderr).toBe(0);
    const rejected = run(value, [
      'compose-model', '--runtime-image', runtime, '--console-image', consoleImage,
    ], model('always'));
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('restart-safe release policy');
  });

  test('admits bootstrap-only core and writer runtime tags authenticated by the legacy fleet', async () => {
    const value = await fixture();
    const runtime = `registry.invalid/cauce/runtime@sha256:${'1'.repeat(64)}`;
    const consoleImage = `registry.invalid/cauce/console@sha256:${'2'.repeat(64)}`;
    const directiveTag = 'registry.invalid/cauce/runtime:directiva-20260825';
    const directiveDigest = `registry.invalid/cauce/runtime@sha256:${'3'.repeat(64)}`;
    const record = (
      service: string, configImage: string, repositoryDigest: string,
      status = 'running', exitCode = 0,
    ) => ({
      configHash: 'a'.repeat(64), configImage,
      containerId: (service === 'migrator' ? 'b' : service === 'gateway' ? 'c' : 'd').repeat(64),
      exitCode, imageId: `sha256:${(service === 'migrator' ? '4' : '5').repeat(64)}`,
      repositoryDigest, service, status,
    });
    const legacyFleet = `${JSON.stringify({
      kind: 'cauce-v3-legacy-pre-migration-fleet', project: 'cauce-v3-prod', schemaVersion: 1,
      selectors: {
        console: `cauce-console@sha256:${'6'.repeat(64)}`,
        manifest: '/etc/cauce-v3/compose-overrides/active.manifest',
        manifestSha256: `sha256:${'7'.repeat(64)}`,
        normalizedConsole: consoleImage, normalizedRuntime: runtime,
        runtime: `cauce-runtime@sha256:${'8'.repeat(64)}`,
      },
      services: [
        record('migrator', runtime, runtime, 'exited', 0),
        record('gateway', directiveTag, directiveDigest),
        record('terminal-relay', directiveTag, directiveDigest),
      ],
    })}\n`;
    await writeFile(value.snapshot, legacyFleet, { mode: 0o600 });
    const model = JSON.stringify({ services: {
      migrator: { image: runtime, restart: 'no' },
      gateway: { image: directiveTag, restart: 'unless-stopped' },
      dispatcher: { image: runtime, restart: 'unless-stopped' },
      'outbox-metrics': { image: runtime, restart: 'unless-stopped' },
      'terminal-relay': { image: directiveTag, restart: 'unless-stopped' },
      console: { image: consoleImage, restart: 'always' },
    } });
    const strict = run(value, [
      'compose-model', '--runtime-image', runtime, '--console-image', consoleImage,
    ], model);
    expect(strict.status).toBe(1);
    expect(strict.stderr).toContain('does not use the selected runtime');

    const admitted = run(value, [
      'compose-model', '--runtime-image', runtime, '--console-image', consoleImage,
      '--legacy-fleet-snapshot', value.snapshot,
      '--legacy-fleet-snapshot-sha256', digest(legacyFleet),
    ], model);
    expect(admitted.status, admitted.stderr).toBe(0);
    expect(admitted.stdout).toContain(`core\tgateway\t${directiveTag}`);
    expect(admitted.stdout).toContain(`writer\tterminal-relay\t${directiveTag}`);
  });

  test('rejects an unauthorized bootstrap image and tampering of the legacy fleet', async () => {
    const value = await fixture();
    const runtime = `registry.invalid/cauce/runtime@sha256:${'1'.repeat(64)}`;
    const consoleImage = `registry.invalid/cauce/console@sha256:${'2'.repeat(64)}`;
    const authorizedTag = 'registry.invalid/cauce/runtime:directiva-20260825';
    const legacyFleet = `${JSON.stringify({
      kind: 'cauce-v3-legacy-pre-migration-fleet', project: 'cauce-v3-prod', schemaVersion: 1,
      selectors: {
        console: 'cauce-console:legacy',
        manifest: '/etc/cauce-v3/compose-overrides/active.manifest',
        manifestSha256: `sha256:${'3'.repeat(64)}`,
        normalizedConsole: consoleImage, normalizedRuntime: runtime,
        runtime: 'cauce-runtime:legacy',
      },
      services: [
        {
          configHash: '4'.repeat(64), configImage: runtime,
          containerId: '5'.repeat(64), exitCode: 0, imageId: `sha256:${'6'.repeat(64)}`,
          repositoryDigest: runtime, service: 'migrator', status: 'exited',
        },
        {
          configHash: '7'.repeat(64), configImage: authorizedTag,
          containerId: '8'.repeat(64), exitCode: 0, imageId: `sha256:${'9'.repeat(64)}`,
          repositoryDigest: `registry.invalid/cauce/runtime@sha256:${'a'.repeat(64)}`,
          service: 'gateway', status: 'running',
        },
      ],
    })}\n`;
    await writeFile(value.snapshot, legacyFleet, { mode: 0o600 });
    const unauthorizedModel = JSON.stringify({ services: {
      migrator: { image: runtime, restart: 'no' },
      gateway: { image: 'registry.invalid/cauce/runtime:attacker', restart: 'unless-stopped' },
      dispatcher: { image: runtime, restart: 'unless-stopped' },
      'outbox-metrics': { image: runtime, restart: 'unless-stopped' },
      console: { image: consoleImage, restart: 'always' },
    } });
    const args = [
      'compose-model', '--runtime-image', runtime, '--console-image', consoleImage,
      '--legacy-fleet-snapshot', value.snapshot,
      '--legacy-fleet-snapshot-sha256', digest(legacyFleet),
    ];
    const unauthorized = run(value, args, unauthorizedModel);
    expect(unauthorized.status).toBe(1);
    expect(unauthorized.stderr).toContain('is not authorized by the legacy fleet snapshot');

    await writeFile(value.snapshot, `${legacyFleet} `, { mode: 0o600 });
    const tampered = run(value, args, unauthorizedModel);
    expect(tampered.status).toBe(1);
    expect(tampered.stderr).toContain('differs from its authorized SHA-256');
  });

  test('ordinary writer capture refuses ambient bootstrap legacy-fleet injection', async () => {
    const value = await fixture();
    const result = spawnSync(captureWriter, [value.snapshot], {
      encoding: 'utf8',
      env: {
        ...value.env,
        CAUCE_BOOTSTRAP_CAPTURE_LEGACY_FLEET_FILE: value.snapshot,
        CAUCE_BOOTSTRAP_CAPTURE_LEGACY_FLEET_SHA256: `sha256:${'a'.repeat(64)}`,
      },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('refuses an ambient bootstrap legacy-fleet capability');
  });

  test('rejects undeclared active leases, tampered bytes and a non-slug marker release ID', async () => {
    const value = await fixture();
    const unknown = run(value, ['capture'], fleet(true, [
      { tenant_id: 'rogue', alias: 'rogue', active: true },
    ]));
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('active undeclared writer lease');

    const captured = run(value, ['capture'], fleet(true));
    expect(captured.status, captured.stderr).toBe(0);
    const published = runMutating(value, ['publish', '--path', value.snapshot], captured.stdout);
    const snapshotSha = published.stdout.trim();
    await writeFile(value.snapshot, `${await readFile(value.snapshot, 'utf8')} `, { mode: 0o600 });
    expect(run(value, [
      'validate', '--snapshot', value.snapshot, '--expected-sha256', snapshotSha,
    ]).status).toBe(1);

    await writeFile(value.snapshot, captured.stdout, { mode: 0o600 });
    const marker = runMutating(value, [
      'marker', '--snapshot', value.snapshot, '--expected-sha256', snapshotSha,
      '--path', `${value.snapshot}.state.json`, '--release-id', 'bad release id',
      '--mode', 'candidate', '--writers-expected', '1', '--writers-observed', '1',
    ]);
    expect(marker.status).toBe(1);
    expect(marker.stderr).toContain('release ID is invalid');
  });

  test('publishes canonical read-only markers and enforces candidate and bridge counts', async () => {
    const value = await fixture();
    const captured = run(value, ['capture'], fleet(true));
    const published = runMutating(value, ['publish', '--path', value.snapshot], captured.stdout);
    const snapshotSha = published.stdout.trim();
    const markerPath = `${value.snapshot}.state.json`;
    const candidate = runMutating(value, [
      'marker', '--snapshot', value.snapshot, '--expected-sha256', snapshotSha,
      '--path', markerPath, '--release-id', 'a'.repeat(40), '--mode', 'candidate',
      '--writers-expected', '1', '--writers-observed', '1',
    ]);
    expect(candidate.status, candidate.stderr).toBe(0);
    expect((await stat(markerPath)).mode & 0o777).toBe(0o444);
    expect(Buffer.from(await readFile(markerPath)).toString('ascii')).toBe(await readFile(markerPath, 'utf8'));
    expect(run(value, [
      'marker-check', '--snapshot', value.snapshot, '--expected-sha256', snapshotSha,
      '--path', markerPath, '--release-id', 'a'.repeat(40), '--mode', 'candidate',
      '--writers-expected', '1', '--writers-observed', '1',
    ]).status).toBe(0);
    expect(runMutating(value, [
      'marker', '--snapshot', value.snapshot, '--expected-sha256', snapshotSha,
      '--path', markerPath, '--release-id', 'a'.repeat(40), '--mode', 'rollback_bridge_degraded',
      '--writers-expected', '1', '--writers-observed', '0',
    ]).status).toBe(1);
  });

  test('rejects every mutating action without the authenticated transition capability', async () => {
    const value = await fixture();
    const captured = run(value, ['capture'], fleet(true));
    expect(captured.status, captured.stderr).toBe(0);

    const unguardedPublish = run(value, ['publish', '--path', value.snapshot], captured.stdout);
    expect(unguardedPublish.status).toBe(1);
    expect(unguardedPublish.stderr).toContain('lacks an inherited release lock');
    await expect(stat(value.snapshot)).rejects.toMatchObject({ code: 'ENOENT' });

    const published = runMutating(value, ['publish', '--path', value.snapshot], captured.stdout);
    expect(published.status, published.stderr).toBe(0);
    const snapshotSha = published.stdout.trim();
    const before = await readFile(value.state, 'utf8');
    const legacyStop = runMutating(value, [
      'stop', '--snapshot', value.snapshot, '--expected-sha256', snapshotSha,
    ]);
    expect(legacyStop.status).toBe(2);
    expect(legacyStop.stderr).toContain('invalid choice');
    expect(await readFile(value.state, 'utf8')).toBe(before);
    const unguardedFence = run(value, [
      'fence', '--snapshot', value.snapshot, '--expected-sha256', snapshotSha,
    ]);
    expect(unguardedFence.status).toBe(1);
    expect(await readFile(value.state, 'utf8')).toBe(before);
    const unguardedMarker = run(value, [
      'marker', '--snapshot', value.snapshot, '--expected-sha256', snapshotSha,
      '--path', `${value.snapshot}.state.json`, '--release-id', 'a'.repeat(40),
      '--mode', 'candidate', '--writers-expected', '1', '--writers-observed', '1',
    ]);
    expect(unguardedMarker.status).toBe(1);
    await expect(stat(`${value.snapshot}.state.json`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('rejects a matching token and inode when the supplied writer-state FD was never locked', async () => {
    const value = await fixture();
    const probe = join(dirname(value.envFile), 'writer-unheld-fd-probe.py');
    await writeFile(probe, `
import importlib.util
import os
import pathlib
import sys

helper = pathlib.Path(${JSON.stringify(helper)})
env_file = pathlib.Path(${JSON.stringify(value.envFile)})
sys.path.insert(0, os.fspath(helper.parent))
spec = importlib.util.spec_from_file_location("release_writer_state", helper)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)

lock_path = env_file.parent / f".{env_file.name}.release-pin.lock"
token = "e" * 64
descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o600)
try:
    os.fchmod(descriptor, 0o600)
    os.ftruncate(descriptor, 0)
    os.pwrite(descriptor, (token + "\\n").encode("ascii"), 0)
    os.environ["CAUCE_ENV_FILE"] = os.fspath(env_file)
    os.environ["CAUCE_RELEASE_TRANSITION_LOCK_FD"] = str(descriptor)
    os.environ["CAUCE_RELEASE_TRANSITION_LOCK_TOKEN"] = token
    try:
        accepted = module.authenticated_transition_lock()
    except module.WriterStateError as error:
        if "not already exclusive" not in str(error):
            raise
    else:
        os.close(accepted)
        raise SystemExit("writer-state accepted an initially unlocked FD")
finally:
    os.close(descriptor)
`);
    const result = spawnSync('/usr/bin/python3', [probe], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });
});
