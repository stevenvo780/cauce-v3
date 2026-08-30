import assert from "node:assert/strict";
import test from "node:test";
import type {Delivery} from '../src/sdk/types.js';
import {ControlledRunner, SUCCESS, claimToken, conversation, delivery, originless, sessionOf, setup} from './engine-fixtures.js';
test("two authenticated conversations never share a session, whatever the untrusted label says", async () => {
  const context = await setup("engine-tenant-session");
  const steven: Delivery = {
    ...delivery("tenant-session-a"),
    ...conversation({ conversationId: "6979524541" }),
    body: { prompt: "perform the task", session_key: "same-label" },
  };
  const miguel: Delivery = {
    ...delivery("tenant-session-b"),
    tenant_id: "Miguel",
    ...conversation({ conversationId: "-1003969325671" }),
    body: { prompt: "perform the task", session_key: "same-label" },
  };
  await context.engine.handleDelivery(steven);
  await context.engine.handleDelivery(miguel);
  assert.notEqual(sessionOf(context.runner, 0), sessionOf(context.runner, 1));
});

/**
 * The console and ops tools publish WITHOUT `origin`: until now that meant there was no key
 * and every delivery ran without continuity (243 console publications in prod at
 * 2026-07-29, 0 with origin). The conversation is the authenticated actor, and the tenant is
 * part of it: two different tenants on the same surface do not touch each other.
 */
test("originless publishes are isolated per authenticated tenant", async () => {
  const context = await setup("engine-console-tenant");
  const steven = originless(delivery("console-tenant-a"), "console-steven");
  const pablo: Delivery = {
    ...originless(delivery("console-tenant-b"), "console-pablo"),
    tenant_id: "Pablo",
  };
  await context.engine.handleDelivery(steven);
  await context.engine.handleDelivery(pablo);
  assert.notEqual(sessionOf(context.runner, 0), sessionOf(context.runner, 1));
});

/**
 * Point 4: the console has to converge on ONE conversation per operator. The `session_id` of
 * an OIDC principal is the login's `sid` and changes on every re-login; if it entered the
 * key, the console would start a new session every time Steven logs in again.
 */
test("console keeps one session per operator across re-login", async () => {
  const context = await setup("engine-console-relogin");
  await context.engine.handleDelivery(originless(delivery("console-login-a"), "sid-primer-login"));
  await context.engine.handleDelivery(originless(delivery("console-login-b"), "sid-segundo-login"));
  assert.equal(sessionOf(context.runner, 0), sessionOf(context.runner, 1));
});

/**
 * The store fabricates `delivery:<id>:attempt:<n>` when the root message arrived without an
 * authenticated session. That identifier is per DELIVERY: if it entered the key it would
 * yield one native session per delivery, which is exactly the bug this change fixes.
 */
test("per-delivery synthetic session ids never fragment the conversation", async () => {
  const context = await setup("engine-ephemeral-session-id");
  await context.engine.handleDelivery(
    originless(delivery("ephemeral-a"), "delivery:11111111-1111-4111-8111-111111111111:attempt:1", "agent-output"),
  );
  await context.engine.handleDelivery(
    originless(delivery("ephemeral-b"), "delivery:22222222-2222-4222-8222-222222222222:attempt:1", "agent-output"),
  );
  assert.equal(sessionOf(context.runner, 0), sessionOf(context.runner, 1));
});

/**
 * The tenant that separates is the RECIPIENT's, taken from the adapter's local configuration
 * and not traveling in the delivery. Nobody on the other side of the bus can move it.
 */
test("recipient tenant scopes the session and is taken from local configuration", async () => {
  const steven = await setup("engine-recipient-tenant-steven", new ControlledRunner(), {
    ownTenantId: "Steven",
  });
  const miguel = await setup("engine-recipient-tenant-miguel", new ControlledRunner(), {
    ownTenantId: "Miguel",
  });
  const shared = { ...delivery("recipient-tenant"), ...conversation({ conversationId: "6979524541" }) };
  await steven.engine.handleDelivery(shared);
  await miguel.engine.handleDelivery(shared);
  assert.notEqual(sessionOf(steven.runner, 0), sessionOf(miguel.runner, 0));
});

/**
 * The measured repair: in prod there are 6 Telegram conversations whose old rows do not
 * bring `bridge_tenant` and the new ones do. Same chat, same bot, same alias, two native
 * sessions. The BRIDGE's tenant does not identify any conversation and cannot split it.
 */
test("bridge tenant no longer splits one conversation in two", async () => {
  const context = await setup("engine-bridge-tenant-merge");
  const legacy: Delivery = {
    ...delivery("bridge-tenant-legacy"),
    ...conversation({ conversationId: "6979524541", metadata: {} }),
  };
  const current: Delivery = {
    ...delivery("bridge-tenant-current"),
    ...conversation({
      conversationId: "6979524541",
      metadata: { bridge_alias: "zeus", bridge_tenant: "Steven", chat_type: "private" },
    }),
  };
  await context.engine.handleDelivery(legacy);
  await context.engine.handleDelivery(current);
  assert.equal(sessionOf(context.runner, 0), sessionOf(context.runner, 1));
});

/**
 * Before, this required that a cross-tenant `agent.response` fell into the SAME native
 * session as the human's request. That equality was exactly the blocker: the session lock
 * is strict FIFO, so the delegation's reply kept the conversation's session for its entire
 * run and the owner waited behind it (114 min median on midas). Now agent-to-agent traffic
 * lives in its own lane and the two can run at the same time.
 *
 * What this test STILL protects, which is the reason it exists: the session scope is
 * governed by the CONVERSATION, not the delivery's tenant. Two replies arriving from
 * different tenants on the same conversation must share a session; the only thing that
 * changed is which one.
 *
 * 2026-07-29: before, that scope came from `origin.metadata.bridge_tenant`, falling back to
 * `delivery.tenant_id` when missing — meaning the same chat was split in two depending on
 * who published. Now neither enters the key, and the equality below holds by construction,
 * not by coincidence.
 */
test("the conversation, not the delivery tenant, keeps cross-tenant agent responses in one shared agent-lane session", async () => {
  const context = await setup("engine-agent-response-session");
  const root = delivery("agent-response-session-a");
  const trustedOrigin = {
    ...root.origin!,
    metadata: { bridge_alias: "jarvis", bridge_tenant: "Steven" },
  };
  const rootContext = root.authenticated_context!;
  const request: Delivery = {
    ...root,
    actor_alias: "jarvis",
    recipient_alias: "jarvis",
    origin: trustedOrigin,
    authenticated_context: {
      ...rootContext,
      origin: trustedOrigin,
    },
  };
  const response: Delivery = {
    ...delivery("agent-response-session-b"),
    tenant_id: "Pablo",
    actor_alias: "seneca",
    recipient_alias: "jarvis",
    body: { type: "agent.response", text: "seneca result" },
    origin: trustedOrigin,
    authenticated_context: {
      ...rootContext,
      origin: trustedOrigin,
    },
  };
  const otherTenantResponse: Delivery = {
    ...response,
    delivery_id: "agent-response-session-c",
    event_id: "agent-response-session-c",
    tenant_id: "Miguel",
  };

  await context.engine.handleDelivery(request);
  await context.engine.handleDelivery(response);
  await context.engine.handleDelivery(otherTenantResponse);
  const humanSession = context.runner.requests[0]?.args.at(-1);
  const agentSession = context.runner.requests[1]?.args.at(-1);
  const otherTenantSession = context.runner.requests[2]?.args.at(-1);
  assert.ok(humanSession && agentSession && otherTenantSession);
  // The agent lane is NOT the human's session: that is what gives availability back to the
  // owner without canceling the long-running task.
  assert.notEqual(agentSession, humanSession);
  // But it is still ONE session per conversation, derived from the trusted bridge_tenant:
  // the delivery's tenant does not split it in two.
  assert.equal(otherTenantSession, agentSession);
  assert.match(context.runner.requests[1]?.stdin ?? "", /"message_type":"agent.response"/u);
  assert.match(context.runner.requests[1]?.stdin ?? "", /"sender_alias":"seneca"/u);
});

test("body session_key cannot select a different authenticated session", async () => {
  const context = await setup("engine-untrusted-session-key");
  const first: Delivery = {
    ...delivery("untrusted-session-a"),
    body: { prompt: "perform the task", session_key: "attacker-label-a" },
  };
  const second: Delivery = {
    ...delivery("untrusted-session-b"),
    body: { prompt: "perform the task", session_key: "attacker-label-b" },
  };
  await context.engine.handleDelivery(first);
  await context.engine.handleDelivery(second);
  assert.equal(context.runner.requests[0]?.args.at(-1), context.runner.requests[1]?.args.at(-1));
});

test("stale claim token neither executes nor acknowledges the current event", async () => {
  const context = await setup("engine-stale-claim");
  const current = delivery("stale-claim", 1, 1);
  await context.engine.handleDelivery(current);
  const terminal = context.store.pendingEvents().find((event) => event.phase === "done");
  assert.ok(terminal);
  assert.equal(await context.store.acknowledge({ ...terminal, claim_token: claimToken(1, 1) }), false);
  assert.equal(context.store.pendingEvents().some((event) => event.event_id === terminal.event_id), true);

  await context.engine.handleDelivery(delivery("stale-claim", 1, 1, claimToken(1, 1)));
  assert.equal(context.runner.calls, 1);
});

/**
 * This test demanded the opposite since 44521b6:
 * "attempts 1 and 2 must have different session IDs".
 * happened in 1499 of 5312 deliveries (28.2%): the retry replied to the person from a session
 * with no memory — the symptom "instances duplicate" — and worse, that session accumulated a
 * real exchange that the main session would never see.
 *
 * What 44521b6 wanted to curb (the transcript growing on every retry, socrates ~300K →
 * 1.8MB in 4 attempts) is the case "the previous attempt died mid-execution", and that one is
 * fenced by `DurableStore.accept` since e5c909e: a higher attempt is only accepted if the
 * previous one ended in `failed` with `retryable: true` — see the test "crash recovery marks
 * started work ambiguous and blocks automatic redelivery", which checks it does not even run.
 */
test("a retry of the same conversation keeps the same session", async () => {
  const runner = new ControlledRunner();
  runner.stdout = JSON.stringify({
    reply: "temporary outage",
    messages: [],
    status: "failed",
    retryable: true,
    artifacts: [],
  });
  const context = await setup("engine-session-retry-v3", runner);
  const attempt1 = delivery("session-retry-v3", 1, 1);
  const attempt2 = delivery("session-retry-v3", 1, 2);

  await context.engine.handleDelivery(attempt1);
  assert.equal(runner.calls, 1, "el primer intento tiene que ejecutar");

  runner.stdout = SUCCESS;
  await context.engine.handleDelivery(attempt2);
  assert.equal(runner.calls, 2, "el reintento tiene que ejecutar");

  assert.equal(
    sessionOf(context.runner, 0),
    sessionOf(context.runner, 1),
    "un reintento de la misma conversación no puede estrenar sesión: le contestaría a la persona sin memoria",
  );
});

/**
 * The NEXT message from the same person, in the same chat, also lands in that session — which
 * is what the owner perceives as "it's the same one, it remembers". Before it didn't: the
 * retry went to a session of its own and the next message went back to attempt 1's session,
 * so the two diverged.
 */
test("the next message of the same conversation lands in the session the retry used", async () => {
  const runner = new ControlledRunner();
  runner.stdout = JSON.stringify({
    reply: "temporary outage",
    messages: [],
    status: "failed",
    retryable: true,
    artifacts: [],
  });
  const context = await setup("engine-session-retry-continuity", runner);
  const chat = conversation({ conversationId: "6979524541" });
  await context.engine.handleDelivery({ ...delivery("retry-continuity-a", 1, 1), ...chat });
  runner.stdout = SUCCESS;
  await context.engine.handleDelivery({ ...delivery("retry-continuity-a", 1, 2), ...chat });
  await context.engine.handleDelivery({ ...delivery("retry-continuity-b", 1, 1), ...chat });

  assert.equal(runner.calls, 3);
  assert.equal(sessionOf(context.runner, 0), sessionOf(context.runner, 2));
  assert.equal(sessionOf(context.runner, 1), sessionOf(context.runner, 2));
});

