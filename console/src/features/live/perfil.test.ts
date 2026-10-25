import { describe, expect, it } from 'vitest';
import { ficherosDelArnes, measureStrictestUnits, nombresDelArnes } from '@cauce/protocol';
import type { AgentPerfil, AgentPerfilCampos } from '../../api/types';
import {
  CAMPOS_DE_LISTA, CAMPOS_DEL_PERFIL, camposQueNoEntran, camposVigentes, contarUnidades,
  destinosDelArnes, entradasDeLista, hayCambios, esPerfilAplicado, lineasCrudas,
  motivoSinDestino,
  perfilParaGuardar, unidadesDelPerfil, type CampoDelPerfil,
  CONTAMINACION_ILEGIBLE, MENSAJES_DE_APLICACION,
  contaminacionDe, esRecargaHecha, fraseDeContaminacion,
  veredictoLegible, veredictoVigente,
} from './perfil';

/**
 * THE PROFILE EDITOR, tested where it breaks.
 *
 * These tests do not cover painting: they cover the decisions that, if they go wrong, make
 * the operator believe they saved something they did not.
 *
 * 1. That the browser's unit count is THE SAME as the server's. An alias once went deaf
 *    because two layers counted the same 1200 in different units.
 * 2. That the seven fields, including `human_brief`, travel in the canonical body without
 *    browser-controlled identity or action.
 * 3. That an empty text travels as `null` and not as `''`. The column has a length CHECK >= 1
 *    and `null` is what makes the compiler OMIT the section instead of emitting an empty
 *    header.
 * 4. That the UI only announces "applied" on convergence and exact ACK of every file.
 */

const VACIO: AgentPerfilCampos = {
  purpose: '', role_summary: '', human_brief: '',
  responsibilities: [], restrictions: [], tools: [], operating_rules: [],
};

function perfilDe(parcial: Partial<AgentPerfil['perfil']>): AgentPerfil {
  return {
    publicado: true,
    perfil: {
      purpose: null, role_summary: null, human_brief: null,
      responsibilities: [], restrictions: [], tools: [], operating_rules: [],
      ...parcial,
    },
    limites: { purpose: 2_000, role_summary: 4_000, item: 1_000, items: 64, total: 24_000 },
  };
}

describe('la cuenta del navegador es la MISMA que la del servidor', () => {
  /*
   * Not nitpicking. `String.length` counts UTF-16 units and `[...text].length` counts code
   * points, and they do not match: an accented `a` is 1 and 1, but an out-of-BMP emoji is 1
   * point and 2 units. If the browser counted the loose unit, it would tell the operator that
   * their text fits when the Postgres CHECK is going to reject it — or worse, save it and the
   * adapter would throw it away when composing the envelope, which is literally how an alias
   * went mute once.
   */
  const CASOS = [
    ['ascii puro', 'hola mundo'],
    ['acentos y eñe', 'gestión de la señal, día a día'],
    ['emoji fuera del BMP', 'zeus 🩺 revisa 🧵 la flota'],
    ['emoji con selector de variación', '⚠️ cuidado'],
    ['par suplente suelto', 'roto \ud83d'],
    ['vacío', ''],
  ] as const;

  for (const [nombre, texto] of CASOS) {
    it(`coincide con measureStrictestUnits: ${nombre}`, () => {
      expect(contarUnidades(texto)).toBe(measureStrictestUnits(texto));
    });
  }
});

describe('el borrador se pone ENCIMA de lo guardado, sin perder el resto', () => {
  it('un campo tocado no borra los demás', () => {
    const guardado = perfilDe({ purpose: 'el médico', role_summary: 'repara Cauce', tools: ['ssh'] });
    const campos = camposVigentes(guardado, { purpose: 'el médico de la flota' });
    expect(campos.purpose).toBe('el médico de la flota');
    expect(campos.role_summary).toBe('repara Cauce');
    expect(campos.tools).toEqual(['ssh']);
  });

  it('CONTROL NEGATIVO: las listas se COPIAN, editarlas no muta el perfil leído', () => {
    const guardado = perfilDe({ tools: ['ssh'] });
    const campos = camposVigentes(guardado, undefined);
    campos.tools.push('docker');
    expect(guardado.perfil.tools).toEqual(['ssh']);
  });
});

describe('qué cuenta como cambio', () => {

  it('CONTROL NEGATIVO: reordenar una lista SÍ es un cambio', () => {
    // The order is the order in which the file's bullets will be written: it is not a set.
    const guardado = perfilDe({ tools: ['ssh', 'docker'] });
    expect(hayCambios(guardado, { ...VACIO, tools: ['docker', 'ssh'] })).toBe(true);
  });
});

describe('los topes se miden antes de dejar guardar', () => {
  const limites = { purpose: 2_000, role_summary: 4_000, item: 1_000, items: 64, total: 24_000 };

  it('un texto pasado de su tope se nombra con los dos números', () => {
    const fuera = camposQueNoEntran({ ...VACIO, purpose: 'x'.repeat(2_001) }, limites);
    expect(fuera).toHaveLength(1);
    expect(fuera[0]?.medido).toBe(2_001);
    expect(fuera[0]?.tope).toBe(2_000);
  });

  it('el TECHO del perfil entero se comprueba aunque cada campo entre en el suyo', () => {
    /*
     * This is the one that really matters: four full lists give 256,000 units with each field
     * "within its cap". Without this check the operator would save a profile Postgres rejects,
     * and the error would arrive as a 422 without saying what to trim.
     */
    const lista = Array.from({ length: 64 }, () => 'y'.repeat(200));
    const campos = { ...VACIO, responsibilities: lista, restrictions: lista, tools: lista };
    for (const campo of CAMPOS_DE_LISTA) {
      const items = campos[campo];
      expect(items.every((item) => contarUnidades(item) <= limites.item)).toBe(true);
      expect(items.length).toBeLessThanOrEqual(limites.items);
    }
    expect(unidadesDelPerfil(campos)).toBeGreaterThan(limites.total);
    expect(camposQueNoEntran(campos, limites).some((p) => p.campo === 'El perfil entero')).toBe(true);
  });

  it('CONTROL NEGATIVO: sin límites del servidor no se inventa ninguno', () => {
    // A gateway that does not publish `limites` cannot make the screen block saving for a cap
    // it made up: the server rules.
    expect(camposQueNoEntran({ ...VACIO, purpose: 'x'.repeat(99_999) }, undefined)).toEqual([]);
  });
});

describe('la escritura aplicada del perfil', () => {
  const esperado = { tenantId: 'Steven', alias: 'kant', nombres: ['AGENTS.md'] };
  const ack = {
    ok: true,
    state: 'applied',
    tenant_id: 'Steven',
    alias: 'kant',
    revision: 7,
    applied_revision: 7,
    acknowledgements: [{
      name: 'AGENTS.md',
      path: '/home/kant/.codex/AGENTS.md',
      state: 'written',
      sha: 'a'.repeat(64),
      bytes: 12,
      generation: 'gen-7',
      container_id: 'ws-kant',
    }],
    runtime_adoption: {
      evidence: 'adapter_delivery',
      revision: 7,
      generation: 'gen-7',
      adopted_at: '2026-08-26T00:01:00Z',
      documents: [{
        name: 'AGENTS.md', path: '/home/kant/.codex/AGENTS.md', sha: 'a'.repeat(64),
      }],
    },
  };

  it('serializa textos vacíos como null sin identidad controlada por el navegador', () => {
    expect(perfilParaGuardar({ ...VACIO, purpose: 'coordinar', human_brief: '  ' })).toEqual({
      purpose: 'coordinar', role_summary: null, human_brief: null,
      responsibilities: [], restrictions: [], tools: [], operating_rules: [],
    });
  });

  it('acepta solo convergencia y un ACK exacto por fichero', () => {
    expect(esPerfilAplicado(ack, esperado)).toBe(true);
    expect(esPerfilAplicado({ ...ack, applied_revision: 6 }, esperado)).toBe(false);
    expect(esPerfilAplicado({ ...ack, acknowledgements: [] }, esperado)).toBe(false);
    expect(esPerfilAplicado({
      ...ack,
      acknowledgements: [{ ...ack.acknowledgements[0], sha: null }],
    }, esperado)).toBe(false);
    expect(esPerfilAplicado({ ...ack, runtime_adoption: null }, esperado)).toBe(false);
    expect(esPerfilAplicado({
      ...ack,
      runtime_adoption: { ...ack.runtime_adoption, generation: 'otra-generacion' },
    }, esperado)).toBe(false);
  });

  it('rechaza ACK extra, duplicado o con ruta que no corresponde al nombre', () => {
    expect(esPerfilAplicado({
      ...ack,
      acknowledgements: [ack.acknowledgements[0], ack.acknowledgements[0]],
    }, esperado)).toBe(false);
    expect(esPerfilAplicado({
      ...ack,
      acknowledgements: [{ ...ack.acknowledgements[0], path: '/tmp/otro.md' }],
    }, esperado)).toBe(false);
    expect(esPerfilAplicado({
      ...ack,
      acknowledgements: [{ ...ack.acknowledgements[0], generation: '' }],
    }, esperado)).toBe(false);
    expect(esPerfilAplicado({
      ...ack,
      runtime_adoption: {
        ...ack.runtime_adoption,
        documents: [{ ...ack.runtime_adoption.documents[0], path: '/tmp/otro.md' }],
      },
    }, esperado)).toBe(false);
  });
});

describe('las listas se editan por líneas', () => {
  it('una línea por entrada, sin las vacías ni los espacios de los bordes', () => {
    expect(entradasDeLista(lineasCrudas('  ssh \n\n docker\n  \n'))).toEqual(['ssh', 'docker']);
  });
});

describe('el destino de cada campo sale del arnés REAL, no de openclaw cableado', () => {
  const CENTINELA = (campo: CampoDelPerfil) => `CENTINELA-${campo}`;

  function contextoDeSonda() {
    const perfil = {
      tenant_id: 'Steven', alias: 'jarvis',
      purpose: CENTINELA('purpose'),
      role_summary: CENTINELA('role_summary'),
      human_brief: CENTINELA('human_brief'),
      responsibilities: [CENTINELA('responsibilities')],
      restrictions: [CENTINELA('restrictions')],
      tools: [CENTINELA('tools')],
      operating_rules: [CENTINELA('operating_rules')],
    };
    return {
      perfil,
      hechos: {
        permisos: { ruta: true, lectura: true, control: false, notificacion: true },
        cuotas: [], destinos: [],
        arnes: { harness: 'sonda', home: '/home/dev', capacidades: [] },
      },
    };
  }

  function repartoReal(harness: string): Record<string, string[]> {
    const generados = ficherosDelArnes(harness, contextoDeSonda(), new Map(), { revision: 1 });
    const reparto: Record<string, string[]> = {};
    for (const campo of CAMPOS_DEL_PERFIL) {
      reparto[campo] = generados
        .filter((fichero) => fichero.texto.includes(CENTINELA(campo)))
        .map((fichero) => fichero.nombre);
    }
    return reparto;
  }

  it('CONTROL NEGATIVO: los SIETE campos se consumen en los tres arneses, solo cambia el reparto', () => {
    for (const harness of ['claude', 'codex', 'openclaw', 'muse', 'grok'] as const) {
      const reparto = repartoReal(harness);
      for (const campo of CAMPOS_DEL_PERFIL) expect(reparto[campo]).not.toEqual([]);
    }
    const claude = destinosDelArnes('claude', [{ nombre: 'CLAUDE.md' }]);
    expect(new Set(Object.values(claude).map((d) => (d.tipo === 'fichero' ? d.nombre : '')))).toEqual(new Set(['CLAUDE.md']));
    const openclaw = destinosDelArnes('openclaw', nombresDelArnes('openclaw').map((nombre) => ({ nombre })));
    expect(openclaw.purpose).toEqual({ tipo: 'fichero', nombre: 'SOUL.md' });
    expect(openclaw.tools).toEqual({ tipo: 'fichero', nombre: 'TOOLS.md' });
  });

  it('un arnés que Cauce no sabe componer dice «no aplica», nunca openclaw', () => {
    for (const harness of ['hermes', 'unknown', 'algo-nuevo']) {
      expect(nombresDelArnes(harness)).toEqual([]);
      const destinos = destinosDelArnes(harness, []);
      for (const campo of CAMPOS_DEL_PERFIL) {
        expect(destinos[campo].tipo).toBe('ausente');
        expect(destinos[campo]).toMatchObject({ ausente: 'no-aplica' });
      }
      expect(motivoSinDestino(destinos)).toContain(harness);
    }
  });

  it('un fichero que el gateway NO publica no se promete, aunque el arnés lo escribiría', () => {
    const destinos = destinosDelArnes('openclaw', [{ nombre: 'SOUL.md' }]);
    expect(destinos.purpose).toEqual({ tipo: 'fichero', nombre: 'SOUL.md' });
    expect(destinos.tools).toMatchObject({ tipo: 'ausente', ausente: 'sin-dato' });
    expect(motivoSinDestino(destinos)).toBeUndefined();
  });
});

describe('el vocabulario de aplicación es el del gateway, leído del fichero', () => {

  it('un motivo que esta consola no conoce se nombra como desconocido, no se calla', () => {
    expect(fraseDeContaminacion('lo_que_venga_mañana')).toMatch(/no sabe nombrar/);
  });
});

describe('el veredicto de contaminación se lee fallando cerrado', () => {
  const HALLAZGO = {
    reason: 'foreign_managed_block', document: 'CLAUDE.md',
    path: '/home/dev/.claude/CLAUDE.md', owner: 'Operador/host',
  };

  it('un veredicto limpio se lee como limpio y uno sucio nombra al dueño', () => {
    expect(contaminacionDe({ contaminacion: { contaminated: false, findings: [] } }))
      .toEqual({ contaminated: false, findings: [] });
    expect(contaminacionDe({ contaminacion: { contaminated: true, findings: [HALLAZGO] } }))
      .toEqual({ contaminated: true, findings: [HALLAZGO] });
  });

  it('sin campo `contaminacion` no se inventa un veredicto', () => {
    expect(contaminacionDe({ ok: true })).toBeUndefined();
    expect(contaminacionDe(undefined)).toBeUndefined();
  });

  it('CONTROL NEGATIVO: un veredicto ilegible o incoherente queda en cuarentena', () => {
    for (const bruto of [
      'sucio',
      { contaminated: true },
      { contaminated: true, findings: [{ document: 'CLAUDE.md' }] },
      { contaminated: false, findings: [HALLAZGO] },
      { contaminated: true, findings: [{ ...HALLAZGO, owner: 7 }] },
    ]) {
      expect(contaminacionDe({ contaminacion: bruto })).toEqual(CONTAMINACION_ILEGIBLE);
    }
    expect(CONTAMINACION_ILEGIBLE.contaminated).toBe(true);
  });

  it('un veredicto ilegible no es un veredicto: no acredita, aunque ensucie', () => {
    expect(veredictoLegible({ contaminacion: { contaminated: true, findings: [HALLAZGO] } }))
      .toEqual({ contaminated: true, findings: [HALLAZGO] });
    expect(veredictoLegible({ contaminacion: { contaminated: false, findings: [HALLAZGO] } }))
      .toBeUndefined();
    expect(veredictoLegible({ contaminacion: { contaminated: true, findings: 'CLAUDE.md' } }))
      .toBeUndefined();
    expect(veredictoLegible({ ok: true })).toBeUndefined();
  });
});

describe('cuando conviven dos mediciones del contexto manda la que denuncia', () => {
  const SUCIO = {
    contaminated: true,
    findings: [{
      reason: 'foreign_managed_block', document: 'CLAUDE.md',
      path: '/home/dev/.claude/CLAUDE.md', owner: 'Operador/host',
    }],
  } as const;
  const LIMPIO = { contaminated: false, findings: [] } as const;

  it('una lectura fresca que denuncia gana al veredicto limpio que dejó una respuesta', () => {
    expect(veredictoVigente(LIMPIO, SUCIO)).toEqual(SUCIO);
  });

  it('la cuarentena no se levanta sola: un veredicto sucio sobrevive a una lectura limpia', () => {
    expect(veredictoVigente(SUCIO, LIMPIO)).toEqual(SUCIO);
    expect(veredictoVigente(CONTAMINACION_ILEGIBLE, LIMPIO)).toEqual(CONTAMINACION_ILEGIBLE);
  });

  it('CONTROL NEGATIVO: sin ninguna medición no se inventa un veredicto, ni limpio ni sucio', () => {
    expect(veredictoVigente(undefined, undefined)).toBeUndefined();
    expect(veredictoVigente(undefined, LIMPIO)).toEqual(LIMPIO);
    expect(veredictoVigente(LIMPIO, undefined)).toEqual(LIMPIO);
    expect(veredictoVigente(undefined, SUCIO)).toEqual(SUCIO);
  });
});

describe('una recarga solo se presenta hecha con el lote entero acreditado', () => {
  const VERIFICACION = {
    state: 'current', generation: 'gen-4', container_id: 'ws-kant',
    observed_at: '2026-08-26T00:00:00Z', documents: [],
  };
  const RECARGA = {
    ok: true, state: 'pending_session_refresh', evidence: 'runtime_verification',
    message: MENSAJES_DE_APLICACION.pending_session_refresh,
    tenant_id: 'Steven', alias: 'kant', revision: 4,
    runtime_verification: VERIFICACION,
    documents: [{
      name: 'CLAUDE.md', path: '/home/dev/.claude/CLAUDE.md',
      sha_before: 'a'.repeat(64), sha_after: 'b'.repeat(64), bytes: 512,
    }],
    contaminacion: { contaminated: false, findings: [] },
  };
  const ESPERADO = { tenantId: 'Steven', alias: 'kant' };

  it('el resultado completo se acepta con su estado, su evidencia y sus huellas', () => {
    expect(esRecargaHecha(RECARGA, ESPERADO)).toBe(true);
    expect(esRecargaHecha({ ...RECARGA, documents: [] }, ESPERADO)).toBe(true);
  });

  it('CONTROL NEGATIVO: otro alias, otro estado o una huella rota no es una recarga', () => {
    expect(esRecargaHecha(RECARGA, { tenantId: 'Miguel', alias: 'kant' })).toBe(false);
    expect(esRecargaHecha({ ...RECARGA, state: 'reloaded' }, ESPERADO)).toBe(false);
    expect(esRecargaHecha({ ...RECARGA, revision: 0 }, ESPERADO)).toBe(false);
    expect(esRecargaHecha({ ...RECARGA, contaminacion: undefined }, ESPERADO)).toBe(false);
    expect(esRecargaHecha({
      ...RECARGA, contaminacion: { contaminated: false, findings: [{ document: 'CLAUDE.md' }] },
    }, ESPERADO)).toBe(false);
    expect(esRecargaHecha({
      ...RECARGA, contaminacion: { contaminated: true, findings: 'CLAUDE.md' },
    }, ESPERADO)).toBe(false);
    expect(esRecargaHecha({ ...RECARGA, runtime_verification: null }, ESPERADO)).toBe(false);
    expect(esRecargaHecha({
      ...RECARGA,
      documents: [{ ...RECARGA.documents[0], sha_after: 'no-es-una-huella' }],
    }, ESPERADO)).toBe(false);
  });
});
