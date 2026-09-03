import { describe, expect, it } from 'vitest';
import { MARCA_PERFIL_FIN, MARCA_PERFIL_INICIO } from '@cauce/protocol';
import {
  ContextContaminationTelemetry, evaluarContaminacion,
  type MeasuredContext, type RecordedContextExpectation,
} from './contaminacion-de-contexto.js';

function conBloqueDe(alias: string): string {
  return [
    '# CLAUDE.md',
    MARCA_PERFIL_INICIO,
    `<!-- alias: ${alias} -->`,
    'texto gobernado que no debe aparecer en ningún veredicto',
    MARCA_PERFIL_FIN,
    '',
  ].join('\n');
}

const sha = (letter: string): string => letter.repeat(64);

function medido(overrides: Partial<MeasuredContext> = {}): MeasuredContext {
  return {
    owner: { tenant_id: 'Steven', alias: 'argos' },
    generation: 'gen-viva',
    documents: [{
      name: 'CLAUDE.md',
      path: '/home/dev/CLAUDE.md',
      sha: sha('a'),
      text: conBloqueDe('Steven/argos'),
    }],
    ...overrides,
  };
}

const esperado: RecordedContextExpectation = {
  generation: 'gen-viva',
  documents: [{ name: 'CLAUDE.md', path: '/home/dev/CLAUDE.md', sha: sha('a') }],
};

describe('evaluarContaminacion', () => {
  it('accepts the alias own managed block matching the live expectation', () => {
    expect(evaluarContaminacion(medido(), esperado)).toEqual({
      contaminated: false, findings: [],
    });
  });

  it('quarantines a managed block belonging to another alias and names its owner', () => {
    const verdict = evaluarContaminacion(medido({
      documents: [{
        name: 'CLAUDE.md',
        path: '/home/dev/CLAUDE.md',
        sha: sha('a'),
        text: conBloqueDe('Miguel/kratos'),
      }],
    }), esperado);
    expect(verdict.contaminated).toBe(true);
    expect(verdict.findings).toEqual([{
      reason: 'foreign_managed_block',
      document: 'CLAUDE.md',
      path: '/home/dev/CLAUDE.md',
      owner: 'Miguel/kratos',
    }]);
    // The verdict travels into an HTTP body and an audit row: not one byte of the block may ride it.
    expect(JSON.stringify(verdict)).not.toContain('texto gobernado');
  });

  it('quarantines a fingerprint that disagrees with the expectation of the live generation', () => {
    const verdict = evaluarContaminacion(medido({
      documents: [{
        name: 'CLAUDE.md', path: '/home/dev/CLAUDE.md', sha: sha('b'), text: conBloqueDe('Steven/argos'),
      }],
    }), esperado);
    expect(verdict.findings).toEqual([{
      reason: 'expectation_sha_mismatch',
      document: 'CLAUDE.md',
      path: '/home/dev/CLAUDE.md',
      expected_sha: sha('a'),
      observed_sha: sha('b'),
    }]);
  });

  /** Drift against a dead generation is what a reload fixes; calling it contamination would
   * quarantine the remedy and leave the alias stuck forever. */
  it('ignores an expectation recorded for a generation that is no longer alive', () => {
    const stale: RecordedContextExpectation = { ...esperado, generation: 'gen-anterior' };
    expect(evaluarContaminacion(medido({
      documents: [{
        name: 'CLAUDE.md', path: '/home/dev/CLAUDE.md', sha: sha('b'), text: null,
      }],
    }), stale).contaminated).toBe(false);
  });

  it('ignores the fingerprint when the measured presence publishes no generation', () => {
    expect(evaluarContaminacion(medido({
      generation: null,
      documents: [{ name: 'CLAUDE.md', path: '/home/dev/CLAUDE.md', sha: sha('b'), text: null }],
    }), esperado).contaminated).toBe(false);
  });

  it('does not judge ownership from a text it could not read whole', () => {
    expect(evaluarContaminacion(medido({
      documents: [{ name: 'CLAUDE.md', path: '/home/dev/CLAUDE.md', sha: sha('a'), text: null }],
    }), esperado).contaminated).toBe(false);
  });

  it('does not compare a document the expectation resolves to a different path', () => {
    const otroSitio: RecordedContextExpectation = {
      generation: 'gen-viva',
      documents: [{ name: 'CLAUDE.md', path: '/home/otro/CLAUDE.md', sha: sha('c') }],
    };
    expect(evaluarContaminacion(medido(), otroSitio).contaminated).toBe(false);
  });

  it('reports an absent file whose expectation demands a fingerprint', () => {
    const verdict = evaluarContaminacion(medido({
      documents: [{ name: 'CLAUDE.md', path: '/home/dev/CLAUDE.md', sha: null, text: null }],
    }), esperado);
    expect(verdict.findings[0]).toMatchObject({
      reason: 'expectation_sha_mismatch', observed_sha: null,
    });
  });

  it('reports both reasons when one file carries both', () => {
    const verdict = evaluarContaminacion(medido({
      documents: [{
        name: 'CLAUDE.md', path: '/home/dev/CLAUDE.md', sha: sha('b'), text: conBloqueDe('Isa/salva'),
      }],
    }), esperado);
    expect(verdict.findings.map((finding) => finding.reason)).toEqual([
      'foreign_managed_block', 'expectation_sha_mismatch',
    ]);
  });
});

describe('ContextContaminationTelemetry', () => {
  it('counts every reason of a verdict under a fixed label vocabulary', () => {
    const telemetry = new ContextContaminationTelemetry();
    expect(telemetry.snapshot()).toEqual({
      foreign_managed_block: 0, expectation_sha_mismatch: 0,
    });
    telemetry.recordVerdict(evaluarContaminacion(medido({
      documents: [{
        name: 'CLAUDE.md', path: '/home/dev/CLAUDE.md', sha: sha('b'), text: conBloqueDe('Isa/salva'),
      }],
    }), esperado));
    expect(telemetry.snapshot()).toEqual({
      foreign_managed_block: 1, expectation_sha_mismatch: 1,
    });
  });
});
