import { randomUUID } from 'node:crypto';
import { chmod, copyFile, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { browserDocker } from './browser-owned-lifecycle.js';
import { digest, realV4Image, type V4TestContext } from './v4-terminal-v4-image-real-browser.image.js';
import { packageSdk, startV4Runtime } from './v4-terminal-v4-image-real-browser.runtime.js';

export const owner = 'h8c-tui-login-caducado-1025';
export const runId = randomUUID();
export const evidence = join(process.cwd(), '.delegados/v4/recibos', owner, runId);
export const context: V4TestContext = { owner, runId, evidence };

export async function startLoginCanary() {
  const image = await realV4Image(context);
  const sdk = await packageSdk(context);
  let runtime: Awaited<ReturnType<typeof startV4Runtime>> | undefined;
  const close = async () => {
    const failures: unknown[] = [];
    try { await runtime?.close(); } catch (error) { failures.push(error); }
    try { await rm(dirname(dirname(sdk)), { recursive: true, force: true }); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'login canary cleanup failed');
  };
  try {
    await copyFile('tests/e2e/v4-tui-login-expired-real-browser.tui.py', join(sdk, 'test-runtime/claude'));
    await chmod(join(sdk, 'test-runtime/claude'), 0o555);
    const files: Record<string, string> = {};
    const visit = async (directory: string): Promise<void> => {
      for (const row of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, row.name);
        if (row.isDirectory()) await visit(path);
        else if (row.isFile() && path.endsWith('.ts')) files[path] = digest(await readFile(path));
      }
    };
    await visit('packages/adapter-sdk/src');
    for (const path of ['console/src/api/types/activity.ts', 'console/src/api/types/deliveries.ts',
      'console/src/features/live/provider-login.ts', 'console/src/features/live/agent-state.ts', 'console/src/features/live/agent-state.test.ts',
      'console/src/features/messages/MessageDeliveryCheck.tsx', 'console/src/features/messages/ConversationPane.tsx',
      'console/src/features/messages/ConversationPane.test.tsx', 'console/src/features/messages/ChatThread.test.tsx',
      'packages/store/src/fleet-activity.ts', 'packages/store/src/repository/messages.ts', 'packages/store/src/repository/observability.ts',
      'packages/store/src/repository/visibility-rows.ts', 'packages/store/test/harness-consumption-postgres.test.ts']) files[path] = digest(await readFile(path));
    for (const name of await readdir('tests/e2e')) if (name.startsWith('v4-tui-login-expired-real-browser.')
      || name.startsWith('v4-terminal-v4-image-real-browser.')) files[join('tests/e2e', name)] = digest(await readFile(join('tests/e2e', name)));
    await writeFile(join(evidence, 'manifest.json'), JSON.stringify({ run_id: runId, owner, image, files,
      tui: { kind: 'authorized Claude screen double', sha256: digest(await readFile(join(sdk, 'test-runtime/claude'))) } }, null, 2));
    runtime = await startV4Runtime(image, sdk, 'claude', { context, driverPath: 'tests/e2e/v4-tui-login-expired-real-browser.driver.py' });
    const active = runtime;
    return { ...active, image, close,
      mode: async (mode: 'healthy' | 'expired') => {
        const script = 'import pathlib,sys;p=pathlib.Path(sys.argv[1]);t=p.with_suffix(".next");t.write_text(sys.argv[2]);t.chmod(0o600);t.replace(p)';
        await browserDocker(['exec', '--user', 'node', active.name, 'python3', '-I', '-B', '-c', script, `${active.binding.profile}/double-mode`, mode]);
      },
      facts: async () => {
        const script = `import hashlib,json,os,pathlib,sys
root=pathlib.Path(sys.argv[1]);facts=json.loads((root/'double-process.json').read_text());pid=facts['pid'];proc=pathlib.Path('/proc')/str(pid)
events=root/'double-input.jsonl';facts['inputs']=[json.loads(line) for line in events.read_text().splitlines()] if events.exists() else []
normalization=root/'double-normalization.jsonl';facts['normalization']=[json.loads(line) for line in normalization.read_text().splitlines()] if normalization.exists() else []
facts.update(mode=(root/'double-mode').read_text().strip(),hold_ready=(root/'double-hold-ready').read_text() if (root/'double-hold-ready').exists() else None,uid=proc.stat().st_uid,executable=os.readlink(proc/'exe'),starttime=(proc/'stat').read_text().split(') ',1)[1].split()[19],command_sha256=hashlib.sha256(pathlib.Path(sys.argv[2]).read_bytes()).hexdigest())
print(json.dumps(facts))`;
        return JSON.parse((await browserDocker(['exec', '--user', 'node', active.name, 'python3', '-I', '-B', '-c', script,
          active.binding.profile, active.binding.command])).stdout) as {
          pid: number; native_id: string; double: boolean; mode: string; uid: number; executable: string; starttime: string;
          command_sha256: string; hold_ready: string | null; inputs: { mode: string; bytes: number; sha256: string }[];
          normalization: { raw_sha256: string; normalized_sha256: string; raw_cr: number; normalized_cr: number; normalized_lf: number }[];
        };
      },
    };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'login canary preparation failed'); }
    throw error;
  }
}
