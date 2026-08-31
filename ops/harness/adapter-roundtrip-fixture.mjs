#!/usr/bin/env node

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const prompt = Buffer.concat(chunks).toString('utf8');

const contextMatch = /--- BEGIN TRUSTED DELIVERY CONTEXT ---\n([^\n]+)\n--- END TRUSTED DELIVERY CONTEXT ---/u.exec(prompt);
const nonceMatch = /CAUCE_ADAPTER_ROUNDTRIP_(?:V1|REVIEW|REVIEWED):([a-f0-9]{32})/u.exec(prompt);
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
const validReview = context.sender_alias === 'qa-reviewer'
  && delegatedResult?.from_alias === 'qa-reviewer'
  && delegatedResult?.outcome === 'done'
  && delegatedResult?.untrusted_text === `CAUCE_ADAPTER_ROUNDTRIP_REVIEWED:${nonce}`;
let output;
if (nonce === undefined) {
  output = {
    reply: 'controlled round-trip fixture rejected an unrelated delivery',
    messages: [], status: 'failed', retryable: false, artifacts: [],
  };
} else if (context.self_alias === 'qa-opencode' && context.message_type === 'agent.response' && validReview) {
  output = {
    reply: `CAUCE_ADAPTER_ROUNDTRIP_FINAL:${nonce}`,
    messages: [], status: 'done', retryable: false, artifacts: [],
  };
} else if (context.self_alias === 'qa-opencode' && context.message_type !== 'agent.response') {
  output = {
    reply: 'Delegated the controlled round-trip to qa-reviewer.',
    messages: [{ to: 'qa-reviewer', body: `CAUCE_ADAPTER_ROUNDTRIP_REVIEW:${nonce}` }],
    status: 'done', retryable: false, artifacts: [],
  };
} else if (context.self_alias === 'qa-reviewer' && context.sender_alias === 'qa-opencode'
    && context.message_type === 'agent.message') {
  output = {
    reply: `CAUCE_ADAPTER_ROUNDTRIP_REVIEWED:${nonce}`,
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
