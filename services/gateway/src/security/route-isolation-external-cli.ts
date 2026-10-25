import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { verifiedBaseUrl } from './route-isolation-external-client.js';
import { assertCanaryStates, newRunId, validRunId, type CanaryState, type Side } from './route-isolation-external-canary.js';
import { planExternalVerification, runExternalVerification, type ExternalReceipt } from './route-isolation-external.js';

const USAGE = `Uso: pnpm verify:external --base-url <https://origen> [--dry-run] [--run-id <id>] [--rate <pet/s>]
       [--max-requests <n>] [--out-dir <dir>] [--receipt <ruta>] [--cleanup <run-id>] [--oauth-issuer <origen>]
       [--terminal-fixture-socket <socket-privado-de-laboratorio>]
Registra dos empresas zz-canary-<run>-{a,b}, recorre el registro y la empresa, ataca B desde A y retira ambas.`;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function clientRevision(): { sha: string; dirty: boolean } {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim() !== '';
    return { sha, dirty };
  } catch { return { sha: 'unknown', dirty: true }; }
}

function integer(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!/^\d{1,6}$/u.test(value)) throw new Error(`${name} must be a positive integer`);
  return Number(value);
}

async function writePrivate(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, strict: true, options: {
    'base-url': { type: 'string' }, 'dry-run': { type: 'boolean', default: false }, 'run-id': { type: 'string' },
    rate: { type: 'string' }, 'max-requests': { type: 'string' }, 'out-dir': { type: 'string' }, receipt: { type: 'string' },
    cleanup: { type: 'string' }, 'oauth-issuer': { type: 'string' }, 'terminal-fixture-socket': { type: 'string' },
    help: { type: 'boolean', default: false } } });
  if (values.help || values['base-url'] === undefined) { console.log(USAGE); return values.help ? 0 : 2; }
  const base = verifiedBaseUrl(values['base-url']);
  const loopback = LOOPBACK.has(base.hostname);
  if (values['terminal-fixture-socket'] !== undefined && !loopback) throw new Error('terminal fixture is restricted to a loopback laboratory gateway');
  const rate = integer(values.rate, 5, '--rate');
  if (rate < 1 || rate > (loopback ? 100 : 10)) throw new Error(`--rate must be between 1 and ${loopback ? '100' : '10'} requests per second`);
  const maxRequests = integer(values['max-requests'], 4000, '--max-requests');
  const runId = validRunId(values.cleanup ?? values['run-id'] ?? newRunId());
  const options = { baseUrl: base.origin, runId, ratePerSecond: rate, maxRequests };
  if (values['dry-run']) {
    console.log(JSON.stringify({ dry_run: true, client: clientRevision(), ...planExternalVerification(options),
      terminal_fixture: values['terminal-fixture-socket'] !== undefined,
      ...(values['terminal-fixture-socket'] === undefined ? {} : { required_planes: ['terminal', 'relay', 'bootstrap'],
        terminal_checks: ['real targets and grants', 'PTY roundtrip', 'foreign session credentials', 'mTLS relay admission', 'B unchanged'] }) }, null, 2));
    return 0;
  }
  const directory = resolve(values['out-dir'] ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'cauce-v3/verify-external'), runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const statePath = join(directory, 'canaries.json');
  const existing = values.cleanup === undefined ? undefined
    : assertCanaryStates(runId, JSON.parse(await readFile(statePath, 'utf8')) as Record<Side, CanaryState>);
  const issuer = values['oauth-issuer'] === undefined ? {} : { oauthIssuer: new URL(values['oauth-issuer']).origin };
  const terminal = values['terminal-fixture-socket'] === undefined ? {} : { terminalFixtureSocket: resolve(values['terminal-fixture-socket']) };
  const receipt: ExternalReceipt = await runExternalVerification({ ...options, ...issuer, ...terminal, client: clientRevision(),
    persist: async states => { await writePrivate(statePath, `${JSON.stringify(states, null, 1)}\n`); },
    log: line => { console.error(`[verify-external ${runId}] ${line}`); } }, existing);
  const receiptPath = resolve(values.receipt ?? join(directory, 'receipt.json'));
  await writePrivate(receiptPath, `${JSON.stringify(receipt, null, 1)}\n`);
  const pending = receipt.canaries.filter(item => item.registered && !item.retired).map(item => item.company);
  if (!pending.length) await rm(statePath, { force: true });
  const { totals } = receipt;
  console.log(`VERIFY_EXTERNAL receipt=${receiptPath} url=${receipt.base_url} client=${receipt.client.sha}${receipt.client.dirty ? '+dirty' : ''} `
    + `cases=${String(totals.cases)} passed=${String(totals.passed)} failures=${String(totals.failures)} not_configured=${String(totals.not_configured)} `
    + `not_mounted=${String(totals.not_mounted)} inconclusive=${String(totals.inconclusive)} synthetic=${String(totals.synthetic_targets)} requests=${String(receipt.requests)}`
    + (pending.length ? ` pending_cleanup=${pending.join(',')} (retry: --cleanup ${runId})` : ''));
  for (const failure of receipt.failures) console.log(`  FAIL ${failure.id}: ${failure.detail}`);
  return totals.failures === 0 && pending.length === 0 ? 0 : 1;
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, (error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
