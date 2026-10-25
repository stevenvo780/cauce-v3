import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFleetCliRuntimeBundle } from './v4-cli-flota-dinamica.runtime.js';
import { cancelDeployTuiRuntime } from './v4-fleet-cancel-deploy.tui.js';
import { IDLE_PLACEHOLDER } from './s2d-provider.js';

const execute = promisify(execFile);
const owner = 'a22-dobles-compositor-canonico-1025';
const run = randomUUID().slice(0, 8);
const receipts = join(process.cwd(), '.delegados/v4/recibos', owner, 'composer-frames', run);
const guardFile = 'ops/container-runtime/cauce_container_restart.py';
const correlation = JSON.stringify({ cauce_correlation_id: 'b'.repeat(64) });
const chatInput = JSON.stringify({ body: { text: 'A22_CHAT_HISTORY' } });
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const variants = ['idle_start', 'idle_history', 'plain_draft', 'placeholder_draft',
  'open_paste', 'multiline_open_paste', 'multiline_closed_no_enter', 'completed_turn_with_next_draft'];
let directory = '';
let initialHashes: Record<string, string> = {};

interface Provider {
  id: string; source: string; harness: 'codex' | 'claude' | 'muse'; language: 'python' | 'cjs' | 'mjs';
  ready: string; input: string; expected: string; args?: string[];
  exportText?: () => string | undefined; variable?: string; kernel?: boolean;
}
const providers: Provider[] = [
  { id: 'fleet-default', source: 'tests/e2e/v4-cli-flota-dinamica.runtime.ts', harness: 'codex', language: 'python',
    ready: 'CLI_NATIVE_READY:', input: 'REMEMBER A22-OWNED-PROBE', expected: 'STORED:A22-OWNED-PROBE',
    exportText: () => createFleetCliRuntimeBundle(process.cwd()).providerCli },
  { id: 'cancel-deploy', source: 'tests/e2e/v4-fleet-cancel-deploy.tui.ts', harness: 'codex', language: 'python',
    ready: IDLE_PLACEHOLDER, input: `FLEET-DEPLOY-DELIVERY-aaaaaaaa ${correlation}`, expected: 'DELIVERED:FLEET-DEPLOY-DELIVERY-aaaaaaaa',
    exportText: () => cancelDeployTuiRuntime.providerCli },
  { id: 'h6d', source: 'tests/e2e/h6d-reinicio-politica.provider.py', harness: 'codex', language: 'python',
    ready: 'POLICY_READY:', input: 'REMEMBER A22-OWNED-PROBE', expected: 'STORED:A22-OWNED-PROBE' },
  { id: 'a18c', source: 'tests/e2e/v4-a18c-provider.py', harness: 'codex', language: 'python',
    ready: 'A18C_TUI_READY', input: `A18C_NONCE_${'a'.repeat(32)} ${correlation}`, expected: `A18C_REPLY:A18C_NONCE_${'a'.repeat(32)}` },
  { id: 'live-claude', source: 'tests/e2e/v4-live-adapter-release.helpers.ts', harness: 'claude', language: 'cjs',
    ready: '❯', input: correlation, expected: 'LIVE_RELEASE_CANARY_DONE', variable: 'CLAUDE' },
  { id: 'muse-humanos', source: 'tests/e2e/v4-humanos-tui-compartida-real-browser.test.ts', harness: 'muse', language: 'mjs',
    ready: 'Muse listo', input: 'A22_HISTORY', expected: `MUSE TUI COMPARTIDA ${run}`, kernel: true },
  { id: 'muse-contexto', source: 'tests/e2e/v4-contexto-adoptado-muse-real-browser.test.ts', harness: 'muse', language: 'mjs',
    ready: 'Muse listo', input: 'A22_HISTORY', expected: 'SIN CONTEXTO MUSE', kernel: true },
  { id: 'timeout-claude', source: 'tests/e2e/v4-shared-tui-timeouts.helpers.ts', harness: 'claude', language: 'cjs',
    ready: 'Controlled TUI ready', input: correlation, expected: 'silent turn completed', variable: 'TUI', args: ['idle-live'] },
  { id: 'healthy-claude', source: 'tests/e2e/v4-tui-login-expired-real-browser.tui.py', harness: 'claude', language: 'python',
    ready: 'CLAUDE_CANARY_READY', input: `H8C_OK_${'a'.repeat(32)} ${correlation}`, expected: 'H8C_HEALTHY_REPLY:' },
  { id: 'chat-codex', source: 'tests/e2e/chat-native-consumption.fixtures.ts', harness: 'codex', language: 'mjs',
    ready: IDLE_PLACEHOLDER, input: `${chatInput}\n${correlation}`, expected: 'respuesta con consumo comprobado A22_CHAT_HISTORY', kernel: true },
];

function sourceExpression(provider: Provider, source: string): string {
  const parsed = ts.createSourceFile(provider.source, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const expressions: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (provider.variable && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.name.text === provider.variable && node.initializer) expressions.push(node.initializer);
    if (provider.kernel && ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === 'writeFile' && node.arguments[0]?.getText(parsed) === 'kernel') {
      const expression = node.arguments[1];
      if (expression) expressions.push(expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.equal(expressions.length, 1, `${provider.id}: the provider source must have one exact AST expression`);
  const expression = expressions[0];
  assert.ok(expression);
  assert.ok(ts.isTemplateExpression(expression) || ts.isNoSubstitutionTemplateLiteral(expression)
    || (ts.isTaggedTemplateExpression(expression) && expression.tag.getText(parsed) === 'String.raw'));
  return expression.getText(parsed);
}

async function materialize(provider: Provider, variant: string) {
  const owned = join(directory, provider.id, variant);
  const home = join(owned, 'home'), codex = join(owned, 'codex'), claude = join(owned, 'claude');
  await Promise.all([home, codex, claude, join(owned, 'workspace')].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  const file = join(owned, 'transcript.jsonl'), submitted = join(owned, 'submitted.json');
  const source = await readFile(provider.source, 'utf8');
  let script: unknown = provider.language === 'python' ? source : undefined;
  if (provider.exportText) script = provider.exportText();
  else if (provider.variable || provider.kernel) script = runInNewContext(sourceExpression(provider, source), {
    process: { execPath: process.execPath }, JSON, join, fx: { directory: owned }, run, file, submitted,
    sid: randomUUID(), turn: randomUUID(), input: chatInput, inputDigest: sha256, IDLE_PLACEHOLDER,
    markerV1: 'ZZ-V1', markerV2: 'ZZ-V2', markerV3: 'ZZ-V3', markerNuevo: 'ZZ-NEW', falla: 'ZZ-FAIL',
  }) as unknown;
  assert.equal(typeof script, 'string', `${provider.id}: provider source must produce text`);
  const text = script as string;
  const path = join(owned, provider.language === 'python' ? 'provider.py' : `provider.${provider.language}`);
  await writeFile(path, text, { mode: 0o700, flag: 'wx' });
  if (provider.id === 'healthy-claude') await writeFile(join(claude, 'double-mode'), 'healthy', { mode: 0o600 });
  if (provider.id === 'timeout-claude') await writeFile(file, '', { mode: 0o600 });
  return { variant, directory: owned, scriptSha256: sha256(text), sourceSha256: sha256(source),
    command: provider.language === 'python' ? ['python3', '-I', '-B', path] : [process.execPath, path, ...(provider.args ?? [])],
    environment: { HOME: home, CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude,
      XDG_CONFIG_HOME: join(home, 'xdg/config'), XDG_DATA_HOME: join(home, 'xdg/data'),
      T2_TRANSCRIPT: file, T2_STATE_FILE: join(owned, 'tui-state.json') } };
}

beforeAll(async () => {
  assert.match(process.env.HOME ?? '', /^\/tmp\/cauce-e2e-home-/u, 'Use scripts/e2e-lab.sh');
  await mkdir(receipts, { recursive: true, mode: 0o700 });
  directory = await mkdtemp(join(tmpdir(), 'zz-canary-a22-composer-'));
  initialHashes = Object.fromEntries(await Promise.all([...new Set([guardFile, 'tests/e2e/v4-a22-composer-frames.test.ts',
    'tests/e2e/v4-a22-composer-probe.py', ...providers.map(provider => provider.source)])]
    .map(async path => [path, sha256(await readFile(path))] as const)));
  console.info('A22_COMPOSER_RECEIPTS', JSON.stringify({ run, receipts }));
});

afterAll(async () => {
  const finalHashes = Object.fromEntries(await Promise.all(Object.keys(initialHashes)
    .map(async path => [path, sha256(await readFile(path))] as const)));
  try {
    await writeFile(join(receipts, 'sources.json'), JSON.stringify({ initialHashes, finalHashes,
      unchanged: JSON.stringify(initialHashes) === JSON.stringify(finalHashes) }, null, 2) + '\n');
    expect(finalHashes).toEqual(initialHashes);
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

describe.sequential('A22: exact synthetic provider frames against the current restart guard in real tmux', () => {
  it.each(providers)('$id preserves drafts and proves its empty composer before and after a turn', async provider => {
    const selected = provider.id === 'cancel-deploy' ? [...variants, 'two_turns_crlf', 'two_turns_crlf_fragmented'] : variants;
    const cases = await Promise.all(selected.map(variant => materialize(provider, variant)));
    const manifest = join(directory, `${provider.id}.json`);
    const result = join(receipts, `${provider.id}.json`);
    await writeFile(manifest, JSON.stringify({ id: provider.id, source: provider.source, harness: provider.harness,
      root: process.cwd(), directory: join(directory, provider.id), ready: provider.ready, input: provider.input,
      expected: provider.expected, placeholder: IDLE_PLACEHOLDER, cases }), { mode: 0o600 });
    await execute('python3', ['-I', '-B', 'tests/e2e/v4-a22-composer-probe.py', manifest, result],
      { timeout: 150_000, maxBuffer: 128 * 1024 });
    const report = JSON.parse(await readFile(result, 'utf8')) as { passed: boolean; cases: unknown[]; cleanup: unknown };
    expect(report.passed, JSON.stringify(report)).toBe(true);
  }, 180_000);
});
