import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { QuotaDockerImage } from './v4-quota-environments-real-browser.fixtures.js';

const execute = promisify(execFile);
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export async function prepareFake2QuotaImage(evidence: string, prefix: string, task: string, loginUrl = 'https://example.invalid/fake2',
  options: { baseImage?: string } = {}): Promise<QuotaDockerImage> {
  const directory = join(evidence, 'fake2-image');
  await mkdir(directory, { recursive: true });
  const double = `#!/usr/bin/python3
import datetime, json, pathlib, sys, time
home = pathlib.Path('/home/node')
session = home / '.fake2-session'
updated = home / '.fake2-updated'
if '--version' in sys.argv:
    print('fake2-cli 2.0.0' if updated.exists() else 'fake2-cli 1.0.0')
elif 'login' in sys.argv:
    print('fake2: escribe APROBAR para autorizar ' + ${JSON.stringify(loginUrl)}, flush=True)
    if input().strip() == 'APROBAR':
        session.write_text('fake2-owned-subscription')
        print('fake2: sesion autorizada', flush=True)
        time.sleep(300)
elif 'quota' in sys.argv:
    if not session.exists():
        print(json.dumps({'ok': False, 'error_code': 'not_authenticated', 'error': 'sin credencial', 'windows': []}))
        sys.exit(1)
    mode_file = home / '.fake2-mode'
    mode = mode_file.read_text() if mode_file.exists() else 'normal'
    if mode == 'invalid-json':
        print('fake2: unreadable quota response')
        sys.exit(0)
    if mode == 'provider-error':
        print(json.dumps({'ok': False, 'error_code': 'network', 'error': 'fake2 network failure', 'windows': []}))
        sys.exit(1)
    if mode == 'verification-delay':
        time.sleep(3)
    windows = [
        {'key': 'five-hour', 'label': 'Cinco horas fake2', 'remainingPercent': 72, 'usedPercent': 28, 'windowMinutes': 300},
        {'key': 'seven-day', 'label': 'Semana fake2', 'remainingPercent': 91, 'usedPercent': 9, 'windowMinutes': 10080}]
    if mode in ('exhausted', 'model-dependent', 'automatic-pause'):
        windows[0].update({'remainingPercent': 0, 'usedPercent': 100})
    if mode == 'stale':
        for window in windows:
            window['status'] = 'stale'
    if mode == 'automatic-pause':
        windows[0]['resetAt'] = (datetime.datetime.now(datetime.UTC) + datetime.timedelta(hours=1)).isoformat()
    if mode == 'model-dependent':
        windows[0]['model'] = 'fake2-small'
        windows[1]['model'] = 'fake2-large'
    print(json.dumps({'ok': True, 'available': True, 'account_id': session.read_text(),
        'source': 'fake2', 'effectiveRemainingPercent': 0 if mode in ('exhausted', 'model-dependent', 'automatic-pause') else 72, 'windows': windows}))
else:
    sys.exit(2)
`;
  // The exploration laboratory also reports when each window resets, as the real readers do.
  const reported = options.baseImage ? double.replace("    print(json.dumps({'ok': True, 'available': True,",
    "    for index, window in enumerate(windows):\n        window.setdefault('resetAt', (datetime.datetime.now(datetime.UTC) + (datetime.timedelta(hours=3, minutes=20) if index == 0 else datetime.timedelta(days=4, hours=2))).isoformat())\n    print(json.dumps({'ok': True, 'available': True,") : double;
  const update = '#!/bin/sh\nset -eu\nmkdir -p /home/node/.local/bin\ncp /usr/local/bin/claude /home/node/.local/bin/claude\ntouch /home/node/.fake2-updated\n';
  const launcher = `#include <errno.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>
int main(int argc, char **argv) {
    char **command = calloc((size_t)argc + 2, sizeof(char *));
    if (!command) return 111;
    command[0] = "/usr/bin/python3";
    command[1] = "/usr/local/lib/cauce-fake2.py";
    for (int index = 1; index < argc; index++) command[index + 1] = argv[index];
    pid_t child = fork();
    if (child < 0) return 111;
    if (child == 0) { execv(command[0], command); _exit(127); }
    int status;
    while (waitpid(child, &status, 0) < 0) if (errno != EINTR) return 111;
    free(command);
    return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
`;
  const runnerDockerfile = await readFile(join(process.cwd(), 'tests/e2e/lab-runner/Dockerfile'));
  const baseImage = options.baseImage ?? `cauce-e2e-lab-runner:${sha(runnerDockerfile).slice(0, 12)}`;
  await writeFile(join(directory, 'fake2'), reported, { mode: 0o755 });
  await writeFile(join(directory, 'npm'), update, { mode: 0o755 });
  await writeFile(join(directory, 'launcher.c'), launcher);
  if (options.baseImage) {
    // A laboratory daemon has no network for apt: the launcher is built here and copied in.
    await writeFile(join(directory, 'launcher.c'), launcher);
    await execute('cc', ['-O2', '-static', '-o', join(directory, 'claude'), join(directory, 'launcher.c')], { timeout: 60_000 });
  }
  await writeFile(join(directory, 'Dockerfile'), options.baseImage
    ? `FROM ${baseImage}\nUSER root\nCOPY claude /usr/local/bin/claude\nCOPY fake2 /usr/local/lib/cauce-fake2.py\nCOPY npm /usr/local/bin/npm\nRUN chmod 0555 /usr/local/bin/claude /usr/local/lib/cauce-fake2.py /usr/local/bin/npm\nUSER node\nWORKDIR /home/node\nENV HOME=/home/node\nCMD ["sleep", "infinity"]\n`
    : `FROM ${baseImage} AS compiler\nUSER root\nRUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*\nCOPY launcher.c /tmp/launcher.c\nRUN cc -O2 -Wall -Wextra -Werror /tmp/launcher.c -o /tmp/claude\nFROM ${baseImage}\nUSER root\nCOPY --from=compiler --chmod=0555 /tmp/claude /usr/local/bin/claude\nCOPY --chmod=0555 fake2 /usr/local/lib/cauce-fake2.py\nCOPY --chmod=0555 npm /usr/local/bin/npm\nUSER node\nWORKDIR /home/node\nENV HOME=/home/node\nCMD ["sleep", "infinity"]\n`);
  const tag = `${prefix}:fake2`;
  const built = await execute('docker', ['build', '--pull=false', '--label', `cauce.e2e.owner=${task}`, '-t', tag, directory], { timeout: 300_000 });
  await writeFile(join(evidence, 'fake2-build.log'), `${built.stdout}${built.stderr}`);
  const imageId = (await execute('docker', ['image', 'inspect', '--format', '{{.Id}}', tag])).stdout.trim();
  const bundle = join(evidence, 'fake2-bundle');
  const descriptors = join(bundle, 'packages/adapter-sdk/dist/descriptors');
  await mkdir(descriptors, { recursive: true });
  const descriptor = JSON.stringify({ schema_version: 1, harness: 'claude',
    operations: { install: 'runtime-package', execute: 'native-execution', authenticate: 'provider-login', quota: 'quota-collector', update: 'provider-update' },
    context: { native_document: 'AGENTS.md', max_bytes: 65536 },
    provider: { authenticate_argv: ['/usr/local/bin/claude', 'login'], quota_argv: ['/usr/local/bin/claude', 'quota'],
      verify_argv: ['/usr/local/bin/claude', 'quota'], update_package: '@cauce/fake2', fleet_module: null } });
  await writeFile(join(descriptors, 'claude.json'), descriptor);
  const digest = (await execute('/usr/bin/python3', ['-B', '-c',
    'import sys;sys.path.insert(0,sys.argv[1]);from fleet_executor_runtime import bundle_digest;print(bundle_digest(sys.argv[2]))',
    join(process.cwd(), 'ops/cli'), bundle])).stdout.trim();
  return { image: imageId, tag, providers: ['claude'], bundle_digest: digest, versions: { claude: 'fake2-cli 1.0.0' },
    bundles: { claude: { directory: bundle, digest, executable: '/usr/bin/true', executable_sha256: sha(await readFile('/usr/bin/true')),
      argv: [], descriptor_sha256: sha(descriptor) } } };
}
