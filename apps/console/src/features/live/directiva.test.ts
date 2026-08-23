import { describe, expect, it } from 'vitest';
import type { AgentDirective } from '../../api/types';
import { abreDeclarandoIdentidad, avisosDeCapas, girosDeAutonomia, totalDeMemoria } from './directiva';

/**
 * El aviso de solapamiento entre capas, probado solo.
 *
 * Cada caso positivo va con su CONTROL NEGATIVO: un guardia que marca todo es tan inútil como uno
 * que no marca nada, y este en concreto es fácil que grite en falso —«permiso» y «prohibido» son
 * palabras que un manual legítimo usa todo el rato—.
 */

/** El brief real de un alias de la flota, con la forma que tienen los 14 en producción. */
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
   * CONTROL NEGATIVO. Un manual de despliegue habla de permisos de fichero y de cosas prohibidas
   * sin estar fijando la autonomía de nadie. Si esto marcara, el aviso saldría en los 14 alias y
   * dejaría de significar nada.
   */
  it('NO marca un manual que habla de permisos de fichero o de rutas', () => {
    const manual = '# Cómo se despliega\n\nEl script necesita permiso de lectura sobre /etc/cauce.\n'
      + 'Las migraciones se aplican con `pnpm migrate`.';
    expect(girosDeAutonomia(manual)).toEqual([]);
  });

  it('un texto vacío o ausente no habla de autonomía, y no revienta', () => {
    expect(girosDeAutonomia('')).toEqual([]);
    expect(girosDeAutonomia(null)).toEqual([]);
    expect(girosDeAutonomia(undefined)).toEqual([]);
  });
});

describe('abreDeclarandoIdentidad', () => {
  it('marca el manual que abre con «Sos…», que es invadir la capa 1', () => {
    expect(abreDeclarandoIdentidad('# Manual\n\nSos janus, el operador de Miguel.\n')).toContain('Sos janus');
  });

  /** CONTROL NEGATIVO: la palabra en mitad de un párrafo no es una declaración de identidad. */
  it('NO marca un manual que menciona «sos vos quien despliega» en mitad del texto', () => {
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
   * CONTROL NEGATIVO del aviso entero. Con el reparto que el diseño propone —autonomía SÓLO en el
   * rol, manual sólo de cómo se trabaja— no puede salir ningún choque. Si saliera, el aviso sería
   * ruido permanente y el operador aprendería a ignorarlo.
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

  it('marca el caso janus: dos manuales a la vez, sin decidir cuál manda', () => {
    const avisos = avisosDeCapas(BRIEF_REAL, directiva({
      files: [
        { path: '~/.claude/CLAUDE.md', scope: 'user', text: '# flota\n' },
        { path: '~/CLAUDE.md', scope: 'workspace', text: '# espacio\n' },
      ],
    }));
    const dos = avisos.find((aviso) => aviso.id === 'dos-manuales');
    expect(dos?.titulo).toMatch(/2 manuales/);
    expect(dos?.evidencia).toEqual(['~/.claude/CLAUDE.md', '~/CLAUDE.md']);
  });

  it('marca el caso gaia: el servidor miró y no hay ningún manual', () => {
    const avisos = avisosDeCapas(BRIEF_REAL, directiva({ files: [] }));
    expect(avisos.find((aviso) => aviso.id === 'sin-manual')?.tono).toBe('hueco');
  });

  /**
   * EL CONTROL NEGATIVO QUE MÁS IMPORTA, y el que esta consola ya se equivocó en otras pantallas:
   * un negativo que nadie midió no es un hecho. Con el gateway sin publicar los ficheros, la
   * pantalla NO puede decir «este alias no tiene CLAUDE.md» ni «las capas no se pisan»: no se
   * miró. La lista de avisos tiene que salir VACÍA, no con el aviso de «sin manual».
   */
  it('sin el endpoint publicado no emite NINGÚN aviso sobre ficheros: no se miró', () => {
    const avisos = avisosDeCapas(BRIEF_REAL, { publicado: false, motivo: 'el gateway respondió 404' });
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
    // Y NO se inventa un choque sobre un texto que no llegó.
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
});
