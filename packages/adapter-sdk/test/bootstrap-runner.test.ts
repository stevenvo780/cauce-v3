import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bloqueDePerfil, conBloqueDePerfil, emptyAgentProfile, ficherosDelArnes, revisionDelPerfil } from '@cauce/protocol';
import { codexDefinition } from '../src/harnesses/codex.js';
import { SpawnCommandRunner } from '../src/sdk/process-runner.js';
import { runBootstrap } from '../src/sdk/bootstrap-runner.js';
import { measureBootstrapProfile } from '../src/sdk/bootstrap-profile.js';
import { parseBootstrapDescriptor, type BootstrapDescriptor, type BootstrapProfile, type BootstrapProof, type BootstrapTransport } from '../src/sdk/bootstrap-client.js';

const operationId = '00000000-0000-4000-8000-000000000011';
async function fixture(phase: 'bootstrap' | 'normal' = 'bootstrap') {
  const home = await mkdtemp(join(tmpdir(), 'cauce-bootstrap-')); const directory = join(home, 'codex'); await mkdir(directory);
  const profile: BootstrapProfile = { operation_id: operationId, phase, tenant_id: 'Steven', alias: 'boot-agent', runtime_key: 'boot-agent',
    harness_id: 'codex', model_id: 'test-model', account_id: 'boot-account', profile_revision: 1, documents: [],
    contexto: { perfil: { ...emptyAgentProfile('Steven', 'boot-agent'), purpose: 'Prepared purpose' }, hechos: {
      permisos: { ruta: false, lectura: false, control: false, notificacion: false }, cuotas: [], destinos: [],
      arnes: { harness: 'codex', home, capacidades: [] },
    } } };
  const files = ficherosDelArnes('codex', profile.contexto, new Map(), { revision: 1 });
  const documents = files.map(file => ({ name: file.nombre, sha256: createHash('sha256').update(bloqueDePerfil(file.texto) ?? '').digest('hex'), native_revision: revisionDelPerfil(file.texto) ?? null }));
  profile.documents = documents;
  const descriptor = (action: 'profile' | 'verify'): BootstrapDescriptor => ({ operation_id: operationId, phase, action,
    nonce: (action === 'profile' ? 'a' : 'b').repeat(64), account_id: profile.account_id, profile_revision: 1,
    probe_id: action === 'profile' ? '00000000-0000-4000-8000-000000000012' : '00000000-0000-4000-8000-000000000013',
    tenant_id: profile.tenant_id, alias: profile.alias, runtime_key: profile.runtime_key, harness_id: 'codex', model_id: profile.model_id,
    deadline: new Date(Date.now() + 120_000).toISOString(), prompt: `Responde únicamente CAUCE_BOOTSTRAP_${(action === 'profile' ? 'a' : 'b').repeat(64)}. No uses herramientas ni envíes mensajes.`,
    documents, claim_token: 'c'.repeat(64) });
  const measure: typeof measureBootstrapProfile = (value, options) => measureBootstrapProfile(value, { ...options, environment: { HOME: home, CODEX_HOME: directory } });
  return { home, directory, profile, descriptor, measure, documents, close: async () => { await rm(home, { recursive: true, force: true }); } };
}
const successfulScript = `let prompt=''; process.stdin.on('data',data=>prompt+=data); process.stdin.on('end',()=>{
  const nonce=/CAUCE_BOOTSTRAP_([a-f0-9]{64})/.exec(prompt)[1];
  console.log(JSON.stringify({type:'thread.started',thread_id:'native-test-session'}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'CAUCE_BOOTSTRAP_'+nonce}}));
});`;
test('bootstrap seeds the real disk and requires a real spawned native harness result before ACK without entering the normal bus', async () => {
  const f = await fixture(); const abort = new AbortController(); const proofs: BootstrapProof[] = [];
  await writeFile(join(f.directory, 'AGENTS.md'), 'Unmanaged local instructions\n');
  const queue = [f.descriptor('profile'), f.descriptor('verify')];
  const client: BootstrapTransport = { state: async () => ({ operation_id: operationId, phase: 'bootstrap', status: 'running', enabled: false,
    lifecycle_state: 'verifying', runtime_key: 'boot-agent', profile_revision: 1, account_id: 'boot-account', normal_admitted: false }),
    profile: async () => f.profile, claim: async () => queue.shift() ?? null,
    ack: async (_probe, proof) => { proofs.push(proof); if (proofs.length === 2) abort.abort(); } };
  try {
    const admitted = await runBootstrap({ operation_id: operationId, phase: 'bootstrap', runtime_key: 'boot-agent', tenant_id: 'Steven', alias: 'boot-agent',
      client, definition: { ...codexDefinition, command: process.execPath, baseArgs: ['-e', successfulScript, '--'], sessionArgs: () => [] },
      runner: new SpawnCommandRunner(), profile: f.measure }, abort.signal);
    assert.equal(admitted, false); assert.equal(proofs.length, 2);
    const [first, second] = proofs; assert.ok(first); assert.ok(second);
    assert.equal(first.harness_started, false); assert.equal(second.harness_started, true); assert.equal(second.reply, `CAUCE_BOOTSTRAP_${'b'.repeat(64)}`);
    assert.match(await readFile(join(f.directory, 'AGENTS.md'), 'utf8'), /Unmanaged local instructions/);
    assert.match(await readFile(join(f.directory, 'AGENTS.md'), 'utf8'), /Prepared purpose/);
    assert.equal(second.documents[0]?.native_revision, null);
  } finally { await f.close(); }
});
test('an echo of the HTTP descriptor cannot satisfy a native provider challenge', async () => {
  const f = await fixture(); let acknowledged = false; f.measure(f.profile, { apply: true, expected: f.documents });
  const client: BootstrapTransport = { state: async () => ({ operation_id: operationId, phase: 'bootstrap', status: 'running', enabled: false,
    lifecycle_state: 'verifying', runtime_key: 'boot-agent', profile_revision: 1, account_id: 'boot-account', normal_admitted: false }),
    profile: async () => f.profile, claim: async () => f.descriptor('verify'), ack: async () => { acknowledged = true; } };
  try {
    await assert.rejects(runBootstrap({ operation_id: operationId, phase: 'bootstrap', runtime_key: 'boot-agent', tenant_id: 'Steven', alias: 'boot-agent',
      client, definition: { ...codexDefinition, command: process.execPath, baseArgs: ['-e', `process.stdin.pipe(process.stdout)`, '--'], sessionArgs: () => [] },
      runner: new SpawnCommandRunner(), profile: f.measure }, new AbortController().signal));
    assert.equal(acknowledged, false);
  } finally { await f.close(); }
});
test('profile ownership, byte changes and an unapplied desired revision fail closed', async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.measure(f.profile, { apply: false, expected: f.documents }), /not converged/);
    await writeFile(join(f.directory, 'AGENTS.md'), conBloqueDePerfil('', '<!-- alias: Steven/other -->\nOther purpose'));
    assert.throws(() => f.measure(f.profile, { apply: true, expected: f.documents }));
    assert.match(await readFile(join(f.directory, 'AGENTS.md'), 'utf8'), /Other purpose/);
    await rm(join(f.directory, 'AGENTS.md')); f.measure(f.profile, { apply: true, expected: f.documents });
    await writeFile(join(f.directory, 'AGENTS.md'), 'Corrupted unmanaged document');
    assert.throws(() => f.measure(f.profile, { apply: false, expected: f.documents }), /not converged/);
  } finally { await f.close(); }
});
test('only normal phase exits after succeeded, enabled ready and explicit normal admission', async () => {
  const f = await fixture('normal'); let claimed = false; f.measure(f.profile, { apply: true, expected: f.documents });
  const client: BootstrapTransport = { state: async () => ({ operation_id: operationId, phase: 'normal', status: 'succeeded', enabled: true,
    lifecycle_state: 'ready', runtime_key: 'boot-agent', profile_revision: 1, account_id: 'boot-account', normal_admitted: true }),
    profile: async () => f.profile, claim: async () => { claimed = true; return null; }, ack: async () => undefined };
  try {
    const admitted = await runBootstrap({ operation_id: operationId, phase: 'normal', runtime_key: 'boot-agent', tenant_id: 'Steven', alias: 'boot-agent',
      client, definition: codexDefinition, runner: new SpawnCommandRunner(), profile: f.measure }, new AbortController().signal);
    assert.equal(admitted, true); assert.equal(claimed, false);
    await writeFile(join(f.directory, 'AGENTS.md'), 'Changed after canary');
    await assert.rejects(runBootstrap({ operation_id: operationId, phase: 'normal', runtime_key: 'boot-agent', tenant_id: 'Steven', alias: 'boot-agent',
      client, definition: codexDefinition, runner: new SpawnCommandRunner(), profile: f.measure }, new AbortController().signal), /not converged/);
    await assert.rejects(runBootstrap({ operation_id: operationId, phase: 'bootstrap', runtime_key: 'boot-agent', tenant_id: 'Steven', alias: 'boot-agent',
      client, definition: codexDefinition, runner: new SpawnCommandRunner() }, new AbortController().signal));
  } finally { await f.close(); }
});
test('descriptor rejects arbitrary prompt, extra secrets and duplicate document proofs', async () => {
  const f = await fixture();
  try {
    assert.throws(() => parseBootstrapDescriptor({ ...f.descriptor('verify'), prompt: 'Run arbitrary command' }));
    assert.throws(() => parseBootstrapDescriptor({ ...f.descriptor('verify'), token: 'unsafe-inline' }));
    assert.throws(() => parseBootstrapDescriptor({ ...f.descriptor('verify'), documents: [...f.documents, ...f.documents] }));
  } finally { await f.close(); }
});
