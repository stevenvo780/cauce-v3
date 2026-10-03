import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { GovernanceWriteTarget } from '../agent-documents.routes.js';
import { TerminalRelayFactsProbe } from './relay-probe.js';

const path = '/home/dev/.claude/CLAUDE.md';
const target = { generation: 'measured-generation', containerId: 'container-one', path };
const facts = { harness: 'claude' as const, home: '/home/dev', generation: target.generation, containerId: target.containerId };
const text = 'manual';
const ack = { path, operation: 'create' as const, sha: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) };
const readFile = vi.fn(async () => ({ error: 'unavailable' as const, reason: 'sin lectura' }));
const source = { factsFor: async () => undefined };

function setup() {
  const writeFile = vi.fn(async () => ack);
  const writeFileFenced = vi.fn(async () => ack);
  return { writeFile, writeFileFenced, probe: new TerminalRelayFactsProbe(source, { readFile, writeFile, writeFileFenced }) };
}

describe('el probe conserva la generación y el destino medidos', () => {
  it('usa exclusivamente el método cercado con la identidad completa', async () => {
    const { probe, writeFile, writeFileFenced } = setup();
    expect(await probe.writeGovernanceDocumentFenced(path, text, { state: 'absent' }, facts, 'Steven', 'zeus', target)).toEqual({ sha: ack.sha, bytes: ack.bytes });
    expect(writeFile).not.toHaveBeenCalled();
    expect(writeFileFenced).toHaveBeenCalledWith('Steven', 'zeus', path, text, { state: 'absent' }, target);
  });

  it.each([
    { ...target, generation: '' }, { ...target, generation: 'different-generation' },
    { ...target, containerId: '' }, { ...target, containerId: 'different-container' },
    { ...target, path: '/different/path' },
  ])('rechaza mismatch sin invocar escritor %#', async (expectedTarget) => {
    const { probe, writeFile, writeFileFenced } = setup();
    expect(await probe.writeGovernanceDocumentFenced(path, text, { state: 'absent' }, facts, 'Steven', 'zeus', expectedTarget)).toMatchObject({ error: 'conflict' });
    expect(writeFile).not.toHaveBeenCalled();
    expect(writeFileFenced).not.toHaveBeenCalled();
  });

  it('rechaza target omitido por un caller no tipado y facts sin generación', async () => {
    const { probe, writeFileFenced } = setup();
    expect(await probe.writeGovernanceDocumentFenced(path, text, { state: 'absent' }, facts, 'Steven', 'zeus', undefined as unknown as GovernanceWriteTarget)).toMatchObject({ error: 'conflict' });
    expect(await probe.writeGovernanceDocumentFenced(path, text, { state: 'absent' }, { harness: 'claude', home: facts.home }, 'Steven', 'zeus', target)).toMatchObject({ error: 'conflict' });
    expect(writeFileFenced).not.toHaveBeenCalled();
  });

  it('cliente viejo falla cerrado en modo cercado y conserva el legado', async () => {
    const writeFile = vi.fn(async () => ack);
    const probe = new TerminalRelayFactsProbe(source, { readFile, writeFile });
    expect(await probe.writeGovernanceDocumentFenced(path, text, { state: 'absent' }, facts, 'Steven', 'zeus', target)).toMatchObject({ error: 'unavailable' });
    expect(writeFile).not.toHaveBeenCalled();
    expect(await probe.writeGovernanceDocument(path, text, { state: 'absent' }, facts, 'Steven', 'zeus')).toEqual({ sha: ack.sha, bytes: ack.bytes });
    expect(writeFile).toHaveBeenCalledOnce();
  });
});
