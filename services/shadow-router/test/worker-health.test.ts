import { describe, expect, it, vi } from 'vitest';
import { ShadowRouteExecutionError } from '../src/errors.js';
import { ShadowRouter, type ShadowRouteHooks } from '../src/router.js';
import { ShadowRouterProgress } from '../src/progress.js';
import { MapShadowTargetRegistry } from '../src/target.js';
import type {
  ShadowEnvelope, ShadowInboxLease, ShadowInboxRepository, ShadowMapping,
  ShadowMappingRepository, ShadowMode,
} from '../src/types.js';
import { ShadowRouterWorker } from '../src/worker.js';

const lease: ShadowInboxLease = {
  id: 'lease-1',
  direction: 'v2-to-v3',
  source_event_id: 'source-1',
  tenant_id: 'Steven',
  mode: 'shadow',
  envelope: {
    direction: 'v2-to-v3', source_event_id: 'source-1', tenant_id: 'Steven',
    correlation: { request_id: 'request-1', trace_id: 'trace-1' }, payload: {},
    expects_human_reply: false,
  },
  attempt: 1,
  max_attempts: 3,
  claim_token: 'claim-1',
};

function repository(claims: Array<readonly ShadowInboxLease[]>): ShadowInboxRepository {
  return {
    enqueue: vi.fn(async () => ({ id: 'inbox-1', duplicate: false })),
    claim: vi.fn(async () => [...(claims.shift() ?? [])]),
    markTargetStarted: vi.fn(async () => undefined),
    completeInbox: vi.fn(async () => undefined),
    retryInbox: vi.fn(async (): Promise<'retry'> => 'retry'),
    releaseUnstartedInbox: vi.fn(async () => undefined),
    abandonLocalInboxClaim: vi.fn(),
    health: vi.fn(async () => ({
      pending: 0, failed: 0, dead: 0, processing: 0, owned_processing: 0,
      orphaned_processing: 0, oldest_ready_seconds: 0,
    })),
  };
}

function router(
  route: (input: unknown, signal?: AbortSignal) => Promise<unknown>,
  crossesTarget = true,
): ShadowRouter {
  return {
    mode: 'shadow',
    route: async (input: unknown, signal?: AbortSignal, hooks: ShadowRouteHooks = {}) => {
      let invoked = false;
      try {
        if (crossesTarget) await hooks.beforeTarget?.(signal);
        invoked = crossesTarget;
        const result = await route(input, signal);
        return result !== null && typeof result === 'object'
          ? { ...result, target_invoked: crossesTarget }
          : result;
      } catch (error) {
        throw new ShadowRouteExecutionError(error, invoked);
      }
    },
  } as unknown as ShadowRouter;
}

describe('ShadowRouterWorker progress', () => {
  it('does not let empty DB ticks hide a failed target and clears only after real routing', async () => {
    const progress = new ShadowRouterProgress(20_000);
    const repo = repository([[lease], [], [lease]]);
    const route = vi.fn()
      .mockRejectedValueOnce(new Error('target down'))
      .mockResolvedValueOnce({ status: 'shadowed' });
    const worker = new ShadowRouterWorker({ repository: repo, router: router(route), progress });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(progress.snapshot()).toMatchObject({ ready: false, reason: 'target_error' });
    await expect(worker.runOnce()).resolves.toBe(0);
    expect(progress.snapshot()).toMatchObject({ ready: false, reason: 'target_error' });
    await expect(worker.runOnce()).resolves.toBe(1);
    expect(progress.snapshot()).toMatchObject({ ready: true, reason: 'ready' });
  });

  it('marks claim/retry persistence failures as repository errors instead of swallowing them', async () => {
    const progress = new ShadowRouterProgress(20_000);
    const repo = repository([]);
    repo.claim = vi.fn(async () => { throw new Error('database down'); });
    const worker = new ShadowRouterWorker({
      repository: repo, router: router(async () => ({ status: 'shadowed' })), progress,
    });
    await expect(worker.runOnce()).rejects.toThrow('database down');
    expect(progress.snapshot()).toMatchObject({ ready: false, reason: 'repository_error' });
  });

  it('reports a sanitized loop error and exits promptly if the callback aborts', async () => {
    const progress = new ShadowRouterProgress(20_000);
    const repo = repository([]);
    repo.claim = vi.fn(async () => { throw new Error('db row 123456\nsecret-ish detail'); });
    const controller = new AbortController();
    const observed: string[] = [];
    const worker = new ShadowRouterWorker({
      repository: repo,
      router: router(async () => ({ status: 'shadowed' })),
      progress,
      onLoopError: (error) => { observed.push(error); controller.abort(); },
    });
    await worker.run(controller.signal);
    expect(observed).toEqual(['db row <id> secret-ish detail']);
  });

  it('cancels an in-flight target and durably retries its ambiguous lease', async () => {
    const progress = new ShadowRouterProgress(20_000);
    const repo = repository([[lease]]);
    const retryInbox = vi.fn(async (): Promise<'retry'> => 'retry');
    repo.retryInbox = retryInbox;
    const controller = new AbortController();
    let entered = false;
    const route = vi.fn(async (_envelope: unknown, signal?: AbortSignal) => {
      entered = true;
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('target aborted')), { once: true });
      });
    });
    const worker = new ShadowRouterWorker({ repository: repo, router: router(route), progress });
    const running = worker.run(controller.signal);
    await vi.waitFor(() => expect(entered).toBe(true));
    controller.abort();
    await expect(running).resolves.toBeUndefined();
    expect(retryInbox).toHaveBeenCalledOnce();
    expect(progress.snapshot()).toMatchObject({ ready: false, reason: 'stopping' });
  });

  it('treats a competing terminal mapping as routed instead of failed or dead', async () => {
    const progress = new ShadowRouterProgress(20_000);
    const repo = repository([[lease]]);
    const retryInbox = vi.fn(async (): Promise<'done'> => 'done');
    repo.retryInbox = retryInbox;
    const route = vi.fn(async () => { throw new Error('late competing target failure'); });
    const worker = new ShadowRouterWorker({ repository: repo, router: router(route), progress });

    await expect(worker.runOnce()).resolves.toBe(1);

    expect(retryInbox).toHaveBeenCalledOnce();
    expect(progress.snapshot()).toMatchObject({
      ready: true, reason: 'ready', routed_events: 1, failed_events: 0,
    });
  });

  it('returns a claimed event without consuming an attempt when stop wins before routing', async () => {
    const progress = new ShadowRouterProgress(20_000);
    const controller = new AbortController();
    const repo = repository([]);
    const releaseUnstartedInbox = vi.fn(async () => undefined);
    repo.releaseUnstartedInbox = releaseUnstartedInbox;
    repo.claim = vi.fn(async () => {
      controller.abort();
      return [lease];
    });
    const route = vi.fn(async () => ({ status: 'shadowed' }));
    const worker = new ShadowRouterWorker({ repository: repo, router: router(route), progress });
    await expect(worker.runOnce(controller.signal)).resolves.toBe(1);
    expect(route).not.toHaveBeenCalled();
    expect(releaseUnstartedInbox).toHaveBeenCalledWith(
      lease, 'shadow router stopped before target invocation', expect.any(AbortSignal),
    );
    expect(progress.snapshot()).toMatchObject({ released_events: 1, reason: 'stopping' });
  });

  it('aborts begin before the target boundary and restores exactly one attempt', async () => {
    const inbox = repository([[lease]]);
    const retryInbox = vi.fn(async (): Promise<'retry'> => 'retry');
    const releaseUnstartedInbox = vi.fn(async () => undefined);
    inbox.retryInbox = retryInbox;
    inbox.releaseUnstartedInbox = releaseUnstartedInbox;
    const targetInvocations = vi.fn(async () => ({ output: {} }));
    let enteredBegin: (() => void) | undefined;
    const beginEntered = new Promise<void>((resolve) => { enteredBegin = resolve; });
    const mappingRepository: ShadowMappingRepository = {
      begin: vi.fn(async (
        _envelope: ShadowEnvelope,
        _mode: ShadowMode,
        signal?: AbortSignal,
      ): Promise<ShadowMapping> => {
        enteredBegin?.();
        return new Promise<never>((_resolve, reject) => {
          const aborted = (): void => reject(
            signal?.reason instanceof Error ? signal.reason : new Error('aborted'),
          );
          signal?.addEventListener('abort', aborted, { once: true });
          if (signal?.aborted) aborted();
        });
      }),
      complete: vi.fn(async () => undefined),
      recordVerdict: vi.fn(async () => undefined),
      reserveHumanReply: vi.fn(async () => true),
    };
    const instance = new ShadowRouter({
      mode: 'shadow',
      allowedTenants: new Set(['Steven']),
      repository: mappingRepository,
      targets: new MapShadowTargetRegistry([['v2-to-v3', { preview: targetInvocations, deliver: vi.fn() }]]),
    });
    const controller = new AbortController();
    const progress = new ShadowRouterProgress(20_000);
    const worker = new ShadowRouterWorker({ repository: inbox, router: instance, progress });

    const running = worker.run(controller.signal);
    await beginEntered;
    controller.abort(new Error('deterministic shutdown race'));
    await expect(running).resolves.toBeUndefined();

    expect(targetInvocations).not.toHaveBeenCalled();
    expect(retryInbox).not.toHaveBeenCalled();
    expect(releaseUnstartedInbox).toHaveBeenCalledOnce();
    expect(releaseUnstartedInbox).toHaveBeenCalledWith(
      lease, 'deterministic shutdown race', expect.any(AbortSignal),
    );
    expect(progress.snapshot()).toMatchObject({ released_events: 1, reason: 'stopping' });
  });

  it('does not invoke the target or consume an attempt when the durable phase mark fails', async () => {
    const inbox = repository([[lease]]);
    const markTargetStarted = vi.fn(async () => { throw new Error('phase database unavailable'); });
    const retryInbox = vi.fn(async (): Promise<'retry'> => 'retry');
    const releaseUnstartedInbox = vi.fn(async () => undefined);
    inbox.markTargetStarted = markTargetStarted;
    inbox.retryInbox = retryInbox;
    inbox.releaseUnstartedInbox = releaseUnstartedInbox;
    const mapping: ShadowMapping = {
      direction: 'v2-to-v3',
      source_event_id: lease.source_event_id,
      tenant_id: lease.tenant_id,
      mode: 'shadow',
      target_event_id: '11111111-1111-4111-8111-111111111111',
      correlation: lease.envelope.correlation,
      status: 'processing',
      created: true,
    };
    const mappingRepository: ShadowMappingRepository = {
      begin: vi.fn(async () => mapping),
      complete: vi.fn(async () => undefined),
      recordVerdict: vi.fn(async () => undefined),
      reserveHumanReply: vi.fn(async () => true),
    };
    const preview = vi.fn(async () => ({ output: {} }));
    const instance = new ShadowRouter({
      mode: 'shadow',
      allowedTenants: new Set(['Steven']),
      repository: mappingRepository,
      targets: new MapShadowTargetRegistry([['v2-to-v3', { preview, deliver: vi.fn() }]]),
    });
    const worker = new ShadowRouterWorker({ repository: inbox, router: instance });

    await expect(worker.runOnce()).resolves.toBe(1);

    expect(markTargetStarted).toHaveBeenCalledOnce();
    expect(preview).not.toHaveBeenCalled();
    expect(retryInbox).not.toHaveBeenCalled();
    expect(releaseUnstartedInbox).toHaveBeenCalledWith(
      lease, 'phase database unavailable', undefined,
    );
  });

  it('restores the attempt when inbox completion fails after a duplicate without target I/O', async () => {
    const repo = repository([[lease]]);
    repo.completeInbox = vi.fn(async () => { throw new Error('completion database failure'); });
    const retryInbox = vi.fn(async (): Promise<'retry'> => 'retry');
    const releaseUnstartedInbox = vi.fn(async () => undefined);
    repo.retryInbox = retryInbox;
    repo.releaseUnstartedInbox = releaseUnstartedInbox;
    const route = vi.fn(async () => ({
      target_event_id: 'already-finished',
      status: 'shadowed' as const,
      duplicate: true,
      human_reply: false,
      target_invoked: false,
    }));
    const progress = new ShadowRouterProgress(20_000);
    const worker = new ShadowRouterWorker({ repository: repo, router: router(route, false), progress });

    await expect(worker.runOnce()).resolves.toBe(1);

    expect(retryInbox).not.toHaveBeenCalled();
    expect(releaseUnstartedInbox).toHaveBeenCalledWith(
      lease, 'completion database failure', undefined,
    );
    expect(progress.snapshot()).toMatchObject({
      released_events: 1, failed_events: 0, reason: 'repository_error',
    });
  });

  it('retries only idempotent inbox completion after a successful target', async () => {
    const repo = repository([[lease]]);
    const completeInbox = vi.fn()
      .mockRejectedValueOnce(new Error('commit acknowledgement lost'))
      .mockResolvedValueOnce(undefined);
    const retryInbox = vi.fn(async (): Promise<'retry'> => 'retry');
    const releaseUnstartedInbox = vi.fn(async () => undefined);
    const abandonLocalInboxClaim = vi.fn();
    repo.completeInbox = completeInbox;
    repo.retryInbox = retryInbox;
    repo.releaseUnstartedInbox = releaseUnstartedInbox;
    repo.abandonLocalInboxClaim = abandonLocalInboxClaim;
    const route = vi.fn(async () => ({ status: 'shadowed' }));
    const worker = new ShadowRouterWorker({ repository: repo, router: router(route) });

    await expect(worker.runOnce()).resolves.toBe(1);

    expect(route).toHaveBeenCalledOnce();
    expect(completeInbox).toHaveBeenCalledTimes(2);
    expect(retryInbox).not.toHaveBeenCalled();
    expect(releaseUnstartedInbox).not.toHaveBeenCalled();
    expect(abandonLocalInboxClaim).not.toHaveBeenCalled();
  });

  it('leaves a successful target lease for reconciliation if terminal completion stays unavailable', async () => {
    const repo = repository([[lease]]);
    const completeInbox = vi.fn(async () => { throw new Error('database remains unavailable'); });
    repo.completeInbox = completeInbox;
    const retryInbox = vi.fn(async (): Promise<'retry'> => 'retry');
    const releaseUnstartedInbox = vi.fn(async () => undefined);
    const abandonLocalInboxClaim = vi.fn();
    repo.retryInbox = retryInbox;
    repo.releaseUnstartedInbox = releaseUnstartedInbox;
    repo.abandonLocalInboxClaim = abandonLocalInboxClaim;
    const route = vi.fn(async () => ({ status: 'shadowed' }));
    const worker = new ShadowRouterWorker({ repository: repo, router: router(route) });

    await expect(worker.runOnce()).rejects.toThrow('database remains unavailable');

    expect(route).toHaveBeenCalledOnce();
    expect(completeInbox).toHaveBeenCalledTimes(2);
    expect(retryInbox).not.toHaveBeenCalled();
    expect(releaseUnstartedInbox).not.toHaveBeenCalled();
    expect(abandonLocalInboxClaim).toHaveBeenCalledWith(lease);
  });

  it('forbids a sequential batch whose later leases could expire before execution', () => {
    expect(() => new ShadowRouterWorker({
      repository: repository([]), router: router(async () => ({})), batchSize: 2,
    })).toThrow('batchSize must be 1');
  });
});
