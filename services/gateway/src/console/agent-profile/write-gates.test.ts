import { describe, expect, it } from 'vitest';
import { MARCA_PERFIL_FIN, MARCA_PERFIL_INICIO } from '@cauce/protocol';
import {
  DOCUMENT_REASON_MAX, DOCUMENT_REASON_MIN,
} from '../agent-documents/write-admission.js';
import type { MeasuredContext } from '../contaminacion-de-contexto.js';
import {
  admitProfileWrite, isRejectedProfileWrite, perfilAuditMetadata, veredictoDeContaminacion,
} from './write-gates.js';

const PERFIL = {
  purpose: 'coordinar la flota',
  role_summary: 'coordinador',
  human_brief: 'Steven, directo',
  responsibilities: ['coordinar'],
  restrictions: ['no tocar secretos'],
  tools: ['cauce'],
  operating_rules: ['verificar'],
};

const MOTIVO = 'recorto las responsabilidades que ya no le tocan';

function cuerpo(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { expected_revision: 1, profile: PERFIL, reason: MOTIVO, ...extra };
}

function admitir(body: unknown) {
  return admitProfileWrite(body, 'Steven', 'zeus');
}

describe('el motivo del PUT del perfil es el mismo que el de la escritura de un documento', () => {
  it('admite un motivo escrito a mano y lo recorta', () => {
    const admitido = admitir(cuerpo({ reason: `  ${MOTIVO}  ` }));
    expect(isRejectedProfileWrite(admitido)).toBe(false);
    if (isRejectedProfileWrite(admitido)) return;
    expect(admitido.reason).toBe(MOTIVO);
    expect(admitido.expected_revision).toBe(1);
    expect(admitido.profile).toMatchObject({ tenant_id: 'Steven', alias: 'zeus', ...PERFIL });
  });

  it('sin `reason` responde 400 nombrando el campo, y nunca inventa uno', () => {
    const { profile, expected_revision: esperada } = cuerpo();
    const admitido = admitir({ profile, expected_revision: esperada });
    expect(isRejectedProfileWrite(admitido)).toBe(true);
    if (!isRejectedProfileWrite(admitido)) return;
    expect(admitido).toMatchObject({
      status: 400, body: { error: 'invalid_input', field: 'reason' },
    });
  });

  it.each([
    ['por debajo del mínimo', 'a'.repeat(DOCUMENT_REASON_MIN - 1)],
    ['por encima del máximo', 'a'.repeat(DOCUMENT_REASON_MAX + 1)],
    ['sólo espacios', ' '.repeat(DOCUMENT_REASON_MAX)],
    ['no es texto', 42],
  ])('rechaza un motivo %s con los topes del documento', (_caso, reason) => {
    const admitido = admitir(cuerpo({ reason }));
    expect(isRejectedProfileWrite(admitido)).toBe(true);
    if (!isRejectedProfileWrite(admitido)) return;
    expect(admitido.body.field).toBe('reason');
  });

  it('acepta exactamente los topes que aplica la escritura de documentos', () => {
    for (const largo of [DOCUMENT_REASON_MIN, DOCUMENT_REASON_MAX]) {
      const admitido = admitir(cuerpo({ reason: 'm'.repeat(largo) }));
      expect(isRejectedProfileWrite(admitido)).toBe(false);
    }
  });
});

describe('la forma del cuerpo del PUT', () => {
  it.each([
    ['un campo desconocido', cuerpo({ apply: true })],
    ['sin expected_revision', { profile: PERFIL, reason: MOTIVO }],
    ['una expected_revision que no es entero positivo', cuerpo({ expected_revision: 0 })],
    ['un profile con un campo que no existe', cuerpo({ profile: { ...PERFIL, extra: 'x' } })],
    ['un cuerpo que no es objeto', 'guardame el perfil'],
  ])('rechaza %s con 400', (_caso, body) => {
    const admitido = admitir(body);
    expect(isRejectedProfileWrite(admitido)).toBe(true);
    if (!isRejectedProfileWrite(admitido)) return;
    expect(admitido.status).toBe(400);
  });

  it('un valor de perfil inválido sigue siendo 422 con su campo', () => {
    const admitido = admitir(cuerpo({ profile: { ...PERFIL, responsibilities: [7] } }));
    expect(isRejectedProfileWrite(admitido)).toBe(true);
    if (!isRejectedProfileWrite(admitido)) return;
    expect(admitido.status).toBe(422);
    expect(admitido.body.field).toBe('responsibilities');
  });
});

describe('los metadatos de la fila de auditoría', () => {
  it('nombran a la persona y al motivo, y no llevan ningún cuerpo de campo', () => {
    const metadata = perfilAuditMetadata({
      actor: { tenant_id: 'Steven', alias: 'zeus' },
      target: { tenant_id: 'Miguel', alias: 'kratos' },
      operador: { operator_id: 'steven@elenxos', attributed: true },
      reason: MOTIVO,
    }, { revision: 4, bytes: 128 });

    expect(metadata).toMatchObject({
      operator_id: 'steven@elenxos', attributed: true, operator_reason: MOTIVO,
      actor: 'Steven:zeus', target_tenant: 'Miguel', target_alias: 'kratos',
      operation: 'profile_write', revision: 4, bytes: 128,
    });
    expect(JSON.stringify(metadata)).not.toContain('coordinar la flota');
  });
});

describe('el veredicto de contaminación del perfil', () => {
  const medido: MeasuredContext = {
    owner: { tenant_id: 'Steven', alias: 'zeus' },
    generation: 'gen-viva',
    documents: [{
      name: 'CLAUDE.md',
      path: '/home/dev/.claude/CLAUDE.md',
      sha: 'a'.repeat(64),
      text: [
        '# CLAUDE.md', MARCA_PERFIL_INICIO, '<!-- alias: Miguel/kratos -->',
        'perfil proyectado', MARCA_PERFIL_FIN, '',
      ].join('\n'),
    }],
  };

  it('sin sonda que mida el contexto no inventa hallazgos', async () => {
    expect(await veredictoDeContaminacion(undefined, undefined, 'Steven', 'zeus'))
      .toEqual({ contaminated: false, findings: [] });
  });

  it('una medición que no acredita nada tampoco produce hallazgos', async () => {
    expect(await veredictoDeContaminacion(async () => undefined, undefined, 'Steven', 'zeus'))
      .toEqual({ contaminated: false, findings: [] });
  });

  it('un bloque gestionado de otro alias nombra a su dueño', async () => {
    const veredicto = await veredictoDeContaminacion(
      async () => medido, undefined, 'Steven', 'zeus',
    );
    expect(veredicto.contaminated).toBe(true);
    expect(veredicto.findings[0]).toMatchObject({
      reason: 'foreign_managed_block', owner: 'Miguel/kratos',
    });
    expect(JSON.stringify(veredicto)).not.toContain('perfil proyectado');
  });
});
