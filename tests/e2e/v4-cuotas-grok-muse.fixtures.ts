import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { QuotaDockerImage } from './v4-quota-environments-real-browser.fixtures.js';

const execute = promisify(execFile);
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const DOCKER = ['docker', '--context', 'lab'] as const;

export async function prepareGrokMuseQuotaImage(evidence: string, prefix: string, task: string): Promise<QuotaDockerImage> {
  const directory = join(evidence, 'grok-muse-image');
  await mkdir(directory, { recursive: true });
  const grokAccount = `grok:${sha('zz-canary-grok-account')}`;
  const museAccount = `muse:${sha('zz-canary-muse-account')}`;
  const providerDouble = (name: string, session: string, account: string, version: string) => `#!/usr/bin/python3
import pathlib, sys, time
session = pathlib.Path(${JSON.stringify(session)})
if '--version' in sys.argv:
    print(${JSON.stringify(version)})
elif 'login' in sys.argv:
    print(${JSON.stringify(name + ': escribe APROBAR')}, flush=True)
    if input().strip() == 'APROBAR':
        session.write_text(${JSON.stringify(account)})
        print(${JSON.stringify(name + ': sesion autorizada')}, flush=True)
        time.sleep(300)
    else:
        sys.exit(1)
else:
    sys.exit(2)
`;
  const grokQuota = `#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
const session = ${JSON.stringify('/home/node/.grok-quota-session')};
if (!existsSync(session)) {
  console.log(JSON.stringify({ ok: false, error_code: 'not_authenticated', error: 'sin credencial', windows: [] }));
  process.exit(1);
}
const account = readFileSync(session, 'utf8').trim();
console.log(JSON.stringify({ ok: true, provider: 'grok', available: true, account_id: account, windows: [
  { key: '5h', remainingPercent: 72, usedPercent: 28, windowMinutes: 300, status: 'ok' },
  { key: '7d', remainingPercent: 91, usedPercent: 9, windowMinutes: 10080, status: 'ok' }] }));
`;
  const museQuota = `#!/usr/bin/python3
import json, pathlib, sys
session = pathlib.Path('/home/node/.muse-quota-session')
if not session.is_file() or not session.stat().st_size:
    print(json.dumps({'ok': False, 'error_code': 'not_authenticated', 'error': 'sin credencial', 'windows': []}))
    sys.exit(1)
print(json.dumps({'ok': True, 'provider': 'muse', 'available': True, 'account_id': session.read_text().strip(), 'windows': [
    {'key': '5h', 'remainingPercent': 72, 'usedPercent': 28, 'windowMinutes': 300, 'status': 'ok'},
    {'key': '7d', 'remainingPercent': 91, 'usedPercent': 9, 'windowMinutes': 10080, 'status': 'ok'}]}))
`;
  const museVerify = `#!/usr/bin/python3
import json, pathlib
session = pathlib.Path('/home/node/.muse-quota-session')
if session.is_file() and session.stat().st_size:
    print(json.dumps({'ok': True, 'account_id': session.read_text().strip()}))
else:
    print(json.dumps({'ok': False, 'error_code': 'not_authenticated'}))
`;
  const npm = `#!/bin/sh
set -eu
case " $* " in
  *" @xai-official/grok "*)
    mkdir -p /home/node/.local/bin
    printf '%s\\n' '#!/bin/sh' 'echo grok-cli 2.0.0' > /home/node/.local/bin/grok
    chmod 755 /home/node/.local/bin/grok
    ;;
  *)
    echo unexpected-npm-argv >&2
    exit 1
    ;;
esac
`;
  const actualizar = `#!/usr/bin/python3
import pathlib
destination = pathlib.Path('/home/node/.local/bin/muse')
destination.parent.mkdir(parents=True, exist_ok=True)
temporary = destination.with_name('muse.new')
temporary.write_text('#!/bin/sh\\necho muse-cli 2.0.0\\n')
temporary.chmod(0o755)
temporary.replace(destination)
`;
  const launcher = `#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
int main(int argc, char **argv) {
    const char *name = argv[0] ? strrchr(argv[0], '/') : NULL;
    name = name ? name + 1 : argv[0];
    const char *script = NULL;
    if (name && strcmp(name, "grok") == 0) script = "/usr/local/lib/cauce-grok-double.py";
    else if (name && strcmp(name, "muse") == 0) script = "/usr/local/lib/cauce-muse-double.py";
    else return 127;
    char **command = calloc((size_t)argc + 2, sizeof(char *));
    if (!command) return 111;
    command[0] = "/usr/bin/python3";
    command[1] = (char *)script;
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
  const baseImage = `cauce-e2e-lab-runner:${sha(runnerDockerfile).slice(0, 12)}`;
  const present = await execute(DOCKER[0], [...DOCKER.slice(1), 'image', 'inspect', baseImage], { timeout: 30_000 })
    .then(() => true, () => false);
  if (!present) {
    await execute(DOCKER[0], [...DOCKER.slice(1), 'build', '--pull=false', '-t', baseImage,
      join(process.cwd(), 'tests/e2e/lab-runner')], { timeout: 600_000 });
  }
  await writeFile(join(directory, 'grok'), providerDouble('grok', '/home/node/.grok-quota-session', grokAccount, 'grok-cli 1.0.0'), { mode: 0o755 });
  await writeFile(join(directory, 'muse'), providerDouble('muse', '/home/node/.muse-quota-session', museAccount, 'muse-cli 1.0.0'), { mode: 0o755 });
  await writeFile(join(directory, 'leer-cuota-grok.mjs'), grokQuota, { mode: 0o755 });
  await writeFile(join(directory, 'leer-cuota-muse'), museQuota, { mode: 0o755 });
  await writeFile(join(directory, 'verificar-muse.py'), museVerify, { mode: 0o755 });
  await writeFile(join(directory, 'npm'), npm, { mode: 0o755 });
  await writeFile(join(directory, 'actualizar-muse'), actualizar, { mode: 0o755 });
  await writeFile(join(directory, 'launcher.c'), launcher);
  await writeFile(join(directory, 'Dockerfile'), `FROM ${baseImage} AS compiler\nUSER root\nCOPY launcher.c /tmp/launcher.c\nRUN cc -O2 -Wall -Wextra -Werror /tmp/launcher.c -o /tmp/provider\nFROM ${baseImage}\nUSER root\nCOPY --from=compiler --chmod=0555 /tmp/provider /usr/local/bin/grok\nCOPY --from=compiler --chmod=0555 /tmp/provider /usr/local/bin/muse\nCOPY --chmod=0555 grok /usr/local/lib/cauce-grok-double.py\nCOPY --chmod=0555 muse /usr/local/lib/cauce-muse-double.py\nCOPY --chmod=0555 leer-cuota-grok.mjs /usr/local/bin/leer-cuota-grok.mjs\nCOPY --chmod=0555 npm /usr/local/bin/npm\nCOPY --chmod=0555 leer-cuota-muse /usr/local/bin/leer-cuota-muse\nCOPY --chmod=0555 actualizar-muse /usr/local/bin/actualizar-muse\nCOPY --chmod=0555 verificar-muse.py /usr/local/bin/verificar-muse.py\nUSER node\nWORKDIR /home/node\nENV HOME=/home/node\nENV MUSE_NO_AUTO_UPDATE=1\nCMD ["sleep", "infinity"]\n`);
  const tag = `${prefix}:grok-muse`;
  const built = await execute(DOCKER[0], [...DOCKER.slice(1), 'build', '--pull=false', '--label', `cauce.e2e.owner=${task}`, '-t', tag, directory], { timeout: 300_000 });
  await writeFile(join(evidence, 'grok-muse-build.log'), `${built.stdout}${built.stderr}`);
  const imageId = (await execute(DOCKER[0], [...DOCKER.slice(1), 'image', 'inspect', '--format', '{{.Id}}', tag])).stdout.trim();
  const bundle = join(evidence, 'grok-muse-bundle');
  const descriptors = join(bundle, 'packages/adapter-sdk/dist/descriptors');
  await mkdir(descriptors, { recursive: true });
  const grokDescriptor = await readFile(join(process.cwd(), 'packages/adapter-sdk/descriptors/grok.json'));
  const museDescriptor = await readFile(join(process.cwd(), 'packages/adapter-sdk/descriptors/muse.json'));
  await writeFile(join(descriptors, 'grok.json'), grokDescriptor);
  await writeFile(join(descriptors, 'muse.json'), museDescriptor);
  const digest = (await execute('/usr/bin/python3', ['-B', '-c',
    'import sys;sys.path.insert(0,sys.argv[1]);from fleet_executor_runtime import bundle_digest;print(bundle_digest(sys.argv[2]))',
    join(process.cwd(), 'ops/cli'), bundle])).stdout.trim();
  const executable = await readFile('/usr/bin/true');
  const bundleRecord = (descriptor: Buffer) => ({ directory: bundle, digest, executable: '/usr/bin/true',
    executable_sha256: sha(executable), argv: [] as string[], descriptor_sha256: sha(descriptor) });
  return { image: imageId, tag, providers: ['grok', 'muse'], bundle_digest: digest,
    versions: { grok: 'grok-cli 1.0.0', muse: 'muse-cli 1.0.0' },
    bundles: { grok: bundleRecord(grokDescriptor), muse: bundleRecord(museDescriptor) } };
}
