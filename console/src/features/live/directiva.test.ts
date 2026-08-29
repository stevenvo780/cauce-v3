import { describe, expect, it } from 'vitest';
import type { AgentDirective } from '../../api/types';
import { abreDeclarandoIdentidad, avisosDeCapas, girosDeAutonomia, totalDeMemoria } from './directiva';

/**
 * The layer overlap warning, tested alone.
 *
 * Each positive case goes with its NEGATIVE CONTROL: a guard that flags everything is as
 * useless as one that flags nothing, and this one in particular is easy to scream false —
 * "permission" and "prohibition" are words a legitimate manual uses all the time.
 */

/** The real brief of a fleet alias, in the shape the 14 of them have in production. */
const BRIEF_REAL = 'Sos kant, el hub de coordinacion de la flota. AUTONOMIA: decidí y actuá vos. '
  + 'Pedí permiso SOLO si hay dinero o algo legal de por medio.';

function directiva(parcial: Partial<AgentDirective>): AgentDirective {
  return { publicado: true, container_id: 'claw-kant', files: [], memory: null, ...parcial };
}

describe('girosDeAutonomia', () => {
  it('reconoce la forma con la que la flota escribe REALMENTE la autonomía, con tilde y sin ella', () => {
    expect(girosDeAutonomia(BRIEF_REAL)).toEqual(
      expect.arrayContaining(['autonomía', 'decidí y actuá', 'pedir permiso']),
    );
    expect(girosDeAutonomia('AUTONOMÍA: decidí y actuá')).toContain('autonomía');
  });

  /**
   * NEGATIVE CONTROL. A deployment manual talks about file permissions and forbidden things
   * without fixing anyone's autonomy. If this flagged, the warning would show up for all 14
   * aliases and stop meaning anything.
   */
  it('NO marca un manual que habla de permisos de fichero o de rutas', () => {
    const manual = '# Cómo se despliega\n\nEl script necesita permiso de lectura sobre /etc/cauce.\n'
      + 'Producción migra dentro de `ops/scripts/deploy-release.sh deploy`; '
      + '`pnpm migrate:dev` queda sólo para una DB descartable con entorno explícito.';
    expect(girosDeAutonomia(manual)).toEqual([]);
  });

  it('un texto vacío o ausente no habla de autonomía, y no revienta', () => {
    expect(girosDeAutonomia('')).toEqual([]);
    expect(girosDeAutonomia(null)).toEqual([]);
    expect(girosDeAutonomia(undefined)).toEqual([]);
  });
});

describe('abreDeclarandoIdentidad', () => {
  it('flags the manual that opens with "Sos…", which is invading layer 1', () => {
    expect(abreDeclarandoIdentidad('# Manual\n\nSos janus, el operador de Miguel.\n')).toContain('Sos janus');
  });

  /** NEGATIVE CONTROL: the word in the middle of a paragraph is not an identity declaration. */
  it('does NOT flag a manual that mentions "sos vos quien despliega" in the middle of the text', () => {
    const manual = '# Despliegue\n\nCada desarrollador despliega lo suyo.\nAcá el repo vive en /workspace.\n'
      + 'Recordá que sos vos quien corre el rollout, no kant.';
    expect(abreDeclarandoIdentidad(manual)).toBeUndefined();
  });
});

describe('avisosDeCapas', () => {
  it('avisa cuando el rol y el CLAUDE.md hablan los dos de autonomía, y dice con qué giros', () => {
    const avisos = avisosDeCapas(BRIEF_REAL, directiva({
      files: [{
        path: '~/.claude/CLAUDE.md', scope: 'user',
        text: '# Cómo se trabaja acá\n\nAUTONOMIA: decidí y actuá vos, no preguntes.\n',
      }],
    }));
    const choque = avisos.find((aviso) => aviso.id.startsWith('autonomia-duplicada'));
    expect(choque?.tono).toBe('choque');
    expect(choque?.evidencia).toEqual(expect.arrayContaining(['autonomía', 'decidí y actuá']));
    expect(choque?.detalle).toMatch(/nadie va a saber cuál manda/i);
  });

  /**
   * NEGATIVE CONTROL of the whole warning. With the split the design proposes —autonomy ONLY
   * in the role, manual only about how to work— no clash can appear. If one did, the warning
   * would be permanent noise and the operator would learn to ignore it.
   */
  it('con las capas bien repartidas NO avisa de ningún choque', () => {
    const avisos = avisosDeCapas(BRIEF_REAL, directiva({
      files: [{
        path: '/workspace/CLAUDE.md', scope: 'workspace',
        text: '# Cauce V3\n\nEl repo vive en /workspace/cauce-v3. Se despliega con `cauce publicar`.\n'
          + 'Las pruebas: `pnpm test`.\n',
      }],
    }));
    expect(avisos.filter((aviso) => aviso.tono === 'choque')).toEqual([]);
  });

  it('Codex explica precedencia y deja de afirmar que no está decidido cuál manda', () => {
    const avisos = avisosDeCapas(BRIEF_REAL, directiva({
      manual_order: 'codex_precedence',
      files: [
        { path: '~/.claude/CLAUDE.md', scope: 'user', text: '# flota\n' },
        { path: '~/CLAUDE.md', scope: 'workspace', text: '# espacio\n' },
      ],
    }));
    const dos = avisos.find((aviso) => aviso.id === 'dos-manuales');
    expect(dos?.titulo).toMatch(/carga 2 manuales/);
    expect(dos?.detalle).toMatch(/más profundos.*precedencia.*override/u);
    expect(dos?.detalle).not.toMatch(/no está decidido/u);
    expect(dos?.evidencia).toEqual(['~/.claude/CLAUDE.md', '~/CLAUDE.md']);
  });

  it('Claude muestra orden de carga sin inventar una precedencia dura', () => {
    const dos = avisosDeCapas(BRIEF_REAL, directiva({
      manual_order: 'claude_load_order',
      files: [
        { path: '/home/dev/.claude/CLAUDE.md', text: '# user\n' },
        { path: '/workspace/CLAUDE.local.md', text: '# local\n' },
      ],
    })).find((aviso) => aviso.id === 'dos-manuales');
    expect(dos?.detalle).toMatch(/orden mostrado.*no.*precedencia/u);
  });

  it('marca el caso gaia: el servidor miró y no hay ningún manual', () => {
    const avisos = avisosDeCapas(BRIEF_REAL, directiva({ files: [] }));
    expect(avisos.find((aviso) => aviso.id === 'sin-manual')?.tono).toBe('hueco');
  });

  it('un timeout explícito no cuenta como fichero ni como ausencia', () => {
    const avisos = avisosDeCapas(BRIEF_REAL, directiva({
      files: [{
        path: '/workspace/CLAUDE.md', error: 'timeout', reason: 'sin respuesta', text: null,
      }],
    }));
    expect(avisos.find((aviso) => aviso.id.startsWith('lectura-fallida:'))?.detalle)
      .toMatch(/timeout.*no se toma como ausente ni como existente/iu);
    expect(avisos.map((aviso) => aviso.id)).not.toContain('sin-manual');
    expect(avisos.map((aviso) => aviso.id)).not.toContain('dos-manuales');
  });

  it('detecta duplicados por SHA aunque vivan en rutas distintas', () => {
    const avisos = avisosDeCapas(BRIEF_REAL, directiva({
      files: [
        { path: '/a/CLAUDE.md', text: '# igual\n', sha: 'a'.repeat(64) },
        { path: '/b/CLAUDE.md', text: '# igual\n', sha: 'a'.repeat(64) },
      ],
    }));
    expect(avisos.find((aviso) => aviso.id.startsWith('manuales-duplicados:'))?.evidencia)
      .toEqual(['/a/CLAUDE.md', '/b/CLAUDE.md']);
  });

  /**
   * THE NEGATIVE CONTROL THAT MATTERS MOST, and the one this console has already gotten wrong
   * on other screens: a negative nobody measured is not a fact. With the gateway not
   * publishing the files, the screen CANNOT say "this alias has no CLAUDE.md" or "the layers
   * do not clash": nobody looked. The warning list must come out EMPTY, not with a "no
   * manual" warning.
   */
  it('sin el endpoint publicado no emite NINGÚN aviso sobre ficheros: no se miró', () => {
    const avisos = avisosDeCapas(BRIEF_REAL, { publicado: false, motivo: 'el gateway respondió 404' });
    expect(avisos).toEqual([]);
    expect(avisos.map((aviso) => aviso.id)).not.toContain('sin-manual');
  });

  it.each([
    ['el gateway declara medido:false', directiva({ medido: false, files: [] })],
    ['un gateway legacy devuelve files:null', directiva({ files: null })],
  ])('%s: no inventa que el servidor miró ni que falta el manual', (_caso, respuesta) => {
    const avisos = avisosDeCapas(BRIEF_REAL, respuesta);
    expect(avisos).toEqual([]);
    expect(avisos.map((aviso) => aviso.id)).not.toContain('sin-manual');
  });

  it('un fichero listado SIN contenido se declara incotejable, en vez de darlo por limpio', () => {
    const avisos = avisosDeCapas(BRIEF_REAL, directiva({
      files: [{ path: '~/.claude/CLAUDE.md', scope: 'user', bytes: 2079 }],
    }));
    const nota = avisos.find((aviso) => aviso.id.startsWith('sin-texto'));
    expect(nota?.tono).toBe('nota');
    expect(nota?.detalle).toMatch(/No es «no la repite»/);
    // And it does NOT invent a clash over a text that never arrived.
    expect(avisos.filter((aviso) => aviso.id.startsWith('autonomia-duplicada'))).toEqual([]);
  });

  it('avisa del hueco cuando el rol NO fija la autonomía que sólo él debería fijar', () => {
    const avisos = avisosDeCapas('Sos tales, SIN ROL ASIGNADO.', directiva({
      files: [{ path: '~/.claude/CLAUDE.md', scope: 'user', text: '# manual\n' }],
    }));
    expect(avisos.find((aviso) => aviso.id === 'brief-sin-autonomia')?.tono).toBe('hueco');
  });
});

describe('totalDeMemoria', () => {
  it('prefiere el total del servidor al largo de la lista, que puede venir recortada', () => {
    expect(totalDeMemoria({ publicado: true, memory: { total: 18_212, truncated: true, entries: [{ path: 'a' }] } }))
      .toBe(18_212);
  });

  it('sin memoria publicada devuelve undefined, que NO es cero', () => {
    expect(totalDeMemoria({ publicado: false })).toBeUndefined();
    expect(totalDeMemoria(undefined)).toBeUndefined();
    expect(totalDeMemoria({ publicado: true, memory: { total: 0, entries: [] } })).toBe(0);
  });

  it('devuelve el límite inferior sin inventarlo como total exacto', () => {
    expect(totalDeMemoria({
      publicado: true,
      memory: { total: null, observed_at_least: 5_000, truncated: true, entries: [] },
    })).toBe(5_000);
  });

  it('un error discriminado no se convierte en cero', () => {
    expect(totalDeMemoria({
      publicado: true,
      memory: { error: 'timeout', reason: 'el agente no contestó' },
    })).toBeUndefined();
  });
});
