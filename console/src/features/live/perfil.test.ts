import { describe, expect, it } from 'vitest';
import { measureStrictestUnits } from '@cauce/protocol';
import type { AgentPerfil, AgentPerfilCampos } from '../../api/types';
import {
  CAMPOS_DE_LISTA, camposQueNoEntran, camposVigentes, contarUnidades, hayCambios,
  esPerfilAplicado, lineasALista, listaALineas, perfilParaGuardar,
  unidadesDelPerfil,
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
    expect(lineasALista('  ssh \n\n docker\n  \n')).toEqual(['ssh', 'docker']);
  });

  it('ida y vuelta conserva las entradas', () => {
    const items = ['reparar Cauce', 'no tocar credenciales'];
    expect(lineasALista(listaALineas(items))).toEqual(items);
  });

  it('CONTROL NEGATIVO: una entrada con espacios internos NO se parte', () => {
    expect(lineasALista('reparar Cauce de punta a punta')).toEqual(['reparar Cauce de punta a punta']);
  });
});
