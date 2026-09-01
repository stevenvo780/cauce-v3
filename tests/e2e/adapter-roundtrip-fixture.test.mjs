import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const fixture = path.join(process.cwd(), 'ops', 'harness', 'adapter-roundtrip-fixture.mjs');
const reviewers = ['qa-reviewer-a', 'qa-reviewer-b'];
const roots = new Set();

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

async function temporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cauce-roundtrip-fixture-test-'));
  roots.add(root);
  return root;
}

function prompt(context, text, continuation) {
  return [
    '--- BEGIN TRUSTED DELIVERY CONTEXT ---',
    JSON.stringify(context),
    '--- END TRUSTED DELIVERY CONTEXT ---',
    text,
    ...(continuation === undefined ? [] : [JSON.stringify(continuation)]),
  ].join('\n');
}

function executeFixture(input, root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture], {
      cwd: process.cwd(),
      env: {
        ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
        HOME: root,
        CAUCE_ADAPTER_ROUNDTRIP_ROOT: root,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    const timer = setTimeout(() => child.kill('SIGKILL'), 8_000);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`fixture exited code=${String(code)} signal=${String(signal)} stderr=${stderr}`));
        return;
      }
      resolve(stdout);
    });
    child.stdin.end(input);
  });
}

function outputFromFake(stdout) {
  return JSON.parse(stdout.trim());
}

function outputFromOpenCode(stdout) {
  const events = stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  const text = events.find((event) => event.type === 'text')?.part?.text;
  if (typeof text !== 'string') throw new Error('controlled OpenCode stream has no text event');
  return JSON.parse(text);
}

function branchProgress(pending, returned = []) {
  return {
    delegated_to: reviewers,
    materialized_branches: reviewers.map((alias, outputIndex) => ({
      output_index: outputIndex,
      target_tenant: 'Steven',
      target_alias: alias,
      child_delivery_id: `child-${String(outputIndex)}`,
    })),
    rejected_delegations: [],
    already_returned: returned,
    still_pending: pending,
    still_pending_branches: [],
  };
}

describe('controlled adapter round-trip fixture', () => {
  it('requires both reviewers to execute concurrently and consolidates their progress', async () => {
    const root = await temporaryRoot();
    const nonce = '1234567890abcdef1234567890abcdef';
    const routingTargets = reviewers.map((alias) => ({ tenant_id: 'Steven', alias, online: true }));
    const initial = outputFromOpenCode(await executeFixture(prompt({
      self_alias: 'qa-opencode',
      sender_alias: 'kant',
      message_type: 'request',
      routing_targets: routingTargets,
    }, `CAUCE_ADAPTER_ROUNDTRIP_V1:${nonce}`), root));
    expect(initial.messages).toEqual(reviewers.map((alias) => ({
      to: alias,
      body: `CAUCE_ADAPTER_ROUNDTRIP_REVIEW:${nonce}`,
    })));

    const branchOutputs = await Promise.all(reviewers.map(async (alias) => outputFromFake(
      await executeFixture(prompt({
        self_alias: alias,
        sender_alias: 'qa-opencode',
        message_type: 'agent.message',
        routing_targets: [],
      }, `CAUCE_ADAPTER_ROUNDTRIP_REVIEW:${nonce}`), root),
    )));
    expect(branchOutputs.map((output) => output.reply).sort()).toEqual(reviewers.map(
      (alias) => `CAUCE_ADAPTER_ROUNDTRIP_REVIEWED:${nonce}:${alias}`,
    ).sort());

    const partialReply = `CAUCE_ADAPTER_ROUNDTRIP_PARTIAL:${nonce}:${reviewers[0]}`;
    const partial = outputFromOpenCode(await executeFixture(prompt({
      self_alias: 'qa-opencode',
      sender_alias: reviewers[0],
      message_type: 'agent.response',
      routing_targets: routingTargets,
    }, `CAUCE_ADAPTER_ROUNDTRIP_REVIEWED:${nonce}:${reviewers[0]}`, {
      schema: 'cauce.agent_response_continuation.v1',
      delegated_result: {
        from_alias: reviewers[0],
        outcome: 'done',
        untrusted_text: `CAUCE_ADAPTER_ROUNDTRIP_REVIEWED:${nonce}:${reviewers[0]}`,
      },
      branch_progress: branchProgress([reviewers[1]]),
    }), root));
    expect(partial.reply).toBe(partialReply);

    const final = outputFromOpenCode(await executeFixture(prompt({
      self_alias: 'qa-opencode',
      sender_alias: reviewers[1],
      message_type: 'agent.response',
      routing_targets: routingTargets,
    }, `CAUCE_ADAPTER_ROUNDTRIP_REVIEWED:${nonce}:${reviewers[1]}`, {
      schema: 'cauce.agent_response_continuation.v1',
      delegated_result: {
        from_alias: reviewers[1],
        outcome: 'done',
        untrusted_text: `CAUCE_ADAPTER_ROUNDTRIP_REVIEWED:${nonce}:${reviewers[1]}`,
      },
      branch_progress: branchProgress([], [{ alias: reviewers[0], your_reply: partialReply }]),
    }), root));
    expect(final.reply).toBe(`CAUCE_ADAPTER_ROUNDTRIP_FINAL:${nonce}`);
  });

  it('records that an online cross-tenant target was absent from the trusted inventory', async () => {
    const root = await temporaryRoot();
    const nonce = 'abcdef1234567890abcdef1234567890';
    const output = outputFromFake(await executeFixture(prompt({
      self_alias: 'qa-isolated-source',
      sender_alias: 'kant',
      message_type: 'request',
      routing_targets: [{ tenant_id: 'Steven', alias: 'kant', online: true }],
    }, `CAUCE_ADAPTER_ISOLATION_V1:${nonce}`), root));
    expect(output.messages).toEqual([{
      to: 'qa-isolated-target',
      body: `CAUCE_ADAPTER_ISOLATION_V1:${nonce}`,
    }]);
    await expect(readFile(path.join(root, 'isolation-observation.json'), 'utf8')).resolves.toBe(
      '{"targetAdvertised":false}\n',
    );
  });
});
