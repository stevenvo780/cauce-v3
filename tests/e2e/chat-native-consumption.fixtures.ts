import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { DeliveryEnvelope } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../../packages/store/src/index.js';
import { ackEnvelope } from '../../packages/store/test/helpers/consumer.js';
import { PasteSessionRunner } from '../../packages/adapter-sdk/src/shared-session/paste-runner.js';
import { codexTranscript } from '../../packages/adapter-sdk/src/shared-session/rollout.js';
import { inputDigest } from '../../packages/adapter-sdk/src/shared-session/consumption.js';
import { CliTmux } from '../../packages/adapter-sdk/src/shared-session/tmux.js';

// Only the provider kernel is synthetic; terminal transport, transcript parsing and fenced ACKs are real.
export async function ackCanonicalConsumption(
  pool: DatabasePool, directory: string, tenant: 'Isa' | 'Jhon', alias: string, marker: string,
) {
  const repository = new CauceRepository(pool);
  const instance = `canonical-consumer-${randomUUID()}`;
  const lease = await repository.acquireLease(tenant, alias, instance, [], 60_000, { takeover: true });
  if (!lease.acquired || lease.epoch === undefined || lease.connection_token === undefined) {
    throw new Error('canonical consumer has no fenced lease');
  }
  const owned = await mkdtemp(join(directory, 'canonical-consumption-'));
  const tmux = new CliTmux(`chat-consumption-${randomUUID()}`, {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: owned, TERM: 'xterm-256color', LANG: 'C.UTF-8',
  });
  try {
    const deliveries = await repository.claimDeliveries(tenant, alias, instance, lease.epoch,
      10, 30_000, 3, {}, lease.connection_token);
    const delivery = deliveries.find((candidate: DeliveryEnvelope) => candidate.body.text === marker);
    if (delivery === undefined) throw new Error('canonical consumer did not claim this root');
    const input = JSON.stringify(delivery);
    const sid = randomUUID(), turn = randomUUID();
    const sessions = join(owned, 'sessions');
    await mkdir(sessions, { mode: 0o700 });
    const file = join(sessions, `rollout-now-${sid}.jsonl`);
    const submitted = join(owned, 'submitted.json');
    const kernel = join(owned, 'chat-codex-kernel.mjs');
    const reply = `respuesta con consumo comprobado ${marker}`;
    await writeFile(kernel, `#!${process.execPath}
import { createHash } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
const file=${JSON.stringify(file)},sid=${JSON.stringify(sid)},turn=${JSON.stringify(turn)};
const line=(type,payload)=>JSON.stringify({type,payload});
appendFileSync(file,line('session_meta',{id:sid,source:'cli'})+'\\n',{mode:0o600,flag:'wx'});
if(!process.stdin.isTTY)throw new Error('Synthetic kernel requires a real terminal');
process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');
process.stdout.write('\\x1b[?2004h› ');
let received='',finished=false;
for await(const chunk of process.stdin){
 if(finished)continue;
 received+=chunk;if(Buffer.byteLength(received)>1048576)throw new Error('Native input budget exceeded');
 const start=received.indexOf('\\x1b[200~'),end=received.indexOf('\\x1b[201~');
 if(start<0||end<start||!/[\\r\\n]/u.test(received.slice(end+6)))continue;
 const text=received.slice(start+6,end).replace(/\\r\\n?/gu,'\\n'),original=text.split('\\n')[0];
 if(createHash('sha256').update(original).digest('hex')!==${JSON.stringify(inputDigest(input))})throw new Error('Native terminal input differs from the claimed delivery');
 const delivery=JSON.parse(original),correlation=/"cauce_correlation_id":"([a-f0-9]{64})"/u.exec(text)?.[1];
 if(correlation===undefined)throw new Error('Native input has no local correlation nonce');
 const final=JSON.stringify({reply:'respuesta con consumo comprobado '+delivery.body.text,messages:[],notify:[],status:'done',retryable:false,artifacts:[],cauce_correlation_id:correlation});
 appendFileSync(file,[line('event_msg',{type:'task_started',turn_id:turn}),line('response_item',{type:'message',role:'user',content:[{type:'input_text',text}],internal_chat_message_metadata_passthrough:{turn_id:turn}}),line('event_msg',{type:'task_complete',turn_id:turn,last_agent_message:final})].join('\\n')+'\\n');
 writeFileSync(${JSON.stringify(submitted)},JSON.stringify({input_sha256:${JSON.stringify(inputDigest(input))},correlation}),{mode:0o600,flag:'wx'});
 finished=true;process.stdout.write('\\r\\n› ');
}
`, { mode: 0o700, flag: 'wx' });
    const notices: string[] = [];
    const runner = new PasteSessionRunner({ alias, harness: 'codex', command: kernel, workspace: owned,
      transcript: codexTranscript(owned), tmux, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      acquireTimeoutMs: 5_000, turnTimeoutMs: 15_000, injectTimeoutMs: 5_000, settleMs: 100, pollMs: 50, readyTimeoutMs: 5_000,
      onDegradation: (notice) => { notices.push(notice.detail); } });
    const output = await runner.run({ harness: 'codex', command: kernel, args: [], stdin: input,
      timeoutMs: 15_000, signal: new AbortController().signal });
    expect(output, JSON.stringify({ notices, stderr: output.stderr })).toMatchObject({ exitCode: 0, cancelled: false, timedOut: false });
    expect(JSON.parse(await readFile(submitted, 'utf8')) as unknown).toMatchObject({ input_sha256: inputDigest(input) });
    const witness = output.consumptionWitness;
    expect(witness).toEqual({ version: 1, harness_id: 'codex', native_session_id: sid,
      native_turn_id: turn, input_sha256: inputDigest(input), evidence_kind: 'canonical_final_response' });
    if (witness === undefined) throw new Error('canonical native turn did not prove consumption');
    const ack = ackEnvelope(delivery, { instanceId: instance, epoch: lease.epoch }, {
      output: { reply, messages: [], notify: [], status: 'done', retryable: false, artifacts: [] },
      harness_consumption_v1: witness,
    });
    expect(await repository.ackDelivery(delivery.delivery_id, tenant, alias, ack))
      .toMatchObject({ applied: true, status: 'done' });
    const rows = await pool.query<{ applied: boolean; attempt: number; witness: unknown }>(
      `SELECT applied,attempt,payload->'result'->'harness_consumption_v1' AS witness
         FROM delivery_acks WHERE delivery_id=$1 AND event_id=$2`, [delivery.delivery_id, ack.event_id]);
    expect(rows.rows).toEqual([{ applied: true, attempt: delivery.attempt, witness }]);
    return { reply, witness, deliveryId: delivery.delivery_id };
  } finally {
    try {
      await tmux.run(['kill-server']);
      expect((await tmux.run(['list-sessions'])).exitCode, 'Owned native tmux server remained after cleanup').not.toBe(0);
    } finally {
      try { await repository.releaseLease(tenant, alias, instance, lease.epoch, lease.connection_token); }
      finally { await rm(owned, { recursive: true, force: true }); }
    }
  }
}
