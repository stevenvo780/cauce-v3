import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HUMAN_MESSAGE_INITIATOR_CAPABILITY } from '@cauce/protocol';
import { dockerTestRequirement } from '../helpers/postgres.js';
import { humanHarnessSelector, prepareDeliveryInvocation, sessionFromDelivery } from '../../packages/adapter-sdk/src/sdk/engine/delivery-context.js';
import { AdapterEngine } from '../../packages/adapter-sdk/src/sdk/engine.js';
import { DurableStore } from '../../packages/adapter-sdk/src/sdk/durable-store.js';
import { HarnessAdapter } from '../../packages/adapter-sdk/src/harnesses/shared/adapter.js';
import { codexDefinition } from '../../packages/adapter-sdk/src/harnesses/codex.js';
import type {
  CommandRunRequest, CommandRunResult, CommandRunner, Delivery, DeliveryEvent,
} from '../../packages/adapter-sdk/src/sdk/types.js';
import { CauceRepository } from '../../packages/store/src/repository.js';
import { startHumanContextFixture } from './console-human-context-isolation.fixtures.js';
import type { HumanProfileAdapterProcess, HumanProfileCodexFixture } from './human-profile-codex-isolation.fixtures.js';
import { startHumanProfileCodexFixture } from './human-profile-codex-isolation.fixtures.js';

const dockerRequirement = dockerTestRequirement('human initiator identity and Codex profile across PostgreSQL claim, Engine and ACK');
const runCodexTurns = process.env.CAUCE_RUN_HUMAN_PROFILE_CODEX_ISOLATION_E2E === '1';
const contractReviewed = process.env.CAUCE_HUMAN_PROFILE_CODEX_CONTRACT_REVIEWED === '1';

async function withFixtureCleanup<T>(fixture: { close(): Promise<void> }, run: () => Promise<T>): Promise<T> {
  let value!: T;
  let runFailed = false;
  let runError: unknown;
  try {
    value = await run();
  } catch (error) {
    runFailed = true;
    runError = error;
  }

  let cleanupFailed = false;
  let cleanupError: unknown;
  try {
    await fixture.close();
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }

  if (runFailed && cleanupFailed) {
    throw new AggregateError([runError, cleanupError], 'test and fixture cleanup failed');
  }
  if (runFailed) throw runError;
  if (cleanupFailed) throw cleanupError;
  return value;
}

interface CapturedTurn {
  readonly request: CommandRunRequest;
  readonly sessionId: string | undefined;
  readonly context: Record<string, unknown>;
  readonly reply: string;
}

function parseTrustedContext(stdin: string): Record<string, unknown> {
  const match = /--- BEGIN TRUSTED DELIVERY CONTEXT ---\n([\s\S]*?)\n--- END TRUSTED DELIVERY CONTEXT ---/u.exec(stdin);
  if (match?.[1] === undefined) throw new Error('Codex prompt omitted trusted delivery context');
  const value: unknown = JSON.parse(match[1]);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('trusted delivery context is not an object');
  return value as Record<string, unknown>;
}

class DeterministicCodexRunner implements CommandRunner {
  readonly witnessesHarnessStart = true;
  readonly turns: CapturedTurn[] = [];
  private readonly fixture: HumanProfileCodexFixture;

  constructor(fixture: HumanProfileCodexFixture) { this.fixture = fixture; }

  async run(request: CommandRunRequest): Promise<CommandRunResult> {
    const context = parseTrustedContext(request.stdin);
    const initiator = context.human_initiator;
    if (typeof initiator !== 'object' || initiator === null || Array.isArray(initiator)
        || !('human_id' in initiator) || typeof initiator.human_id !== 'string') {
      throw new Error('Engine did not pass the verified human initiator to Codex');
    }
    const humanId = initiator.human_id;
    const reply = humanId;
    this.turns.push({ request, sessionId: request.sessionId, context, reply });
    const nativeId = humanId === this.fixture.humanIds[0] ? 'native-session-human-a' : 'native-session-human-b';
    const output = JSON.stringify({
      reply,
      messages: [],
      notify: [],
      status: 'done',
      retryable: false,
      artifacts: [],
    });
    return {
      stdout: `${JSON.stringify({ type: 'thread.started', thread_id: nativeId })}\n`
        + `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: output } })}\n`,
      stderr: '',
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      harnessStarted: true,
    };
  }
}

class UnexpectedSharedRunner implements CommandRunner {
  async run(_request: CommandRunRequest): Promise<CommandRunResult> {
    throw new Error('durable human delivery reached the shared Codex harness');
  }
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
}

async function processDeterministicTurns(
  fixture: HumanProfileCodexFixture,
  turns: readonly [Awaited<ReturnType<HumanProfileCodexFixture['claimHumanTurns']>>[number],
    Awaited<ReturnType<HumanProfileCodexFixture['claimHumanTurns']>>[number],
    Awaited<ReturnType<HumanProfileCodexFixture['claimHumanTurns']>>[number]],
): Promise<{
  readonly events: readonly DeliveryEvent[];
  readonly runner: DeterministicCodexRunner;
  readonly diagnostics: readonly string[];
}> {
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  const runner = new DeterministicCodexRunner(fixture);
  const storeDirectory = join(fixture.scratch, 'deterministic-adapter-state');
  const events: DeliveryEvent[] = [];
  const diagnostics: string[] = [];
  let engine: AdapterEngine | undefined;
  try {
    process.env.HOME = fixture.profileHome;
    process.env.CODEX_HOME = fixture.codexHome;
    await mkdir(storeDirectory, { recursive: true, mode: 0o700 });
    const store = await DurableStore.open(storeDirectory);
    const headless = new HarnessAdapter({
      definition: codexDefinition,
      runner,
      store,
      sessionNamespace: fixture.alias,
    });
    const shared = new HarnessAdapter({
      definition: codexDefinition,
      runner: new UnexpectedSharedRunner(),
      store,
      sessionNamespace: fixture.alias,
      sharedSession: { alias: fixture.alias, harness: 'codex', stateDirectory: storeDirectory },
    });
    engine = new AdapterEngine({
      store,
      harness: shared,
      harnessForDelivery: humanHarnessSelector(shared, headless),
      ownTenantId: fixture.tenant,
      executionIntentMode: 'local-test-only',
      logger: (entry) => {
        if (entry.event === 'internal_error' && typeof entry.error_message === 'string') diagnostics.push(entry.error_message);
      },
      publish: async (event) => {
        events.push(event);
        const ackResult = event.output === undefined && event.profile_adoption === undefined
          ? undefined
          : {
              ...(event.output === undefined ? {} : { output: event.output }),
              ...(event.profile_adoption === undefined ? {} : { profile_adoption: event.profile_adoption }),
            };
        await new CauceRepository(fixture.database.pool).ackDelivery(
          event.delivery_id, fixture.tenant, fixture.alias, {
            version: '3.0',
            event_id: event.event_id,
            claim_token: event.claim_token,
            attempt: event.attempt,
            status: event.phase,
            instance_id: fixture.instanceId,
            epoch: event.epoch,
            retryable: event.error?.retryable ?? event.output?.retryable ?? false,
            ...(event.execution_started === true ? { execution_started: true } : {}),
            ...(event.error === undefined ? {} : { error: event.error.message, error_code: event.error.code }),
            ...(ackResult === undefined ? {} : { result: ackResult }),
          },
        );
      },
    });
    await engine.activateEpoch(fixture.epoch ?? 1);
    for (const turn of turns) await engine.handleDelivery(turn.delivery);
    return { events, runner, diagnostics };
  } finally {
    try { engine?.stop(); } finally {
      restoreEnvironment('HOME', previousHome);
      restoreEnvironment('CODEX_HOME', previousCodexHome);
    }
  }
}

async function waitForDone(fixture: HumanProfileCodexFixture, deliveryIds: readonly string[]): Promise<void> {
  const deadline = Date.now() + 8 * 60_000;
  while (Date.now() < deadline) {
    const result = await fixture.database.pool.query<{ done: number }>(
      `SELECT count(*)::int AS done FROM deliveries WHERE id=ANY($1::uuid[]) AND status='done'`, [deliveryIds],
    );
    if (result.rows[0]?.done === deliveryIds.length) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error('Codex did not close all three independently claimed human turns before the bounded deadline');
}

interface CodexSqlPostflight {
  readonly messages: { trace_id: string; body: unknown; status: string; output: unknown }[];
  readonly acknowledgements: { delivery_id: string; statuses: string[] }[];
  readonly profile: { revision: string; applied_revision: string | null }[];
  readonly adoptions: {
    revision: string; generation: string; documents: unknown; delivery_id: string; attempt: number;
    instance_id: string; epoch: string; ack_status: string; ack_applied: boolean;
  }[];
}

async function readCodexSqlPostflight(
  fixture: HumanProfileCodexFixture,
  deliveryIds: readonly string[],
): Promise<CodexSqlPostflight> {
  const messages = await fixture.database.pool.query<CodexSqlPostflight['messages'][number]>(
    `SELECT message.trace_id,message.body,delivery.status,delivery.result->'output' AS output
       FROM messages message JOIN deliveries delivery ON delivery.message_id=message.id
      WHERE message.trace_id=ANY($1::text[])
      ORDER BY array_position($1::text[],message.trace_id)`,
    [fixture.traceIds],
  );
  const acknowledgements = await fixture.database.pool.query<CodexSqlPostflight['acknowledgements'][number]>(
    `SELECT delivery_id::text,array_agg(status ORDER BY id) AS statuses FROM delivery_acks
      WHERE delivery_id=ANY($1::uuid[]) GROUP BY delivery_id`,
    [deliveryIds],
  );
  const profile = await fixture.database.pool.query<CodexSqlPostflight['profile'][number]>(
    `SELECT revision::text,applied_revision::text FROM agent_profiles WHERE tenant_id=$1 AND alias=$2`,
    [fixture.tenant, fixture.alias],
  );
  const adoptions = await fixture.database.pool.query<CodexSqlPostflight['adoptions'][number]>(
    `SELECT adoption.revision::text,adoption.generation,adoption.documents,
            adoption.delivery_id::text,adoption.attempt,adoption.instance_id,adoption.epoch::text,
            ack.status AS ack_status,ack.applied AS ack_applied
       FROM agent_profile_runtime_adoptions adoption
       JOIN agent_profile_runtime_expectations expectation
         ON expectation.tenant_id=adoption.tenant_id AND expectation.alias=adoption.alias
        AND expectation.revision=adoption.revision AND expectation.generation=adoption.generation
        AND expectation.documents=adoption.documents
       JOIN delivery_acks ack
         ON ack.delivery_id=adoption.delivery_id AND ack.attempt=adoption.attempt
        AND ack.instance_id=adoption.instance_id AND ack.epoch=adoption.epoch
        AND ack.status='done' AND ack.applied=true
      WHERE adoption.tenant_id=$1 AND adoption.alias=$2
        AND adoption.delivery_id=ANY($3::uuid[])`,
    [fixture.tenant, fixture.alias, deliveryIds],
  );
  return {
    messages: messages.rows,
    acknowledgements: acknowledgements.rows,
    profile: profile.rows,
    adoptions: adoptions.rows,
  };
}

async function insertSyntheticQaAdoption(fixture: HumanProfileCodexFixture, deliveryId: string): Promise<void> {
  const inserted = await fixture.database.pool.query(
    `INSERT INTO agent_profile_runtime_adoptions(
       tenant_id,alias,revision,generation,documents,delivery_id,attempt,instance_id,epoch
     )
     SELECT expectation.tenant_id,expectation.alias,expectation.revision,expectation.generation,
            expectation.documents,delivery.id,delivery.attempt,delivery.consumer_instance_id,delivery.consumer_epoch
       FROM agent_profile_runtime_expectations expectation
       JOIN deliveries delivery ON delivery.recipient_tenant=expectation.tenant_id
                               AND delivery.recipient_alias=expectation.alias AND delivery.id=$3
       JOIN delivery_acks ack ON ack.delivery_id=delivery.id AND ack.attempt=delivery.attempt
                             AND ack.instance_id=delivery.consumer_instance_id
                             AND ack.epoch=delivery.consumer_epoch AND ack.status='done' AND ack.applied=true
      WHERE expectation.tenant_id=$1 AND expectation.alias=$2
     RETURNING delivery_id`,
    [fixture.tenant, fixture.alias, deliveryId],
  );
  expect(inserted.rowCount, 'synthetic QA adoption must bind to one done/applied ACK and its current expectation').toBe(1);
}

function logSafeAdapterEvidence(
  evidence: Awaited<ReturnType<HumanProfileAdapterProcess['stop']>>,
  fixture: HumanProfileCodexFixture,
): void {
  const humanA = createHash('sha256').update(fixture.humanIds[0]).digest('hex');
  const humanB = createHash('sha256').update(fixture.humanIds[1]).digest('hex');
  console.info(JSON.stringify({
    evidence: 'codex-profile-adoption-stop-witness',
    wrapperInvocations: evidence.wrapperInvocations,
    realCliSpawnRequested: evidence.realCliSpawnRequested,
    realCliProcessStarted: evidence.realCliProcessStarted,
    budgetBlocked: evidence.budgetBlocked,
    hostProfileUnchanged: true,
    turns: evidence.turnWitnesses.map(({ slot, humanIdSha256, threadIdSha256, resumeIdSha256 }) => ({
      slot,
      human: humanIdSha256 === humanA ? 'A' : humanIdSha256 === humanB ? 'B' : 'unknown',
      threadIdSha256,
      resumeIdSha256,
    })),
  }));
}

describe('aislamiento de iniciadores humanos y perfil Codex', () => {
  it('preserva el fallo principal y agrega el error de cleanup sin repetir el cierre', async () => {
    const primaryError = new Error('primary assertion failed');
    const cleanupError = new Error('fixture cleanup failed');
    let closeCalls = 0;
    const error = await withFixtureCleanup({
      async close() {
        closeCalls += 1;
        throw cleanupError;
      },
    }, async () => { throw primaryError; }).then(() => undefined, (failure: unknown) => failure);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([primaryError, cleanupError]);
    expect(closeCalls).toBe(1);
  });

  it('conserva el fallo principal cuando el cleanup termina bien', async () => {
    const primaryError = new Error('primary assertion failed');
    let closeCalls = 0;
    const error = await withFixtureCleanup({
      async close() { closeCalls += 1; },
    }, async () => { throw primaryError; }).then(() => undefined, (failure: unknown) => failure);

    expect(error).toBe(primaryError);
    expect(closeCalls).toBe(1);
  });

  it('reporta un fallo de cleanup después de un cuerpo exitoso', async () => {
    const cleanupError = new Error('fixture cleanup failed');
    let closeCalls = 0;
    const error = await withFixtureCleanup({
      async close() {
        closeCalls += 1;
        throw cleanupError;
      },
    }, async () => 'completed').then(() => undefined, (failure: unknown) => failure);

    expect(error).toBe(cleanupError);
    expect(closeCalls).toBe(1);
  });

  it('conserva el initiator Console canónico pese a auditoría ausente, ambigua o body falsificado', async ({ skip }) => {
    await dockerRequirement.skipIfUnavailable(skip);
    const originalAcquire = Reflect.get(CauceRepository.prototype, 'acquireLease');
    const originalClaim = Reflect.get(CauceRepository.prototype, 'claimDeliveries');
    let observed: {
      initiators: number; authorAuditRows: number; consoleSubjects: number; humanInitiators: number; deliveries: Delivery[];
    } | undefined;
    CauceRepository.prototype.acquireLease = function (...args) {
      if (args[3].includes('console_human_scope_v1')) args[3] = [...args[3], HUMAN_MESSAGE_INITIATOR_CAPABILITY];
      return Reflect.apply(originalAcquire, this, args);
    };
    CauceRepository.prototype.claimDeliveries = async function (...args) {
      const deliveries = await Reflect.apply(originalClaim, this, args) as Delivery[];
      if (deliveries.some((delivery) => Object.hasOwn(delivery, 'console_human_subject'))) {
        const ids = deliveries.map(({ message_id }) => message_id);
        const pool = Reflect.get(this, 'pool') as { query: (sql: string, values: unknown[]) => Promise<{ rows: { initiators: number; authors: number }[] }> };
        const result = await pool.query(
          `SELECT (SELECT count(*)::int FROM human_message_initiators WHERE message_id=ANY($1::uuid[])) AS initiators,
                  (SELECT count(DISTINCT message_id)::int FROM audit_events WHERE message_id=ANY($1::uuid[])
                    AND action='message.publish' AND decision='allow' AND metadata ? 'console_author') AS authors`,
          [ids],
        );
        const counts = result.rows[0];
        if (counts === undefined) throw new Error('Console claim ledger query returned no count row');
        observed = {
          initiators: counts.initiators, authorAuditRows: counts.authors,
          consoleSubjects: deliveries.filter((delivery) => Object.hasOwn(delivery, 'console_human_subject')).length,
          humanInitiators: deliveries.filter((delivery) => Object.hasOwn(delivery, 'human_initiator')).length,
          deliveries,
        };
      }
      return deliveries;
    };
    try {
      const fixture = await startHumanContextFixture();
      console.info(JSON.stringify({ evidence: 'console-human-ledger-fixture', postgresContainerId: fixture.containerId }));
      await withFixtureCleanup(fixture, async () => {
        expect(observed).toBeDefined();
        const expectedRoots = [
          ...fixture.publications.map(({ userId, delivery }) => ({ humanId: userId, delivery })),
          ...[fixture.absent, fixture.ambiguous, fixture.forged]
            .map((delivery) => ({ humanId: fixture.publications[0].userId, delivery })),
        ];
        expect(observed?.deliveries.map(({ message_id }) => message_id).sort())
          .toEqual(expectedRoots.map(({ delivery }) => delivery.message_id).sort());
        expect(observed?.initiators).toBe(expectedRoots.length);
        for (const { humanId, delivery } of expectedRoots) {
          expect(delivery.human_initiator).toMatchObject({
            human_id: humanId, tenant_id: 'Isa', root_message_id: delivery.message_id,
          });
          expect(delivery.human_initiator?.conversation_id).toBeTruthy();
        }
        expect(observed?.authorAuditRows).toBe(5);
        expect(observed?.consoleSubjects).toBe(4);
        expect(observed?.humanInitiators).toBe(expectedRoots.length);
        const withConsoleSubject = observed?.deliveries.find((delivery) => delivery.console_human_subject !== undefined);
        if (withConsoleSubject === undefined) throw new Error('Console claim omitted every audited subject');
        expect(withConsoleSubject.human_initiator).toBeDefined();

        const ordinary = { reserveSession: () => ({}) } as unknown as HarnessAdapter;
        const isolatedHuman = { reserveSession: () => ({}), supportsEmissionEndpoint: true } as unknown as HarnessAdapter;
        const ordinaryScope = prepareDeliveryInvocation(
          withConsoleSubject, ordinary, humanHarnessSelector(ordinary, isolatedHuman), 'Isa',
        );
        expect(ordinaryScope.selectionError).toBeUndefined();
        expect(ordinaryScope.harness).toBe(isolatedHuman);
        expect(ordinaryScope.session.sessionKey).toBe(sessionFromDelivery(withConsoleSubject, 'Isa').sessionKey);
        expect(ordinaryScope.session.sessionKey).toMatch(/^auth-v3:/u);
        const oldSharedSession = process.env.CAUCE_SHARED_SESSION;
        process.env.CAUCE_SHARED_SESSION = '1';
        try {
          const invocation = prepareDeliveryInvocation(
            withConsoleSubject, ordinary, humanHarnessSelector(ordinary, isolatedHuman), 'Isa',
          );
          expect(invocation.selectionError).toBeUndefined();
          expect(invocation.harness).toBe(isolatedHuman);
          expect(invocation.session.sessionKey).toBe(ordinaryScope.session.sessionKey);
          expect(invocation.session.sessionKey).not.toBe(`shared:${withConsoleSubject.recipient_alias}`);
          expect(invocation.humanInitiator).toEqual(withConsoleSubject.human_initiator);
          const legacyConsoleInvocation = prepareDeliveryInvocation(
            fixture.legacy, ordinary, humanHarnessSelector(ordinary, isolatedHuman), 'Isa',
          );
          expect(fixture.legacy.authenticated_context?.channel).toBe('console');
          expect(fixture.legacy).not.toHaveProperty('human_initiator');
          expect(legacyConsoleInvocation.selectionError).toBeUndefined();
          expect(legacyConsoleInvocation.harness).toBe(isolatedHuman);
          expect(legacyConsoleInvocation.session.sessionKey).toBe(sessionFromDelivery(fixture.legacy, 'Isa').sessionKey);
          expect(legacyConsoleInvocation.session.sessionKey).toMatch(/^auth-v3:/u);
          expect(legacyConsoleInvocation.session.sessionKey).not.toBe(`shared:${fixture.legacy.recipient_alias}`);
          expect(legacyConsoleInvocation.humanInitiator).toBeUndefined();
        } finally {
          restoreEnvironment('CAUCE_SHARED_SESSION', oldSharedSession);
        }
        expect(fixture.publications).toHaveLength(3);
      });
    } finally {
      CauceRepository.prototype.acquireLease = originalAcquire;
      CauceRepository.prototype.claimDeliveries = originalClaim;
    }
  }, 180_000);

  it('mantiene un runtime profile y separa A1/B1/A2 desde ledger, claim, Engine y ACK PostgreSQL', async ({ skip }) => {
    await dockerRequirement.skipIfUnavailable(skip);
    const fixture = await startHumanProfileCodexFixture({ profileContractPath: 'scratch' });
    await withFixtureCleanup(fixture, async () => {
      const deliveryIds = await fixture.publishHumanTurns();
      const turns = await fixture.claimHumanTurns();
      expect(turns.map(({ delivery }) => delivery.delivery_id)).toEqual(deliveryIds);
      expect(turns.map(({ humanId }) => humanId)).toEqual([
        fixture.humanIds[0], fixture.humanIds[1], fixture.humanIds[0],
      ]);
      expect(turns.map(({ delivery }) => delivery.profile_runtime_contract?.revision))
        .toEqual([fixture.profileRevision, fixture.profileRevision, fixture.profileRevision]);
      expect(turns.map(({ delivery }) => delivery.profile_runtime_contract?.documents[0]?.sha))
        .toEqual([fixture.profileSha, fixture.profileSha, fixture.profileSha]);
      const turnB1 = turns[1];
      expect(JSON.stringify(turnB1.delivery.body)).toContain(fixture.humanIds[0]);

      const { events, runner, diagnostics } = await processDeterministicTurns(fixture, turns);
      expect(runner.turns, diagnostics.join(';')).toHaveLength(3);
      expect(runner.turns.map(({ sessionId }) => sessionId)).toEqual([
        undefined, undefined, 'native-session-human-a',
      ]);
      expect(runner.turns.map(({ context }) => {
        const initiator = context.human_initiator;
        return typeof initiator === 'object' && initiator !== null && 'human_id' in initiator
          ? initiator.human_id : undefined;
      })).toEqual([fixture.humanIds[0], fixture.humanIds[1], fixture.humanIds[0]]);
      expect(runner.turns.map(({ reply }) => reply)).toEqual([
        fixture.humanIds[0], fixture.humanIds[1], fixture.humanIds[0],
      ]);
      expect(events.filter((event) => event.phase === 'done').map((event) => event.claim_token))
        .toEqual(turns.map(({ delivery }) => delivery.claim_token));
      expect(events.filter((event) => event.phase === 'done').every((event) => event.profile_adoption === undefined)).toBe(true);
      const qaEvidenceDelivery = deliveryIds.at(0);
      if (qaEvidenceDelivery === undefined) throw new Error('deterministic fixture did not publish its A1 delivery');
      await insertSyntheticQaAdoption(fixture, qaEvidenceDelivery);
      const postflight = await readCodexSqlPostflight(fixture, deliveryIds);
      expect(postflight.messages.map(({ status }) => status)).toEqual(['done', 'done', 'done']);
      expect(postflight.acknowledgements).toHaveLength(3);
      for (const row of postflight.acknowledgements) {
        expect(row.statuses).toContain('started');
        expect(row.statuses).toContain('done');
      }
      expect(new Set(postflight.messages.map(({ body }) => JSON.stringify(body))).size).toBe(3);
      expect(postflight.profile).toEqual([{
        revision: String(fixture.profileRevision), applied_revision: null,
      }]);
      expect(postflight.adoptions).toMatchObject([{
        revision: String(fixture.profileRevision), generation: fixture.profileGeneration,
        delivery_id: qaEvidenceDelivery, attempt: 1, instance_id: fixture.instanceId,
        ack_status: 'done', ack_applied: true,
        documents: [{ name: 'AGENTS.md', path: fixture.profilePath, sha: fixture.profileSha }],
      }]);
      expect(postflight.adoptions).toHaveLength(1);
      console.info(JSON.stringify({
        evidence: 'codex-profile-sql-postflight-deterministic-qa-only',
        providerCredit: false,
        messages: postflight.messages.length,
        acknowledgements: postflight.acknowledgements.length,
        syntheticAdoptionRows: postflight.adoptions.length,
        appliedRevision: postflight.profile[0]?.applied_revision,
      }));
    });
  }, 180_000);

  it('valida JWT y ledger A1/B1/A2 por OAuth Streamable HTTP sin confiar en UUID forjados', async ({ skip }) => {
    await dockerRequirement.skipIfUnavailable(skip);
    const fixture = await startHumanProfileCodexFixture({
      profileContractPath: 'scratch', publicationTransport: 'oauth-streamable-http',
    });
    const postgresContainerId = fixture.database.container.getId();
    await withFixtureCleanup(fixture, async () => {
      const deliveryIds = await fixture.publishHumanTurns();
      const rows = await fixture.database.pool.query<{
        trace_id: string; human_id: string | null; body: unknown;
      }>(
        `SELECT message.trace_id,initiator.initiating_human_id::text AS human_id,message.body
           FROM messages message LEFT JOIN human_message_initiators initiator ON initiator.message_id=message.id
          WHERE message.trace_id=ANY($1::text[])
          ORDER BY array_position($1::text[],message.trace_id)`,
        [fixture.traceIds],
      );
      expect(rows.rows.map(({ trace_id }) => trace_id)).toEqual(fixture.traceIds);
      expect(rows.rows.map(({ human_id }) => human_id)).toEqual([
        fixture.humanIds[0], fixture.humanIds[1], fixture.humanIds[0],
      ]);
      expect(rows.rows).toHaveLength(3);
      const bodyB1 = rows.rows[1]?.body;
      expect(JSON.stringify(bodyB1)).toContain(fixture.humanIds[0]);

      const turns = await fixture.claimHumanTurns();
      expect(turns.map(({ delivery }) => delivery.delivery_id)).toEqual(deliveryIds);
      expect(turns.map(({ humanId }) => humanId)).toEqual([
        fixture.humanIds[0], fixture.humanIds[1], fixture.humanIds[0],
      ]);
      expect(turns.every(({ delivery }) => !Object.hasOwn(delivery, 'console_human_subject'))).toBe(true);
      console.info(JSON.stringify({
        evidence: 'oauth-streamable-http-human-ledger-claim',
        providerCredit: false,
        signedSubjects: 2,
        jwtSpoofClaimsIgnored: true,
        publications: rows.rows.length,
        ledgerOwners: rows.rows.map(({ human_id }) => human_id === fixture.humanIds[0] ? 'A'
          : human_id === fixture.humanIds[1] ? 'B' : 'missing'),
        claimOwners: turns.map(({ humanId }) => humanId === fixture.humanIds[0] ? 'A'
          : humanId === fixture.humanIds[1] ? 'B' : 'missing'),
      }));
    });
      console.info(JSON.stringify({ evidence: 'oauth-streamable-http-fixture-cleanup', postgresContainerId,
        containerStopCompleted: true, dedicatedNetwork: false }));
  }, 180_000);

  it.skipIf(!runCodexTurns || !contractReviewed)('demuestra tres respuestas del Codex real con resume aislado por UUID humano y una sola revisión', async ({ skip }) => {
    await dockerRequirement.skipIfUnavailable(skip);
    const fixture = await startHumanProfileCodexFixture({ profileContractPath: 'host' });
    let adapter: Awaited<ReturnType<HumanProfileCodexFixture['startRealAdapter']>> | undefined;
    let adapterEvidence: Awaited<ReturnType<NonNullable<typeof adapter>['stop']>> | undefined;
    let adapterStopAttempted = false;
    let testFailure: unknown;
    let testFailed = false;
    try {
      const deliveryIds = await fixture.publishHumanTurns();
      adapter = await fixture.startRealAdapter();
      await waitForDone(fixture, deliveryIds);
      const postflight = await readCodexSqlPostflight(fixture, deliveryIds);
      expect(postflight.messages).toHaveLength(3);
      expect(postflight.messages.map(({ status }) => status)).toEqual(['done', 'done', 'done']);
      expect(postflight.messages.map(({ output }) => {
        if (typeof output !== 'object' || output === null || !('reply' in output)) return undefined;
        return output.reply;
      })).toEqual([
        `${fixture.profileMarker}|${fixture.humanIds[0]}`,
        `${fixture.profileMarker}|${fixture.humanIds[1]}`,
        `${fixture.profileMarker}|${fixture.humanIds[0]}`,
      ]);
      expect(postflight.acknowledgements).toHaveLength(3);
      for (const row of postflight.acknowledgements) {
        expect(row.statuses).toContain('started');
        expect(row.statuses).toContain('done');
      }
      expect(postflight.profile).toEqual([{
        revision: String(fixture.profileRevision), applied_revision: String(fixture.profileRevision),
      }]);
      expect(postflight.adoptions).toHaveLength(1);
      const adoption = postflight.adoptions[0];
      expect(adoption).toMatchObject({
        revision: String(fixture.profileRevision), generation: fixture.profileGeneration,
        attempt: 1, instance_id: fixture.instanceId, ack_status: 'done', ack_applied: true,
        documents: [{ name: 'AGENTS.md', path: fixture.profilePath, sha: fixture.profileSha }],
      });
      expect(deliveryIds).toContain(adoption?.delivery_id);
      expect(adoption?.epoch).toMatch(/^[1-9][0-9]*$/u);
      adapterStopAttempted = true;
      adapterEvidence = await adapter.stop();
      expect(adapterEvidence.wrapperInvocations).toBe(3);
      expect(adapterEvidence.realCliSpawnRequested).toBe(3);
      expect(adapterEvidence.realCliProcessStarted).toBe(3);
      expect(adapterEvidence.budgetBlocked).toBe(0);
      expect(adapterEvidence.hostProfileShaAfter).toBeDefined();
      expect(adapterEvidence.turnWitnesses).toHaveLength(3);
      const humanASha = createHash('sha256').update(fixture.humanIds[0]).digest('hex');
      const humanBSha = createHash('sha256').update(fixture.humanIds[1]).digest('hex');
      const aWitnesses = adapterEvidence.turnWitnesses.filter(({ humanIdSha256 }) => humanIdSha256 === humanASha);
      const bWitnesses = adapterEvidence.turnWitnesses.filter(({ humanIdSha256 }) => humanIdSha256 === humanBSha);
      expect(aWitnesses).toHaveLength(2);
      expect(bWitnesses).toHaveLength(1);
      const a1Witness = aWitnesses.find(({ resumed }) => !resumed);
      const a2Witness = aWitnesses.find(({ resumed }) => resumed);
      const b1Witness = bWitnesses[0];
      expect(a1Witness).toBeDefined();
      expect(b1Witness).toBeDefined();
      expect(a2Witness).toBeDefined();
      expect(a1Witness?.slot).toBeLessThan(a2Witness?.slot ?? 0);
      expect(new Set(adapterEvidence.turnWitnesses.map(({ slot }) => slot)).size).toBe(3);
      expect(a2Witness?.resumeIdSha256).toBe(a1Witness?.threadIdSha256);
      expect(b1Witness?.threadIdSha256).not.toBe(a1Witness?.threadIdSha256);
      expect(new Set(adapterEvidence.turnWitnesses.map(({ threadIdSha256 }) => threadIdSha256)).size).toBe(2);
      expect(adapterEvidence.turnWitnesses.every(({ threadIdSha256 }) => /^[a-f0-9]{64}$/u.test(threadIdSha256 ?? ''))).toBe(true);
      expect(createHash('sha256').update(fixture.profileMarker).digest('hex')).toHaveLength(64);
    } catch (error) {
      testFailure = error;
      testFailed = true;
    }
    const cleanupFailures: unknown[] = [];
    if (adapter !== undefined && adapterEvidence === undefined && !adapterStopAttempted) {
      adapterStopAttempted = true;
      try { adapterEvidence = await adapter.stop(); } catch (error) { cleanupFailures.push(error); }
    }
    if (adapterEvidence !== undefined) logSafeAdapterEvidence(adapterEvidence, fixture);
    try { await fixture.close(); } catch (error) { cleanupFailures.push(error); }
    if (testFailed || cleanupFailures.length > 0) {
      const failures = [...(testFailed ? [testFailure] : []), ...cleanupFailures];
      if (failures.length === 1) throw failures[0];
      throw new AggregateError(failures, 'Codex profile E2E and cleanup failed');
    }
  }, 9 * 60_000);
});
