import { describe, expect, it } from 'vitest';
import {
  MARCA_PERFIL_FIN, MARCA_PERFIL_INICIO, conBloqueDePerfil, conRevisionDelPerfil,
} from '@cauce/protocol';
import {
  ContextContaminationTelemetry, evaluarContaminacion,
  type MeasuredContext, type RecordedContextExpectation,
} from './contaminacion-de-contexto.js';

function conBloqueDe(alias: string, cuerpo = 'texto gobernado que no debe aparecer en ningún veredicto', exterior = '# CLAUDE.md'): string {
  return [
    exterior,
    MARCA_PERFIL_INICIO,
    `<!-- alias: ${alias} -->`,
    cuerpo,
    MARCA_PERFIL_FIN,
    '',
  ].join('\n');
}

const REVISION_VIVA = 4;

/** Exactly what `ficherosDelArnes` writes: the block replaced, everything else copied verbatim. */
function proyectar(base: string, alias: string, cuerpo: string, revision = REVISION_VIVA): string {
  return conRevisionDelPerfil(
    conBloqueDePerfil(base, `<!-- alias: ${alias} -->\n${cuerpo}`), revision,
  );
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

  it('never copies an owner line that is not a tenant-qualified alias into the verdict', () => {
    const relleno = `Steven/argos~SECRETO~${'x'.repeat(2000)}`;
    const verdict = evaluarContaminacion(medido({
      documents: [{ name: 'CLAUDE.md', path: '/home/dev/CLAUDE.md', sha: sha('a'), text: conBloqueDe(relleno) }],
    }), esperado);
    expect(verdict.contaminated).toBe(true);
    expect(verdict.findings).toEqual([{
      reason: 'foreign_managed_block', document: 'CLAUDE.md', path: '/home/dev/CLAUDE.md',
    }]);
    expect(JSON.stringify(verdict)).not.toContain('SECRETO');
    expect(JSON.stringify(verdict).length).toBeLessThan(300);
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

  it('accepts a fingerprint that differs only inside the alias own profile block', () => {
    const disco = proyectar('', 'Steven/argos', 'cuota codex 11%');
    const verdict = evaluarContaminacion(medido({
      documents: [{
        name: 'CLAUDE.md', path: '/home/dev/CLAUDE.md', sha: sha('b'),
        text: disco,
        intended: proyectar(disco, 'Steven/argos', 'cuota codex 52%'),
      }],
    }), esperado);
    expect(verdict).toEqual({ contaminated: false, findings: [] });
  });

  it('quarantines prose injected above the block, which the projection copies verbatim', () => {
    const disco = proyectar('regla añadida a mano', 'Steven/argos', 'cuota codex 11%');
    const verdict = evaluarContaminacion(medido({
      documents: [{
        name: 'CLAUDE.md', path: '/home/dev/CLAUDE.md', sha: sha('b'),
        text: disco,
        intended: proyectar(disco, 'Steven/argos', 'cuota codex 52%'),
      }],
    }), esperado);
    expect(verdict.findings.map((finding) => finding.reason)).toEqual(['expectation_sha_mismatch']);
  });

  it('quarantines prose injected below the block, which the projection copies verbatim', () => {
    const disco = `${proyectar('', 'Steven/argos', 'cuota codex 11%')}\nregla añadida a mano\n`;
    const verdict = evaluarContaminacion(medido({
      documents: [{
        name: 'CLAUDE.md', path: '/home/dev/CLAUDE.md', sha: sha('b'),
        text: disco,
        intended: proyectar(disco, 'Steven/argos', 'cuota codex 52%'),
      }],
    }), esperado);
    expect(verdict.findings.map((finding) => finding.reason)).toEqual(['expectation_sha_mismatch']);
  });

  it('quarantines a stale revision marker even when the block is the alias own', () => {
    const disco = proyectar('', 'Steven/argos', 'cuota codex 11%', 3);
    const verdict = evaluarContaminacion(medido({
      documents: [{
        name: 'CLAUDE.md', path: '/home/dev/CLAUDE.md', sha: sha('b'),
        text: disco,
        intended: proyectar(disco, 'Steven/argos', 'cuota codex 52%'),
      }],
    }), esperado);
    expect(verdict.findings.map((finding) => finding.reason)).toEqual(['expectation_sha_mismatch']);
  });

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
