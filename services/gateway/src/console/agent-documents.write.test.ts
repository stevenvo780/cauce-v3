import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  GovernanceBatchWrite, GovernanceReadError, GovernanceWritePrecondition,
} from './agent-documents.routes.js';
import {
  type GovernanceRelayClient, type MeasuredFactsSource, type RelayFileWrite,
  type RelayFileWriteBatch, type RuntimeFacts, TerminalRelayFactsProbe,
  verifyWritableProfilePath,
} from './agent-documents.js';

const CLAUDE: RuntimeFacts = { harness: 'claude', home: '/home/dev' };
const CLAUDE_PATH = '/home/dev/.claude/CLAUDE.md';
const OPENCLAW: RuntimeFacts = {
  harness: 'openclaw', home: '/home/claw', openclawWorkspace: '/home/claw/workspace',
};
const SIN_HECHOS: MeasuredFactsSource = { factsFor: async () => undefined };
const SIN_LECTURA: GovernanceReadError = { error: 'unavailable', reason: 'no aplica' };

function sha(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function relay(options: {
  readonly writeFile?: NonNullable<GovernanceRelayClient['writeFile']>;
  readonly writeFiles?: NonNullable<GovernanceRelayClient['writeFiles']>;
}): GovernanceRelayClient {
  return {
    readFile: vi.fn(async () => SIN_LECTURA),
    ...(options.writeFile === undefined ? {} : { writeFile: options.writeFile }),
    ...(options.writeFiles === undefined ? {} : { writeFiles: options.writeFiles }),
  };
}

function writeAck(content: string, overrides: Partial<RelayFileWrite> = {}): RelayFileWrite {
  return {
    path: CLAUDE_PATH,
    operation: 'create',
    sha: sha(content),
    bytes: Buffer.byteLength(content, 'utf8'),
    ...overrides,
  };
}

describe('la escritura gobernada exige evidencia exacta del relay', () => {
  it('acepta sólo el ACK que acredita ruta, operación, huella y bytes solicitados', async () => {
    const content = '# Directiva\n';
    const writeFile = vi.fn(async () => writeAck(content));
    const probe = new TerminalRelayFactsProbe(SIN_HECHOS, relay({ writeFile }));
    const precondition: GovernanceWritePrecondition = { state: 'absent' };

    expect(await probe.writeGovernanceDocument(
      CLAUDE_PATH, content, precondition, CLAUDE, 'Steven', 'zeus',
    )).toEqual({ sha: sha(content), bytes: Buffer.byteLength(content, 'utf8') });
    expect(writeFile).toHaveBeenCalledWith(
      'Steven', 'zeus', CLAUDE_PATH, content, precondition,
    );
  });

  it.each([
    ['ruta', { path: '/home/dev/.claude/OTRO.md' }],
    ['operación', { operation: 'replace' as const }],
    ['huella', { sha: '0'.repeat(64) }],
    ['bytes', { bytes: 999 }],
  ])('rechaza un ACK con %s distinta de la solicitud', async (_field, override) => {
    const content = '# Directiva\n';
    const probe = new TerminalRelayFactsProbe(SIN_HECHOS, relay({
      writeFile: async () => writeAck(content, override),
    }));

    expect(await probe.writeGovernanceDocument(
      CLAUDE_PATH, content, { state: 'absent' }, CLAUDE, 'Steven', 'zeus',
    )).toEqual({ error: 'unknown', reason: 'el ACK del relay no acredita el contenido solicitado' });
  });
});

describe('el lote gobernado acredita cada fichero una sola vez', () => {
  const content = '# Alma\n';
  const writes: readonly GovernanceBatchWrite[] = [
    {
      mode: 'write', path: '/home/claw/workspace/SOUL.md', content,
      precondition: { state: 'absent' },
    },
    {
      mode: 'verify', path: '/home/claw/workspace/IDENTITY.md',
      precondition: { state: 'present', sha256: 'a'.repeat(64) },
    },
  ];

  function batch(files: RelayFileWriteBatch['files']): RelayFileWriteBatch {
    return { files };
  }

  it('devuelve los dos ACK completos en el orden solicitado', async () => {
    const files: RelayFileWriteBatch['files'] = [
      {
        path: writes[0]?.path ?? expect.unreachable('falta la escritura'),
        operation: 'create', sha: sha(content), bytes: Buffer.byteLength(content, 'utf8'),
      },
      {
        path: writes[1]?.path ?? expect.unreachable('falta la verificación'),
        operation: 'unchanged', sha: 'a'.repeat(64), bytes: 17,
      },
    ];
    const probe = new TerminalRelayFactsProbe(SIN_HECHOS, relay({
      writeFiles: async () => batch(files),
    }));

    expect(await probe.writeGovernanceBatch(writes, OPENCLAW, 'Steven', 'jarvis')).toEqual(files);
  });

  it('rechaza un lote cuyo ACK repite una ruta y omite otra', async () => {
    const repeated = writes[0]?.path ?? expect.unreachable('falta la escritura');
    const probe = new TerminalRelayFactsProbe(SIN_HECHOS, relay({
      writeFiles: async () => batch([
        { path: repeated, operation: 'create', sha: sha(content), bytes: 7 },
        { path: repeated, operation: 'unchanged', sha: 'a'.repeat(64), bytes: 17 },
      ]),
    }));

    expect(await probe.writeGovernanceBatch(writes, OPENCLAW, 'Steven', 'jarvis')).toEqual({
      error: 'unknown', reason: 'el ACK del lote repite documentos',
    });
  });
});

describe('la ruta de perfil queda cerrada al destino medido', () => {
  it('acepta el fichero exacto y rechaza enlaces aunque su nombre solicitado sea válido', () => {
    expect(verifyWritableProfilePath(CLAUDE, CLAUDE_PATH)).toEqual({ allowed: true });
    expect(verifyWritableProfilePath(
      CLAUDE, CLAUDE_PATH, '/datos/agents/shared/.claude/CLAUDE.md',
    )).toEqual({ allowed: false, reason: 'la ruta del perfil es un enlace' });
    expect(verifyWritableProfilePath(
      CLAUDE, CLAUDE_PATH, '/home/dev/.claude/.credentials.json',
    )).toEqual({ allowed: false, reason: 'el destino parece material sensible' });
  });
});
