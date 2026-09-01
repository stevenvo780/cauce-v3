#!/usr/bin/env node

import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const reviewerAliases = ['qa-reviewer-a', 'qa-reviewer-b'];
const isolationSource = 'qa-isolated-source';
const isolationTarget = 'qa-isolated-target';

function roundTripRoot() {
  const root = process.env.TMPDIR;
  if (root === undefined || !path.isAbsolute(root)) {
    throw new Error('controlled round-trip fixture requires an absolute temporary root');
  }
  return root;
}

async function waitForConcurrentReviewers(alias) {
  const barrier = path.join(roundTripRoot(), 'fanout-barrier');
  await mkdir(barrier, { recursive: true, mode: 0o700 });
  await writeFile(path.join(barrier, alias), 'ready\n', { mode: 0o600 });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const present = await Promise.all(reviewerAliases.map((reviewer) => (
      access(path.join(barrier, reviewer)).then(() => true, () => false)
    )));
    if (present.every(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('controlled fan-out reviewers did not overlap at the execution barrier');
}

async function recordIsolationObservation(context) {
  const advertised = Array.isArray(context.routing_targets)
    && context.routing_targets.some((target) => target?.alias === isolationTarget);
  await writeFile(
    path.join(roundTripRoot(), 'isolation-observation.json'),
    `${JSON.stringify({ targetAdvertised: advertised })}\n`,
    { mode: 0o600 },
  );
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const prompt = Buffer.concat(chunks).toString('utf8');

const contextMatch = /--- BEGIN TRUSTED DELIVERY CONTEXT ---\n([^\n]+)\n--- END TRUSTED DELIVERY CONTEXT ---/u.exec(prompt);
const nonceMatch = /CAUCE_ADAPTER_ROUNDTRIP_(?:V1|REVIEW|REVIEWED):([a-f0-9]{32})/u.exec(prompt);
const isolationNonceMatch = /CAUCE_ADAPTER_ISOLATION_V1:([a-f0-9]{32})/u.exec(prompt);
let context = {};
try {
  context = contextMatch === null ? {} : JSON.parse(contextMatch[1]);
} catch {
  context = {};
}

const nonce = nonceMatch?.[1];
let continuation;
for (const line of prompt.split(/\r?\n/u)) {
  if (!line.startsWith('{"schema":"cauce.agent_response_continuation.v1"')) continue;
  try {
    continuation = JSON.parse(line);
  } catch {
    continuation = undefined;
  }
}
const delegatedResult = continuation?.delegated_result;
const branchAlias = delegatedResult?.from_alias;
const validReview = reviewerAliases.includes(context.sender_alias)
  && branchAlias === context.sender_alias
  && delegatedResult?.outcome === 'done'
  && delegatedResult?.untrusted_text === `CAUCE_ADAPTER_ROUNDTRIP_REVIEWED:${nonce}:${branchAlias}`;
const progress = continuation?.branch_progress;
const materializedAliases = Array.isArray(progress?.materialized_branches)
  ? progress.materialized_branches.map((branch) => branch?.target_alias).sort()
  : [];
const expectedReviewers = [...reviewerAliases].sort();
const completeFanoutShape = JSON.stringify(materializedAliases) === JSON.stringify(expectedReviewers)
  && JSON.stringify([...(progress?.delegated_to ?? [])].sort()) === JSON.stringify(expectedReviewers)
  && Array.isArray(progress?.rejected_delegations)
  && progress.rejected_delegations.length === 0;
let output;
if (isolationNonceMatch !== null && context.self_alias === isolationSource
    && context.message_type !== 'agent.response') {
  await recordIsolationObservation(context);
  output = {
    reply: 'Attempted the controlled cross-tenant delegation.',
    messages: [{ to: isolationTarget, body: `CAUCE_ADAPTER_ISOLATION_V1:${isolationNonceMatch[1]}` }],
    status: 'done', retryable: false, artifacts: [],
  };
} else if (isolationNonceMatch !== null && context.self_alias === isolationTarget) {
  await writeFile(path.join(roundTripRoot(), 'isolation-target-hit'), 'unexpected\n', { mode: 0o600 });
  output = {
    reply: `CAUCE_ADAPTER_ISOLATION_BREACH:${isolationNonceMatch[1]}`,
    messages: [], status: 'failed', retryable: false, artifacts: [],
  };
} else if (nonce === undefined) {
  output = {
    reply: 'controlled round-trip fixture rejected an unrelated delivery',
    messages: [], status: 'failed', retryable: false, artifacts: [],
  };
} else if (context.self_alias === 'qa-opencode' && context.message_type === 'agent.response' && validReview) {
  const pending = Array.isArray(progress?.still_pending) ? progress.still_pending : [];
  const returned = Array.isArray(progress?.already_returned) ? progress.already_returned : [];
  const otherReviewer = reviewerAliases.find((alias) => alias !== branchAlias);
  const firstBranch = completeFanoutShape
    && pending.length === 1
    && pending[0] === otherReviewer
    && returned.length === 0;
  const finalBranch = completeFanoutShape
    && pending.length === 0
    && returned.length === 1
    && returned[0]?.alias === otherReviewer
    && returned[0]?.your_reply === `CAUCE_ADAPTER_ROUNDTRIP_PARTIAL:${nonce}:${otherReviewer}`;
  output = firstBranch || finalBranch
    ? {
      reply: finalBranch
        ? `CAUCE_ADAPTER_ROUNDTRIP_FINAL:${nonce}`
        : `CAUCE_ADAPTER_ROUNDTRIP_PARTIAL:${nonce}:${branchAlias}`,
      messages: [], status: 'done', retryable: false, artifacts: [],
    }
    : {
      reply: 'controlled round-trip fixture rejected invalid fan-out progress',
      messages: [], status: 'failed', retryable: false, artifacts: [],
    };
} else if (context.self_alias === 'qa-opencode' && context.message_type !== 'agent.response') {
  output = {
    reply: 'Delegated the controlled round-trip to two concurrent reviewers.',
    messages: reviewerAliases.map((alias) => ({
      to: alias,
      body: `CAUCE_ADAPTER_ROUNDTRIP_REVIEW:${nonce}`,
    })),
    status: 'done', retryable: false, artifacts: [],
  };
} else if (reviewerAliases.includes(context.self_alias) && context.sender_alias === 'qa-opencode'
    && context.message_type === 'agent.message') {
  await waitForConcurrentReviewers(context.self_alias);
  output = {
    reply: `CAUCE_ADAPTER_ROUNDTRIP_REVIEWED:${nonce}:${context.self_alias}`,
    messages: [], status: 'done', retryable: false, artifacts: [],
  };
} else {
  output = {
    reply: 'controlled round-trip fixture received an invalid delivery context',
    messages: [], status: 'failed', retryable: false, artifacts: [],
  };
}

if (context.self_alias === 'qa-opencode') {
  const sessionID = 'ses_cauce_adapter_roundtrip';
  process.stdout.write(`${JSON.stringify({ type: 'step_start', sessionID })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: 'text', sessionID, part: { type: 'text', text: JSON.stringify(output) },
  })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'step_finish', sessionID })}\n`);
} else {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}
