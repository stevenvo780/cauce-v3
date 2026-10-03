import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { Server as HttpsServer } from 'node:https';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AgentConnection } from './agent-leg.js';
import { parseWriteRequest, setupGovernanceRelay } from './governance-relay.js';
import { requestFileWrite } from './governance-write.js';

const path = '/home/dev/.claude/CLAUDE.md';
const target = { generation: 'measured-generation', containerId: 'container-one', path };
const precondition = { state: 'present' as const, sha256: 'b'.repeat(64) };
const content = Buffer.from('manual');
const body = {
  tenant_id: 'Steven', alias: 'zeus', path, content_base64: content.toString('base64'), precondition,
};
const wireTarget = { generation: target.generation, container_id: target.containerId, path };

function connection(generation = target.generation, containerId = target.containerId) {
  let onWriteOk: ((body: Record<string, unknown>) => void) | undefined;
  const sendWrite = vi.fn(() => {
    onWriteOk?.({ path, operation: 'replace', sha: createHash('sha256').update(content).digest('hex'), bytes: content.length });
    return true;
  });
  const agent = {
    alive: true,
    hello: { tenant_id: 'Steven', alias: 'zeus', generation, container_id: containerId },
    supportsGovernanceWrite: true,
    attachWrite: vi.fn((_id: string, callbacks: { onWriteOk: (body: Record<string, unknown>) => void }) => {
      onWriteOk = callbacks.onWriteOk;
    }),
    detachWrite: vi.fn(), cancelWrite: vi.fn(), sendWrite,
  };
  return { agent: agent as unknown as AgentConnection, sendWrite, attachWrite: agent.attachWrite };
}

describe('cercado optativo de la conexión de escritura', () => {
  it.each([
    ['generation-new', target.containerId],
    ['', target.containerId],
    [target.generation, 'container-new'],
    [target.generation, ''],
  ])('no manda WRITE si la conexión cambia a %s/%s aunque path y CAS coincidan', async (generation, containerId) => {
    const replacement = connection(generation, containerId);
    const result = await requestFileWrite(replacement.agent, 'Steven', 'zeus', path, content, precondition, 5000, undefined, target);
    expect(result).toMatchObject({ error: 'conflict' });
    expect(replacement.sendWrite).not.toHaveBeenCalled();
    expect(replacement.attachWrite).not.toHaveBeenCalled();
  });

  it('conserva bytes, CAS y ACK del escritor cuando coincide el destino', async () => {
    const current = connection();
    const result = await requestFileWrite(current.agent, 'Steven', 'zeus', path, content, precondition, 5000, undefined, target);
    expect(result).toMatchObject({ path, operation: 'replace', bytes: content.length });
    expect(current.sendWrite).toHaveBeenCalledOnce();
    expect(current.sendWrite).toHaveBeenCalledWith(expect.any(String), path, 'replace', precondition.sha256, expect.any(String), content);
  });

  it('no retargetea a otra ruta', async () => {
    const current = connection();
    expect(await requestFileWrite(current.agent, 'Steven', 'zeus', path, content, precondition, 5000, undefined,
      { ...target, path: '/home/dev/.claude/other.md' })).toMatchObject({ error: 'conflict' });
    expect(current.sendWrite).not.toHaveBeenCalled();
  });

  it('mantiene el escritor legado sin afirmar que está cercado', async () => {
    const current = connection('unmeasured-generation');
    expect(await requestFileWrite(current.agent, 'Steven', 'zeus', path, content, precondition)).toMatchObject({ path });
    expect(current.sendWrite).toHaveBeenCalledOnce();
  });
});

describe('expected_target es un contrato cerrado sin downgrade', () => {
  it('convierte el destino completo y conserva ausencia en llamadas legadas', () => {
    expect(parseWriteRequest(JSON.stringify({ ...body, expected_target: wireTarget }))).toMatchObject({ expectedTarget: target });
    expect(parseWriteRequest(JSON.stringify(body))).not.toHaveProperty('expectedTarget');
  });

  it.each([
    null, {}, [], 'generation', { ...wireTarget, generation: '' },
    { ...wireTarget, generation: 42 }, { ...wireTarget, container_id: '' },
    { generation: wireTarget.generation, path }, { ...wireTarget, path: '/another/path' },
    { ...wireTarget, extra: true },
  ])('rechaza un destino incompleto o inválido %#', (expectedTarget) => {
    expect(parseWriteRequest(JSON.stringify({ ...body, expected_target: expectedTarget }))).toHaveProperty('rejected');
  });
});


describe('admisión del handler con transporte sintético', () => {
  it('consulta la conexión después de medir y pasa el cercado al escritor real', async () => {
    const replacement = connection('replacement-generation');
    const server = new EventEmitter();
    const lookup = vi.fn(() => replacement.agent);
    setupGovernanceRelay({
      server: server as unknown as HttpsServer,
      agents: { lookup },
      token: async () => 'synthetic-test-only',
    });
    const request = Object.assign(Readable.from([Buffer.from(JSON.stringify({ ...body, expected_target: wireTarget }))]), {
      method: 'POST', url: '/v3/terminal/relay/write', headers: { authorization: 'Bearer synthetic-test-only' },
    });
    const result = await new Promise<unknown>((resolve) => {
      const response = Object.assign(new EventEmitter(), {
        writableEnded: false,
        writeHead: vi.fn(),
        end: (payload: Buffer) => { resolve(JSON.parse(payload.toString('utf8'))); },
      });
      server.emit('request', request, response);
    });
    expect(lookup).toHaveBeenCalledWith('Steven', 'zeus');
    expect(result).toMatchObject({ error: 'conflict' });
    expect(replacement.sendWrite).not.toHaveBeenCalled();
  });
});
