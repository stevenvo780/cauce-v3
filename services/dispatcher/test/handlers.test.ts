import type { DatabasePool } from '@cauce/store';
import { describe, expect, it, vi } from 'vitest';
import { asClaimedJob, createDefaultJobHandlerRegistry, type JobHandlers } from '../src/handlers.js';

const probePool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as unknown as DatabasePool;

function claim(kind: string, payload: Readonly<Record<string, unknown>> = {}): ReturnType<typeof asClaimedJob> {
  return asClaimedJob({
    id: 'job-1', kind, lane: 'interactive', payload, claim_token: 'claim-1'
  });
}

function lookup(handlers: JobHandlers, kind: string): unknown {
  return Object.hasOwn(handlers, kind) ? handlers[kind] : undefined;
}

describe('allow-list de kinds ejecutables', () => {
  it('expone sólo el kind de producción y añade el de QA bajo NODE_ENV=test', () => {
    expect(Object.keys(createDefaultJobHandlerRegistry(probePool, 'production')))
      .toEqual(['system.database.probe']);
    expect(Object.keys(createDefaultJobHandlerRegistry(probePool, 'test')).sort())
      .toEqual(['qa.fairness', 'system.database.probe']);
  });

  it('es inmutable: no se puede añadir ni reemplazar un handler en caliente', () => {
    const handlers = createDefaultJobHandlerRegistry(probePool, 'production');
    expect(Object.isFrozen(handlers)).toBe(true);
    expect(() => {
      (handlers as Record<string, unknown>)['qa.injected'] = async () => undefined;
    }).toThrow(TypeError);
    expect(lookup(handlers, 'qa.injected')).toBeUndefined();
  });

  it('no resuelve un handler para las claves heredadas de Object.prototype', () => {
    const handlers = createDefaultJobHandlerRegistry(probePool, 'production');
    for (const poison of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(lookup(handlers, poison)).toBeUndefined();
    }
    expect(lookup(handlers, 'system.database.probe')).toBeTypeOf('function');
  });

  it('ejecuta exactamente una vez el kind registrado y ninguno más', async () => {
    const executed: string[] = [];
    const handlers: JobHandlers = {
      'known.kind': async (job) => { executed.push(job.id); },
    };
    await (lookup(handlers, 'known.kind') as (job: ReturnType<typeof claim>) => Promise<void>)(
      claim('known.kind')
    );
    expect(executed).toEqual(['job-1']);
    expect(lookup(handlers, 'unknown.kind')).toBeUndefined();
  });

  it('rechaza el fixture de QA cuyo índice no es un entero no negativo', async () => {
    const handlers = createDefaultJobHandlerRegistry(probePool, 'test');
    const fairness = handlers['qa.fairness'];
    if (fairness === undefined) throw new Error('qa.fairness must exist under NODE_ENV=test');
    await expect(fairness(claim('qa.fairness', { index: -1 }))).rejects.toThrow(/index/);
    await expect(fairness(claim('qa.fairness', { index: 0 }))).resolves.toBeUndefined();
  });

  it('rechaza el claim malformado antes de buscar handler', () => {
    expect(() => asClaimedJob({ id: 'job-1', kind: 'known.kind', lane: 'batch', payload: [] }))
      .toThrow(/payload/);
    expect(() => asClaimedJob({ id: '', kind: 'known.kind', lane: 'batch', payload: {} }))
      .toThrow(/string id/);
  });
});
