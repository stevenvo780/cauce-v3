import { describe, expect, it } from 'vitest';
import { emptyAgentProfile } from '../src/agent-profile.js';
import { ficherosDelArnes, harnessDocumentPaths, nombresDelArnes, revisionDelPerfil } from '../src/ficheros-del-arnes.js';
import { HarnessConsumptionEvidenceSchema } from '../src/harness-consumption.js';

describe('Grok governance documents require a measured workspace without consumption claims', () => {
  it('resolves only AGENTS.md at the explicit canonical workspace', () => {
    expect(nombresDelArnes('grok')).toEqual(['AGENTS.md']);
    expect(harnessDocumentPaths('grok', { home: '/home/claw', grokWorkspace: '/workspace/project' })).toEqual(['/workspace/project/AGENTS.md']);
    expect(harnessDocumentPaths('grok', { home: '/home/claw' })).toEqual([]);
    for (const grokWorkspace of ['relative', '/', '/workspace/../project', '/workspace//project', '/workspace/\0project'])
      expect(harnessDocumentPaths('grok', { home: '/home/claw', grokWorkspace })).toEqual([]);
  });
  it('composes the authored profile and exact durable revision into the native document', () => {
    const profile = { ...emptyAgentProfile('Steven', 'hades'), purpose: 'Operate the durable bus.' };
    const result = ficherosDelArnes('grok', { perfil: profile, hechos: { permisos: { ruta: true, lectura: false, control: false, notificacion: false },
      cuotas: [], destinos: [], arnes: { harness: 'grok', home: '/home/claw', capacidades: [] } } }, new Map(), { revision: 7 });
    expect(result).toHaveLength(1); expect(result[0]?.nombre).toBe('AGENTS.md'); expect(result[0]?.escribir).toBe(true);
    expect(result[0]?.texto).toContain(profile.purpose); expect(revisionDelPerfil(result[0]?.texto ?? '')).toBe(7);
  });
  it('rejects invented Grok turn evidence until a native consumption contract is measured', () => {
    expect(HarnessConsumptionEvidenceSchema.safeParse({ version: 1, harness_id: 'grok', native_session_id: 'session', native_turn_id: 'invented',
      input_sha256: 'a'.repeat(64), evidence_kind: 'canonical_final_response' }).success).toBe(false);
  });
});
