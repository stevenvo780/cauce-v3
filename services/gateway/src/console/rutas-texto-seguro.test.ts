import { describe, expect, it, vi } from 'vitest';
import {
  type GovernanceRelayClient, type MeasuredFactsSource, type RelayDirectoryRead,
  type RuntimeFacts, TerminalRelayFactsProbe,
} from './agent-documents.js';
import type { GovernanceReadError } from './agent-documents.routes.js';
import { parseDirectoryOutcome } from './relay-governance-client.js';

/**
 * Una ruta de fichero no tiene uso legítimo para un anulador bidi ni para un carácter de ancho
 * cero: ambos bordes que reciben rutas del relay usan la misma seguridad de texto del protocolo.
 */

const CLAUDE: RuntimeFacts = { harness: 'claude', home: '/home/dev' };
const MEMORY_ROOT = '/home/dev/.claude/projects';
const SIN_HECHOS: MeasuredFactsSource = { factsFor: async () => undefined };
const BIDI = '‮';
const ANCHO_CERO = '‍';

function indice(nombre: string): RelayDirectoryRead {
  return {
    path: MEMORY_ROOT,
    total: 1,
    observed_at_least: 1,
    truncated: false,
    entries: [{ path: `${MEMORY_ROOT}/${nombre}`, bytes: 1, modified_at: '2026-08-24T10:00:00Z' }],
  };
}

function relayQueLista(answer: RelayDirectoryRead | GovernanceReadError): GovernanceRelayClient {
  return {
    readFile: vi.fn(async (): Promise<GovernanceReadError> => ({
      error: 'unavailable', reason: 'no aplica',
    })),
    listDirectory: vi.fn(async () => answer),
  };
}

describe('parseDirectoryOutcome rechaza rutas con puntos de código inseguros', () => {
  it.each([
    ['anulador bidi', `informe${BIDI}dm.md`],
    ['ancho cero', `informe${ANCHO_CERO}dm.md`],
  ])('rechaza el índice con %s en la ruta', (_etiqueta, nombre) => {
    expect(parseDirectoryOutcome(JSON.stringify(indice(nombre)))).toHaveProperty('error');
  });

  it('sigue admitiendo una ruta ordinaria', () => {
    expect(parseDirectoryOutcome(JSON.stringify(indice('informe.md')))).toEqual(indice('informe.md'));
  });

  it('no propaga el motivo de fallo del relay si trae un anulador bidi', () => {
    const fallo = { error: 'not_found', reason: `no existe${BIDI}` };

    expect(parseDirectoryOutcome(JSON.stringify(fallo))).toEqual({
      error: 'unknown', reason: 'el terminal-relay contestó un fallo de índice inválido',
    });
  });
});

describe('listMemoryDirectory rechaza rutas con puntos de código inseguros', () => {
  it.each([
    ['anulador bidi', `informe${BIDI}dm.md`],
    ['ancho cero', `informe${ANCHO_CERO}dm.md`],
  ])('rechaza la entrada de memoria con %s', async (_etiqueta, nombre) => {
    const probe = new TerminalRelayFactsProbe(SIN_HECHOS, relayQueLista(indice(nombre)));

    expect(await probe.listMemoryDirectory(MEMORY_ROOT, CLAUDE, 'Steven', 'zeus'))
      .toHaveProperty('error');
  });

  it('sigue admitiendo una entrada de memoria ordinaria', async () => {
    const probe = new TerminalRelayFactsProbe(SIN_HECHOS, relayQueLista(indice('informe.md')));

    expect(await probe.listMemoryDirectory(MEMORY_ROOT, CLAUDE, 'Steven', 'zeus')).toEqual({
      root: MEMORY_ROOT,
      total: 1,
      observed_at_least: 1,
      truncated: false,
      entries: [{ path: 'informe.md', bytes: 1, modified_at: '2026-08-24T10:00:00Z' }],
    });
  });
});
