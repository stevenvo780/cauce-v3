import { describe, expect, it } from 'vitest';
import {
  PASO_DE_PAGINA, TOPE_DE_PAGINA, actorDeRevision, camposCambiados, camposDeRevision,
  compararDocumentos, compararRevisiones, cursorSiguiente, diffDeLineas, fechaDeDocumento,
  fechaDePerfil, fusionar, huellaCorta, lineasDelCampo, ordenadas, pasoDelDiario, siguientePedido,
} from './historial-de-contexto';
import type { DocumentoRevision, PerfilRevision } from './perfil';

function revision(parcial: Partial<PerfilRevision> = {}): PerfilRevision {
  return {
    id: '1',
    tenant_id: 'Steven',
    alias: 'kant',
    revision: 1,
    operation: 'update',
    purpose: 'Coordinar la flota.',
    role_summary: 'PMO de la flota.',
    human_brief: 'Steven.',
    responsibilities: ['Coordinar', 'Perseguir lo pendiente'],
    restrictions: ['No inventar'],
    tools: ['terminal'],
    operating_rules: ['Verificar'],
    actor_tenant: null,
    actor_alias: null,
    changed_at: '2026-08-30T10:00:00.000Z',
    ...parcial,
  };
}

function documento(parcial: Partial<DocumentoRevision> = {}): DocumentoRevision {
  return {
    id: '1',
    tenant_id: 'Steven',
    alias: 'kant',
    kind: 'directive',
    path: '/home/stev/.claude/CLAUDE.md',
    sha256: 'a'.repeat(64),
    bytes: 240,
    actor_tenant: null,
    actor_alias: null,
    written_at: '2026-08-30T10:00:00.000Z',
    ...parcial,
  };
}

describe('quién hizo el cambio', () => {
  it('junta tenant y alias cuando el diario los anotó', () => {
    expect(actorDeRevision({ actor_tenant: 'Steven', actor_alias: 'zeus' })).toBe('Steven/zeus');
  });

  it('sin columnas de autor no devuelve nada, para que la vista diga «no consta quién»', () => {
    expect(actorDeRevision({ actor_tenant: null, actor_alias: null })).toBeUndefined();
    expect(actorDeRevision({ actor_tenant: '   ', actor_alias: null })).toBeUndefined();
  });

  it('con una sola columna no inventa la otra', () => {
    expect(actorDeRevision({ actor_tenant: null, actor_alias: 'zeus' })).toBe('zeus');
    expect(actorDeRevision({ actor_tenant: 'Steven', actor_alias: null })).toBe('Steven');
  });
});

describe('la instantánea que se restaura', () => {
  it('lleva los siete campos, no sólo el rol', () => {
    expect(camposDeRevision(revision())).toEqual({
      purpose: 'Coordinar la flota.',
      role_summary: 'PMO de la flota.',
      human_brief: 'Steven.',
      responsibilities: ['Coordinar', 'Perseguir lo pendiente'],
      restrictions: ['No inventar'],
      tools: ['terminal'],
      operating_rules: ['Verificar'],
    });
  });

  it('un borrado deja los siete campos vacíos y no rellena ninguno', () => {
    const campos = camposDeRevision(revision({
      operation: 'delete',
      purpose: null,
      role_summary: null,
      human_brief: null,
      responsibilities: [],
      restrictions: [],
      tools: [],
      operating_rules: [],
    }));
    expect(campos).toEqual({
      purpose: '', role_summary: '', human_brief: '',
      responsibilities: [], restrictions: [], tools: [], operating_rules: [],
    });
  });

  it('copia las listas: editar el borrador no toca la revisión leída', () => {
    const original = revision();
    const campos = camposDeRevision(original);
    campos.responsibilities.push('lo que se le ocurra al borrador');
    expect(original.responsibilities).toEqual(['Coordinar', 'Perseguir lo pendiente']);
  });
});

describe('las líneas de cada campo', () => {
  it('un texto libre se parte por líneas y uno vacío no aporta ninguna', () => {
    expect(lineasDelCampo(revision({ purpose: 'una\notra' }), 'purpose')).toEqual(['una', 'otra']);
    expect(lineasDelCampo(revision({ purpose: '' }), 'purpose')).toEqual([]);
    expect(lineasDelCampo(revision({ purpose: null }), 'purpose')).toEqual([]);
  });

  it('una lista aporta una línea por entrada', () => {
    expect(lineasDelCampo(revision(), 'responsibilities'))
      .toEqual(['Coordinar', 'Perseguir lo pendiente']);
  });
});

describe('el diff línea a línea', () => {
  it('conserva lo igual y marca lo quitado y lo agregado', () => {
    expect(diffDeLineas(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([
      { clase: 'igual', texto: 'a' },
      { clase: 'quitada', texto: 'b' },
      { clase: 'agregada', texto: 'x' },
      { clase: 'igual', texto: 'c' },
    ]);
  });

  it('una entrada insertada en medio no reescribe las que no cambiaron', () => {
    expect(diffDeLineas(['a', 'c'], ['a', 'b', 'c'])).toEqual([
      { clase: 'igual', texto: 'a' },
      { clase: 'agregada', texto: 'b' },
      { clase: 'igual', texto: 'c' },
    ]);
  });

  it('de vacío a algo son todas agregadas, y al revés todas quitadas', () => {
    expect(diffDeLineas([], ['a'])).toEqual([{ clase: 'agregada', texto: 'a' }]);
    expect(diffDeLineas(['a'], [])).toEqual([{ clase: 'quitada', texto: 'a' }]);
  });

  it('dos listas enormes degradan a quitado y agregado en vez de colgar la pestaña', () => {
    const antes = Array.from({ length: 300 }, (_unused, i) => `linea ${String(i)}`);
    const despues = [...antes];
    const salida = diffDeLineas(antes, despues);
    expect(salida).toHaveLength(600);
    expect(salida.every((linea) => linea.clase !== 'igual')).toBe(true);
  });
});

describe('comparar dos revisiones del perfil', () => {
  it('devuelve los siete campos aunque sólo cambie uno', () => {
    const comparacion = compararRevisiones(revision(), revision({ role_summary: 'Otro rol.' }));
    expect(comparacion).toHaveLength(7);
    expect(camposCambiados(comparacion).map((campo) => campo.campo)).toEqual(['role_summary']);
  });

  it('un campo sin cambios no se marca como cambiado', () => {
    const comparacion = compararRevisiones(revision(), revision());
    expect(camposCambiados(comparacion)).toEqual([]);
    expect(comparacion.every((campo) => campo.lineas.every((linea) => linea.clase === 'igual')))
      .toBe(true);
  });

  it('una lista se compara entrada por entrada, no como un bloque de texto', () => {
    const comparacion = compararRevisiones(
      revision(),
      revision({ responsibilities: ['Coordinar', 'Desplegar'] }),
    );
    const responsabilidades = comparacion.find((campo) => campo.campo === 'responsibilities');
    expect(responsabilidades?.lineas).toEqual([
      { clase: 'igual', texto: 'Coordinar' },
      { clase: 'quitada', texto: 'Perseguir lo pendiente' },
      { clase: 'agregada', texto: 'Desplegar' },
    ]);
  });
});

describe('comparar dos escrituras de un fichero', () => {
  it('dice si la huella cambió y cuánto creció el fichero', () => {
    expect(compararDocumentos(documento(), documento({ sha256: 'b'.repeat(64), bytes: 300 })))
      .toEqual({ huella: 'distinta', bytes: 60, movido: false });
  });

  it('la misma huella se declara igual, no «sin cambios» a ojo', () => {
    expect(compararDocumentos(documento(), documento({ bytes: 240 })).huella).toBe('igual');
  });

  it('sin huella no se afirma ni igual ni distinta', () => {
    expect(compararDocumentos(documento({ sha256: null }), documento()).huella).toBe('sin-dato');
  });

  it('un cambio de ruta se nombra: no es el mismo fichero en otro sitio por casualidad', () => {
    expect(compararDocumentos(documento(), documento({ path: '/otro/CLAUDE.md' })).movido)
      .toBe(true);
  });

  it('la huella se acorta para que quepa, y la ausencia se dice con palabras', () => {
    expect(huellaCorta('a'.repeat(64))).toBe('aaaaaaaaaaaa');
    expect(huellaCorta(null)).toBe('sin huella');
  });
});

describe('el orden y la unión de páginas', () => {
  it('el más nuevo arriba, y el id no ordena como texto', () => {
    const entradas = [
      revision({ id: '9', changed_at: '2026-08-29T10:00:00.000Z' }),
      revision({ id: '10', changed_at: '2026-08-31T10:00:00.000Z' }),
    ];
    expect(ordenadas(entradas, fechaDePerfil).map((entrada) => entrada.id)).toEqual(['10', '9']);
  });

  it('con la misma fecha desempata el id mayor, comparado como número', () => {
    const misma = '2026-08-29T10:00:00.000Z';
    const entradas = [
      revision({ id: '9', changed_at: misma }),
      revision({ id: '10', changed_at: misma }),
    ];
    expect(ordenadas(entradas, fechaDePerfil).map((entrada) => entrada.id)).toEqual(['10', '9']);
  });

  it('una entrada sin fecha legible va al final en vez de desaparecer', () => {
    const entradas = [
      revision({ id: '2', changed_at: 'no es una fecha' }),
      revision({ id: '1', changed_at: '2026-08-29T10:00:00.000Z' }),
    ];
    expect(ordenadas(entradas, fechaDePerfil).map((entrada) => entrada.id)).toEqual(['1', '2']);
  });

  it('unir dos páginas no duplica una fila repetida y respeta la última leída', () => {
    const previas = [revision({ id: '2', role_summary: 'viejo' })];
    const nuevas = [
      revision({ id: '2', role_summary: 'lo que dice el servidor ahora' }),
      revision({ id: '1', changed_at: '2026-08-28T10:00:00.000Z' }),
    ];
    const unidas = fusionar(previas, nuevas, fechaDePerfil);
    expect(unidas.map((entrada) => entrada.id)).toEqual(['2', '1']);
    expect(unidas[0].role_summary).toBe('lo que dice el servidor ahora');
  });

  it('también une el diario de ficheros, que se fecha por otra columna', () => {
    const unidas = fusionar(
      [documento({ id: '1', written_at: '2026-08-28T10:00:00.000Z' })],
      [documento({ id: '2', written_at: '2026-08-31T10:00:00.000Z' })],
      fechaDeDocumento,
    );
    expect(unidas.map((entrada) => entrada.id)).toEqual(['2', '1']);
  });
});

describe('la paginación', () => {
  it('no inventa un cursor que el servidor no mandó', () => {
    expect(cursorSiguiente({ entries: [] })).toBeUndefined();
    expect(cursorSiguiente({ entries: [], next_cursor: '   ' })).toBeUndefined();
    expect(cursorSiguiente({ entries: [], next_cursor: 7 })).toBeUndefined();
    expect(cursorSiguiente(null)).toBeUndefined();
  });

  it('usa el cursor en cuanto el servidor lo publique', () => {
    expect(cursorSiguiente({ entries: [], next_cursor: 'siguiente' })).toBe('siguiente');
    expect(siguientePedido({ limit: 20 }, { entries: [], next_cursor: 'siguiente' }))
      .toEqual({ limit: 20, cursor: 'siguiente' });
  });

  it('sin cursor pide una ventana más ancha del mismo diario', () => {
    expect(siguientePedido({ limit: 20 }, { entries: [] }))
      .toEqual({ limit: 20 + PASO_DE_PAGINA });
  });

  it('la ventana no pasa del tope que la ruta acepta: pedir más es un 400 por contrato', () => {
    expect(siguientePedido({ limit: TOPE_DE_PAGINA - PASO_DE_PAGINA }, { entries: [] }))
      .toEqual({ limit: TOPE_DE_PAGINA });
    expect(siguientePedido({ limit: TOPE_DE_PAGINA }, { entries: [] }))
      .toEqual({ limit: TOPE_DE_PAGINA });
  });

  it('una página corta prueba que no hay más; una llena deja la puerta abierta', () => {
    expect(pasoDelDiario({ entries: new Array<number>(20).fill(0) }, { limit: 20 })).toBe('mas');
    expect(pasoDelDiario({ entries: new Array<number>(19).fill(0) }, { limit: 20 })).toBe('fin');
    const cortaConCursor: { entries: number[]; next_cursor: string } = {
      entries: new Array<number>(19).fill(0), next_cursor: 'hay más',
    };
    expect(pasoDelDiario(cortaConCursor, { limit: 20 })).toBe('mas');
  });

  it('con la ventana en el tope y la página llena no dice «fin»: dice que la ventana se acabó', () => {
    expect(pasoDelDiario(
      { entries: new Array<number>(TOPE_DE_PAGINA).fill(0) }, { limit: TOPE_DE_PAGINA },
    )).toBe('ventana-agotada');
  });

  it('un tramo pedido con cursor y devuelto sin cursor es el final, aunque venga lleno', () => {
    expect(pasoDelDiario(
      { entries: new Array<number>(20).fill(0) }, { limit: 20, cursor: 'tercer tramo' },
    )).toBe('fin');
  });
});
