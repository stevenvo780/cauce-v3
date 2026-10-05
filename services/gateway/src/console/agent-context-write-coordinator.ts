import { createHash, randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  reserveAgentContextWrite, authorizeAgentContextDispatch, resolveAgentContextWrite,
  type DatabasePool, type DatabaseClient, type ContextWriteDocument, type ContextWriterQuiescence,
  type ContextWriteDescriptor, type ContextWriterIdentity, canonicalProfileRuntimeContract, StoreError,
} from '@cauce/store';
import type { Tenant } from '@cauce/protocol';
import type { AgentFactsProbe, AgentDocumentsDeps, GovernanceWritePrecondition } from './agent-documents.routes.js';
import { validatedWriteStatus, type GovernanceWriteOperation } from './governance-write-operation.js';

export interface ContextWriteCoordinateInput<T> {
  readonly tenantId: Tenant;
  readonly alias: string;
  readonly expectedRevision: number | null;
  readonly expectedExpectation: { readonly revision: number; readonly generation: string;
    readonly documents: readonly { readonly name: string; readonly path: string; readonly sha: string }[] } | null;
  readonly documents: readonly ContextWriteDocument[];
  readonly signal?: AbortSignal;
  readonly updateDesired?: (client: DatabaseClient) => Promise<void>;
  readonly dispatch: (operation: GovernanceWriteOperation) => Promise<T>;
  readonly persistTarget: (client: DatabaseClient, proof: ContextWriterQuiescence, value: NoInfer<T>) => Promise<void>;
}

export type CoordinateResult<T> =
  | { readonly state: 'committed'; readonly resolution: 'target'; readonly value: T }
  | { readonly state: 'not_applied'; readonly operation_id: string }
  | { readonly state: 'effect_unknown'; readonly operation_id: string };

export async function coordinateContextRequest<T>(
  coordinate: <Value>(input: ContextWriteCoordinateInput<Value>) => Promise<CoordinateResult<Value>>,
  request: FastifyRequest, reply: FastifyReply, input: ContextWriteCoordinateInput<T>,
): Promise<CoordinateResult<T>> {
  const controller = new AbortController();
  const abort = (): void => { controller.abort(); };
  const closed = (): void => { if (!reply.raw.writableFinished) abort(); };
  request.raw.on('aborted', abort);
  reply.raw.on('close', closed);
  const timer = setTimeout(abort, 10_000);
  timer.unref();
  if ((request.raw.destroyed && !request.raw.complete) || reply.raw.destroyed) abort();
  try {
    return await coordinate({ ...input, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    request.raw.off('aborted', abort);
    reply.raw.off('close', closed);
  }
}

export async function replyUnconfirmedDocumentWrite(
  reply: FastifyReply, result: Exclude<CoordinateResult<unknown>, { state: 'committed' }>,
  deny: (status: number, body: Readonly<Record<string, unknown>>) => Promise<FastifyReply>,
): Promise<FastifyReply> {
  const status = result.state === 'not_applied' ? 409 : 503;
  const body = { error: 'document_write_unconfirmed', state: result.state, operation_id: result.operation_id };
  try { return await deny(status, body); }
  catch { return reply.code(status).send({ ...body, audit_recorded: false }); }
}

export async function coordinateDocumentRequest(
  deps: AgentDocumentsDeps, request: FastifyRequest, reply: FastifyReply, input: {
    tenantId: Tenant; alias: string; kind: string; path: string; content: string;
    precondition: GovernanceWritePrecondition;
    facts: import('./agent-documents/catalog.js').RuntimeFacts;
    actor: { tenant_id: string; alias: string };
    auditMetadata: (sha: string, bytes: number) => Readonly<Record<string, unknown>>;
  },
): Promise<CoordinateResult<{ sha: string; bytes: number }>> {
  const write = deps.probe.writeGovernanceDocumentDurable?.bind(deps.probe);
  const persist = deps.persistDocumentWrite?.bind(deps);
  if (deps.coordinateWrite === undefined || deps.readContext === undefined || persist === undefined
    || write === undefined || deps.readRuntimeExpectation === undefined) {
    throw new Error('durable document coordinator unavailable');
  }
  const context = await deps.readContext(input.tenantId, input.alias);
  const expectation = await deps.readRuntimeExpectation(input.tenantId, input.alias);
  const bytes = Buffer.byteLength(input.content, 'utf8');
  const sha = createHash('sha256').update(input.content, 'utf8').digest('hex');
  return coordinateContextRequest(deps.coordinateWrite.bind(deps), request, reply, {
    tenantId: input.tenantId, alias: input.alias, expectedRevision: context.revision,
    expectedExpectation: expectation ?? null,
    documents: [{ name: input.kind, path: input.path,
      beforeSha: input.precondition.state === 'present' ? input.precondition.sha256 : null, targetSha: sha }],
    dispatch: async (operation) => {
      const written = await write(input.path, input.content,
        input.precondition, input.facts, input.tenantId, input.alias, operation);
      if ('error' in written || written.sha !== sha || written.bytes !== bytes) throw new Error('document write unconfirmed');
      return written;
    },
    persistTarget: async (client, _proof, effect) => {
      await persist(client, {
        tenantId: input.tenantId, alias: input.alias, kind: input.kind, path: input.path,
        sha256: effect.sha, bytes: effect.bytes, actorTenant: input.actor.tenant_id, actorAlias: input.actor.alias,
      }, { tenant_id: input.actor.tenant_id, actor_alias: input.actor.alias,
        action: 'agent_document.write', decision: 'allow', metadata: input.auditMetadata(effect.sha, effect.bytes) });
    },
  });
}

export class AgentContextWriteCoordinator {
  constructor(private readonly pool: DatabasePool, private readonly probe: AgentFactsProbe) {}

  async coordinate<T>(input: ContextWriteCoordinateInput<T>): Promise<CoordinateResult<T>> {
    input.signal?.throwIfAborted();
    const measured = await this.probe.factsFor(input.tenantId, input.alias);
    const facts = measured?.facts;
    if (measured?.source !== 'measured' || !facts?.generation || !facts.containerId
      || !facts.writerInstanceId || !facts.features?.includes('write_quiescence_v1')
      || this.probe.writeStatus === undefined || this.probe.supportsDurableWrites?.() === false) {
      throw Object.assign(new Error('durable context writer unavailable'), { code: 'unavailable' });
    }
    const writer: ContextWriterIdentity = {
      runtimeGeneration: facts.generation, containerId: facts.containerId,
      writerInstanceId: facts.writerInstanceId,
    };
    const expectation = input.expectedExpectation === null ? null : canonicalProfileRuntimeContract(input.expectedExpectation);
    if (expectation === undefined) throw new StoreError('invalid_input', 'context write expectation is invalid');
    const operationId = randomUUID();
    let expected: ContextWriteDescriptor;
    try {
      expected = await reserveAgentContextWrite(this.pool, {
      operationId, token: randomUUID(), generation: randomUUID(),
      tenantId: input.tenantId, alias: input.alias, writer,
      expectedRevision: input.expectedRevision, expectedExpectation: expectation,
      documents: input.documents,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.updateDesired === undefined ? {} : { updateDesired: input.updateDesired }),
      });
    } catch (error) {
      if (error instanceof StoreError && error.recoveryReason !== 'context_write_commit_unverified') throw error;
      return { state: 'effect_unknown', operation_id: operationId };
    }
    try {
      const authorized = await authorizeAgentContextDispatch(this.pool, expected, input.signal);
      const value = await input.dispatch({
        operationId, operationToken: authorized.token, operationGeneration: authorized.generation,
        runtimeGeneration: writer.runtimeGeneration, ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      const resolution = await resolveAgentContextWrite(this.pool, authorized,
        async () => this.readProof(authorized, input.signal),
        async (client, proof) => input.persistTarget(client, proof, value), input.signal);
      return resolution === 'target'
        ? { state: 'committed', resolution, value }
        : { state: 'not_applied', operation_id: operationId };
    } catch {
      return { state: 'effect_unknown', operation_id: operationId };
    }
  }

  private async readProof(expected: ContextWriteDescriptor, signal?: AbortSignal): Promise<ContextWriterQuiescence> {
    signal?.throwIfAborted();
    const statusValue = await this.probe.writeStatus?.(expected.tenantId, expected.alias,
      expected.operationId, expected.token, expected.generation, expected.operationId,
      expected.writer.runtimeGeneration, signal);
    const status = validatedWriteStatus(statusValue, {
      tenantId: expected.tenantId, alias: expected.alias, operationId: expected.operationId,
      generation: expected.generation, runtimeGeneration: expected.writer.runtimeGeneration,
    });
    if (status?.state !== 'done' || status.container_id !== expected.writer.containerId
      || status.writer_instance_id !== expected.writer.writerInstanceId
      || status.files.length !== expected.documents.length) throw new Error('context write receipt unconfirmed');
    const current = await this.probe.factsFor(expected.tenantId, expected.alias);
    if (current?.source !== 'measured' || current.facts.generation !== expected.writer.runtimeGeneration
      || current.facts.containerId !== expected.writer.containerId
      || current.facts.writerInstanceId !== expected.writer.writerInstanceId
      || !current.facts.features?.includes('write_quiescence_v1')) throw new Error('context writer changed');
    const documents = [];
    for (const document of expected.documents) {
      const receipt = status.files.find((file) => file.path === document.path);
      if (receipt === undefined) throw new Error('context write receipt incomplete');
      const read = await this.probe.readGovernanceDocument(document.path, current.facts,
        expected.tenantId, expected.alias, signal);
      if ('error' in read) {
        if (read.error !== 'not_found' || receipt.sha !== null || receipt.bytes !== 0) {
          throw new Error('context write readback unavailable');
        }
        documents.push({ name: document.name, path: document.path, sha: null });
      } else {
        if (read.truncated || read.sha !== receipt.sha || read.bytes !== receipt.bytes
          || Buffer.byteLength(read.text, 'utf8') !== read.bytes
          || createHash('sha256').update(read.text, 'utf8').digest('hex') !== read.sha) {
          throw new Error('context write readback differs');
        }
        documents.push({ name: document.name, path: document.path, sha: read.sha });
      }
    }
    const after = await this.probe.factsFor(expected.tenantId, expected.alias);
    if (after?.source !== 'measured' || after.facts.generation !== expected.writer.runtimeGeneration
      || after.facts.containerId !== expected.writer.containerId
      || after.facts.writerInstanceId !== expected.writer.writerInstanceId
      || !after.facts.features?.includes('write_quiescence_v1')) throw new Error('context writer changed');
    signal?.throwIfAborted();
    return { operationId: expected.operationId, token: expected.token, generation: expected.generation,
      writer: expected.writer, state: 'quiescent', durability: 'post_fsync', documents };
  }
}
