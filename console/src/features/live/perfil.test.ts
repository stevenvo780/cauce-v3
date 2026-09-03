import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ficherosDelArnes, measureStrictestUnits, nombresDelArnes } from '@cauce/protocol';
import type { AgentPerfil, AgentPerfilCampos } from '../../api/types';
import {
  CAMPOS_DE_LISTA, CAMPOS_DEL_PERFIL, camposQueNoEntran, camposVigentes, contarUnidades,
  destinosDelArnes, entradasDeLista, hayCambios, esPerfilAplicado, lineasCrudas, listaALineas,
  motivoSinDestino,
  perfilParaGuardar, unidadesDelPerfil, type CampoDelPerfil,
  CONTAMINACION_ILEGIBLE, ESTADOS_DE_APLICACION, MENSAJES_DE_APLICACION,
  MOTIVOS_DE_CONTAMINACION, contaminacionDe, entregasEnVuelo, esRecargaHecha, fraseDeContaminacion,
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

  it('CONTROL NEGATIVO: la cuenta floja NO habría servido, o esta prueba no probaría nada', () => {
    // If the two units always matched, checking the equality above would be empty. Here it is
    // required that there be at least one text where they DO differ.
    const conEmoji = 'zeus 🩺';
    expect(Array.from(conEmoji).length).toBeLessThan(conEmoji.length);
    expect(contarUnidades(conEmoji)).toBe(conEmoji.length);
  });
});

describe('el borrador se pone ENCIMA de lo guardado, sin perder el resto', () => {
  it('un campo tocado no borra los demás', () => {
    const guardado = perfilDe({ purpose: 'el médico', role_summary: 'repara Cauce', tools: ['ssh'] });
    const campos = camposVigentes(guardado, { purpose: 'el médico de la flota' });
    expect(campos.purpose).toBe('el médico de la flota');
    expect(campos.role_summary).toBe('repara Cauce');
    expect(campos.tools).toEqual(['ssh']);
  });

  it('sin borrador se ve exactamente lo guardado, y los NULL salen como cadena vacía', () => {
    const campos = camposVigentes(perfilDe({ purpose: 'algo' }), undefined);
    expect(campos.purpose).toBe('algo');
    expect(campos.role_summary).toBe('');
    expect(campos.human_brief).toBe('');
  });

  it('CONTROL NEGATIVO: las listas se COPIAN, editarlas no muta el perfil leído', () => {
    const guardado = perfilDe({ tools: ['ssh'] });
    const campos = camposVigentes(guardado, undefined);
    campos.tools.push('docker');
    expect(guardado.perfil.tools).toEqual(['ssh']);
  });
});

describe('qué cuenta como cambio', () => {
  it('un texto distinto es un cambio', () => {
    const guardado = perfilDe({ purpose: 'antes' });
    expect(hayCambios(guardado, { ...VACIO, purpose: 'después' })).toBe(true);
  });

  it('una entrada más en una lista es un cambio', () => {
    const guardado = perfilDe({ tools: ['ssh'] });
    expect(hayCambios(guardado, { ...VACIO, tools: ['ssh', 'docker'] })).toBe(true);
  });

  it('CONTROL NEGATIVO: el MISMO contenido en un array nuevo NO es un cambio', () => {
    /*
     * Comparing by object identity would have returned "dirty" as soon as it painted, because
     * `camposVigentes` copies the lists on every render. The save button would have stayed
     * enabled and the green banner would have withdrawn on its own with nobody touching anything.
     */
    const guardado = perfilDe({ purpose: 'igual', tools: ['ssh', 'docker'] });
    const campos = camposVigentes(guardado, undefined);
    expect(hayCambios(guardado, campos)).toBe(false);
  });

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

  it('demasiadas entradas en una lista se nombran aparte de una entrada larga', () => {
    const fuera = camposQueNoEntran({ ...VACIO, tools: Array.from({ length: 65 }, () => 'x') }, limites);
    expect(fuera.some((p) => p.campo.includes('nº de entradas'))).toBe(true);
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

  it('CONTROL NEGATIVO: dentro de los topes no se reporta NADA', () => {
    const campos = { ...VACIO, purpose: 'corto', tools: ['ssh'] };
    expect(camposQueNoEntran(campos, limites)).toEqual([]);
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

  it('acepta sólo convergencia y un ACK exacto por fichero', () => {
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

  it('ida y vuelta conserva las entradas', () => {
    const items = ['reparar Cauce', 'no tocar credenciales'];
    expect(entradasDeLista(lineasCrudas(listaALineas(items)))).toEqual(items);
  });

  it('CONTROL NEGATIVO: una entrada con espacios internos NO se parte', () => {
    expect(entradasDeLista(lineasCrudas('reparar Cauce de punta a punta')))
      .toEqual(['reparar Cauce de punta a punta']);
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

  for (const harness of ['claude', 'codex', 'openclaw'] as const) {
    it(`en ${harness}, la etiqueta nombra el MISMO fichero que compone ficherosDelArnes`, () => {
      const reparto = repartoReal(harness);
      const nombres = nombresDelArnes(harness).map((nombre) => ({ nombre }));
      const destinos = destinosDelArnes(harness, nombres);
      for (const campo of CAMPOS_DEL_PERFIL) {
        expect(reparto[campo], `${harness}/${campo} no cayó en un único fichero`).toHaveLength(1);
        expect(destinos[campo]).toEqual({ tipo: 'fichero', nombre: reparto[campo][0] });
      }
    });
  }

  it('CONTROL NEGATIVO: los SIETE campos se consumen en los tres arneses, sólo cambia el reparto', () => {
    for (const harness of ['claude', 'codex', 'openclaw'] as const) {
      const reparto = repartoReal(harness);
      for (const campo of CAMPOS_DEL_PERFIL) expect(reparto[campo]).not.toEqual([]);
    }
    const claude = destinosDelArnes('claude', [{ nombre: 'CLAUDE.md' }]);
    expect(new Set(Object.values(claude).map((d) => (d.tipo === 'fichero' ? d.nombre : '')))).toEqual(new Set(['CLAUDE.md']));
    const openclaw = destinosDelArnes('openclaw', nombresDelArnes('openclaw').map((nombre) => ({ nombre })));
    expect(openclaw.purpose).toEqual({ tipo: 'fichero', nombre: 'SOUL.md' });
    expect(openclaw.tools).toEqual({ tipo: 'fichero', nombre: 'TOOLS.md' });
  });

  it('un alias claude NO ve ni un solo fichero de openclaw', () => {
    const destinos = destinosDelArnes('claude', [{ nombre: 'CLAUDE.md' }]);
    const rotulos = JSON.stringify(destinos);
    for (const ajeno of ['SOUL.md', 'IDENTITY.md', 'USER.md', 'TOOLS.md', 'openclaw']) {
      expect(rotulos).not.toContain(ajeno);
    }
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

  it('sin arnés declarado se dice «sin dato», no se adivina', () => {
    for (const harness of [null, undefined, '', '   ']) {
      const destinos = destinosDelArnes(harness, []);
      for (const campo of CAMPOS_DEL_PERFIL) {
        expect(destinos[campo]).toMatchObject({ tipo: 'ausente', ausente: 'sin-dato' });
      }
      expect(motivoSinDestino(destinos)).toContain('no dice qué arnés');
    }
  });

  it('un fichero que el gateway NO publica no se promete, aunque el arnés lo escribiría', () => {
    const destinos = destinosDelArnes('openclaw', [{ nombre: 'SOUL.md' }]);
    expect(destinos.purpose).toEqual({ tipo: 'fichero', nombre: 'SOUL.md' });
    expect(destinos.tools).toMatchObject({ tipo: 'ausente', ausente: 'sin-dato' });
    expect(motivoSinDestino(destinos)).toBeUndefined();
  });
});

function rutaDelGateway(fichero: string): string {
  let directorio = process.cwd();
  for (let salto = 0; salto < 10; salto += 1) {
    const candidato = join(directorio, 'services', 'gateway', 'src', 'console', fichero);
    try {
      readFileSync(candidato, 'utf8');
      return candidato;
    } catch {
      directorio = dirname(directorio);
    }
  }
  throw new Error(`No se encontró services/gateway/src/console/${fichero}`);
}

function mensajesDelGateway(fuente: string): Record<string, string> {
  const politica = fuente.slice(fuente.indexOf('CONTEXT_APPLY_POLICY = {'));
  const mensajes: Record<string, string> = {};
  for (const [, estado, cuerpo] of politica.matchAll(/\n {2}(\w+): \{([\s\S]*?)\n {2}\},/g)) {
    const texto = /message:([\s\S]*)$/.exec(cuerpo)?.[1] ?? '';
    mensajes[estado] = [...texto.matchAll(/'([^']*)'/g)].map(([, x]) => x).join('');
  }
  return mensajes;
}

describe('el vocabulario de aplicación es el del gateway, leído del fichero', () => {
  const fuente = readFileSync(rutaDelGateway('context-apply-policy.ts'), 'utf8');

  it('PARIDAD: cada estado y cada frase coinciden con CONTEXT_APPLY_POLICY', () => {
    expect(mensajesDelGateway(fuente)).toEqual(MENSAJES_DE_APLICACION);
  });

  it('CONTROL NEGATIVO: el lector del gateway no devuelve un mapa vacío ni frases vacías', () => {
    const mensajes = mensajesDelGateway(fuente);
    expect(Object.keys(mensajes)).toHaveLength(ESTADOS_DE_APLICACION.length);
    for (const frase of Object.values(mensajes)) expect(frase.length).toBeGreaterThan(20);
  });

  it('PARIDAD: los motivos de contaminación son los que enumera la guardia', () => {
    const guardia = readFileSync(rutaDelGateway('contaminacion-de-contexto.ts'), 'utf8');
    const declarados = /CONTEXT_CONTAMINATION_REASONS = \[([\s\S]*?)\] as const;/.exec(guardia)?.[1];
    expect(declarados).toBeDefined();
    const motivos = [...(declarados ?? '').matchAll(/'([^']+)'/g)].map(([, x]) => x);
    expect(motivos.length).toBeGreaterThan(0);
    expect(Object.keys(MOTIVOS_DE_CONTAMINACION).sort()).toEqual([...motivos].sort());
    for (const motivo of motivos) expect(fraseDeContaminacion(motivo)).not.toMatch(/no sabe nombrar/);
  });

  it('un motivo que esta consola no conoce se nombra como desconocido, no se calla', () => {
    expect(fraseDeContaminacion('lo_que_venga_mañana')).toMatch(/no sabe nombrar/);
  });
});

describe('el veredicto de contaminación se lee fallando cerrado', () => {
  const HALLAZGO = {
    reason: 'foreign_managed_block', document: 'CLAUDE.md',
    path: '/home/stev/.claude/CLAUDE.md', owner: 'Miguel/kratos',
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
      path: '/home/stev/.claude/CLAUDE.md', owner: 'Miguel/kratos',
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

describe('las entregas en vuelo que nombra un 409', () => {
  it('se nombran vengan como cadenas o como filas con identificador', () => {
    expect(entregasEnVuelo({ deliveries: ['  dlv-1  ', { delivery_id: 'dlv-2' }] }))
      .toEqual(['dlv-1', 'dlv-2']);
    expect(entregasEnVuelo({ deliveries: [{ message_id: 'msg-3' }, { id: 'dlv-4' }] }))
      .toEqual(['msg-3', 'dlv-4']);
  });

  it('CONTROL NEGATIVO: un cuerpo sin lista no inventa entregas ni pinta objetos', () => {
    expect(entregasEnVuelo({ error: 'delivery_in_flight' })).toEqual([]);
    expect(entregasEnVuelo({ deliveries: 'dos' })).toEqual([]);
    expect(entregasEnVuelo({ deliveries: [{ estado: 'en vuelo' }, '  ', null] })).toEqual([]);
  });
});

describe('una recarga sólo se presenta hecha con el lote entero acreditado', () => {
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
      name: 'CLAUDE.md', path: '/home/stev/.claude/CLAUDE.md',
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

function camposDeInterfaz(fuente: string, nombre: string): string[] {
  const cuerpo = new RegExp(`interface ${nombre}[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(fuente)?.[1] ?? '';
  return [...cuerpo.matchAll(/^ {2}(?:readonly )?([a-z_0-9]+)\??:/gmu)].map(([, campo]) => campo);
}

describe('las revisiones que sirve el diario se copian campo a campo', () => {
  const rutas = readFileSync(rutaDelGateway('agent-context-history.routes.ts'), 'utf8');
  const propio = readFileSync(join(process.cwd(), 'src/features/live/perfil.ts'), 'utf8');

  it('PARIDAD: PerfilRevision y DocumentoRevision no inventan ni pierden un campo', () => {
    expect(camposDeInterfaz(propio, 'PerfilRevision'))
      .toEqual(camposDeInterfaz(rutas, 'ProfileRevisionView'));
    expect(camposDeInterfaz(propio, 'DocumentoRevision'))
      .toEqual(camposDeInterfaz(rutas, 'DocumentRevisionView'));
  });

  it('CONTROL NEGATIVO: el lector de campos no devuelve listas vacías ni iguales entre sí', () => {
    const perfil = camposDeInterfaz(rutas, 'ProfileRevisionView');
    const documento = camposDeInterfaz(rutas, 'DocumentRevisionView');
    expect(perfil.length).toBeGreaterThan(10);
    expect(documento.length).toBeGreaterThan(5);
    expect(perfil).not.toEqual(documento);
    expect(camposDeInterfaz(rutas, 'NoExiste')).toEqual([]);
  });
});
