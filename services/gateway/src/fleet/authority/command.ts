import { spawn } from 'node:child_process';
import { normalize } from 'node:path';
import { z } from 'zod';
import { assertLoginPins, readPrivateJson } from '../provider-login.js';
import { AuthorityDigestSchema, FleetAuthorityError } from './schemas.js';

const Path = z.string().refine(value => value.startsWith('/') && normalize(value) === value && !/[\p{Cc}]/u.test(value));
const Config = z.object({ python: Path, executable: Path, sha256: AuthorityDigestSchema,
  policy_file: Path, policy_sha256: AuthorityDigestSchema, timeout_ms: z.number().int().min(1).max(120_000).optional(),
}).strict();
export type AuthorityCommand = z.infer<typeof Config>;
export async function runAuthorityCommand(input: AuthorityCommand, packet: unknown): Promise<unknown> {
  const config = Config.parse(input);
  const encoded = Buffer.from(JSON.stringify(packet));
  if (encoded.length > 65_536) throw new FleetAuthorityError('INVALID_REQUEST');
  await assertLoginPins({ [config.executable]: config.sha256, [config.policy_file]: config.policy_sha256 });
  await readPrivateJson(config.policy_file);
  return new Promise((resolve, reject) => {
    const child = spawn(config.python, [config.executable, '--policy', config.policy_file, '--policy-sha256', config.policy_sha256], {
      detached: true, stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', TMPDIR: '/var/tmp', PYTHONDONTWRITEBYTECODE: '1' },
    });
    let stopped = false; let bytes = 0; let escalation: NodeJS.Timeout | undefined;
    const chunks: Buffer[] = [];
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, signal); } catch { /* An exited helper has no remaining process group. */ }
    };
    const stop = () => { stopped = true; kill('SIGTERM'); escalation ??= setTimeout(() => { kill('SIGKILL'); }, 500); };
    const timer = setTimeout(stop, config.timeout_ms ?? 45_000);
    const cleanup = () => { clearTimeout(timer); if (escalation) clearTimeout(escalation); };
    const unavailable = () => { reject(new FleetAuthorityError('AUTHORITY_UNAVAILABLE')); };
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 262_144) stop(); else chunks.push(chunk);
    });
    child.stdin.on('error', stop);
    child.once('error', () => { cleanup(); unavailable(); });
    child.once('close', code => {
      cleanup();
      if (code !== 0 || stopped) { unavailable(); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown); } catch { unavailable(); }
    });
    child.stdin.end(encoded);
  });
}
