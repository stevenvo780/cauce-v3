import { describe, expect, it } from 'vitest';
import { measureStrictestUnits } from '@cauce/protocol';
import type { AgentPerfil, AgentPerfilCampos } from '../../api/types';
import {
  CAMPOS_DE_LISTA, CAMPOS_DE_TEXTO, camposQueNoEntran, camposVigentes, contarUnidades, hayCambios,
  lineasALista, listaALineas, mutacionDePerfil, perfilYaExiste, unidadesDelPerfil,
} from './perfil';

/**
 * EL EDITOR DE PERFIL, probado por donde se rompe.
 *
 * Estas pruebas no cubren la pintura: cubren las cuatro decisiones que, si se tuercen, hacen que
 * el operador crea que guardó algo que no guardó.
 *
 * 1. Que la cuenta de unidades del navegador sea LA MISMA que la del servidor. El 16-ago un alias
 *    se quedó sordo porque dos capas contaban el mismo 1200 en unidades distintas.
 * 2. Que `human_brief` viaje en la mutación. Es el campo que tenía columna, tope e interfaz y NO
 *    tenía camino: la consola podía enseñar la caja y el servidor rechazaba el cuerpo entero.
 * 3. Que un texto vacío viaje como `null` y no como `''`. La columna tiene CHECK de longitud >= 1
 *    y `null` es lo que hace que el compilador OMITA la sección en vez de emitir un encabezado
 *    hueco.
 * 4. Que un alta se distinga de una edición, porque el DESHACER de cada una es distinto.
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
   * No es puntillismo. `String.length` cuenta unidades UTF-16 y `[...texto].length` cuenta puntos
   * de código, y no coinciden: una `á` es 1 y 1, pero un emoji fuera del BMP es 1 punto y 2
   * unidades. Si el navegador contara la unidad floja, le diría al operador que su texto entra
   * cuando el CHECK de Postgres lo va a rechazar — o peor, lo guardaría y el adaptador lo tiraría
   * al componer el sobre, que es literalmente cómo un alias se quedó sordo el 16-ago.
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
    // Si las dos unidades coincidieran siempre, comprobar la igualdad de arriba sería vacío. Acá
    // se exige que exista al menos un texto donde SÍ se separan.
    const conEmoji = 'zeus 🩺';
    expect([...conEmoji].length).toBeLessThan(conEmoji.length);
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
     * Comparar por identidad de objeto habría dado «sucio» en cuanto se pinta, porque
     * `camposVigentes` copia las listas en cada render. El botón de guardar habría quedado
     * habilitado siempre y el cartel verde se habría retirado solo sin que nadie tocara nada.
     */
    const guardado = perfilDe({ purpose: 'igual', tools: ['ssh', 'docker'] });
    const campos = camposVigentes(guardado, undefined);
    expect(hayCambios(guardado, campos)).toBe(false);
  });

  it('CONTROL NEGATIVO: reordenar una lista SÍ es un cambio', () => {
    // El orden es el orden en que se van a escribir las viñetas del fichero: no es un conjunto.
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
     * Éste es el que de verdad importa: cuatro listas llenas dan 256.000 unidades con cada campo
     * «dentro de su tope». Sin esta comprobación el operador guardaría un perfil que Postgres
     * rechaza, y el error llegaría como un 422 sin decir qué recortar.
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
    // Un gateway que no publique `limites` no puede hacer que la pantalla bloquee el guardado por
    // un tope que se sacó de la manga: manda el servidor.
    expect(camposQueNoEntran({ ...VACIO, purpose: 'x'.repeat(99_999) }, undefined)).toEqual([]);
  });
});

describe('la mutación que se envía', () => {
  it('lleva human_brief, que es el campo que no tenía camino', () => {
    /*
     * `human_brief` tenía columna en la 026, tope en `AGENT_PROFILE_LIMITS`, sitio en la interfaz
     * `AgentProfile` y una cara propia en `USER.md` de openclaw — y NO estaba ni en el esquema de
     * la mutación ni en el INSERT ni en el SELECT del deshacer. Una caja en pantalla sin camino
     * hasta el fichero es exactamente el defecto que este trabajo viene a cerrar.
     */
    const mutation = mutacionDePerfil('Steven', 'zeus', { ...VACIO, human_brief: 'Steven, directo' }, true);
    expect((mutation.value as Record<string, unknown>).human_brief).toBe('Steven, directo');
  });

  it('un texto vacío viaja como null y NO como cadena vacía', () => {
    const mutation = mutacionDePerfil('Steven', 'zeus', VACIO, true);
    const value = mutation.value as Record<string, unknown>;
    for (const campo of CAMPOS_DE_TEXTO) expect(value[campo]).toBeNull();
  });

  it('un texto de sólo espacios también viaja como null', () => {
    const mutation = mutacionDePerfil('Steven', 'zeus', { ...VACIO, purpose: '   \n  ' }, true);
    expect((mutation.value as Record<string, unknown>).purpose).toBeNull();
  });

  it('sobre un alias sin perfil es un ALTA, y sobre uno con perfil una edición', () => {
    // No es cosmética: un alta se deshace BORRANDO y una edición reponiendo. Si un alta se
    // deshiciera con un `update` al perfil vacío quedaría una fila con todo en NULL, que no es lo
    // mismo que no tener perfil — el compilador distingue «no declarado» de «declarado vacío».
    expect(mutacionDePerfil('Steven', 'zeus', VACIO, false).action).toBe('create');
    expect(mutacionDePerfil('Steven', 'zeus', VACIO, true).action).toBe('update');
  });

  it('CONTROL NEGATIVO: las listas se copian, la mutación no comparte array con el editor', () => {
    const campos = { ...VACIO, tools: ['ssh'] };
    const mutation = mutacionDePerfil('Steven', 'zeus', campos, true);
    campos.tools.push('docker');
    expect((mutation.value as Record<string, string[]>).tools).toEqual(['ssh']);
  });
});

describe('cuándo un perfil ya existe', () => {
  it('un perfil con cualquier cara declarada existe', () => {
    expect(perfilYaExiste(perfilDe({ human_brief: 'Steven' }))).toBe(true);
    expect(perfilYaExiste(perfilDe({ tools: ['ssh'] }))).toBe(true);
  });

  it('CONTROL NEGATIVO: todo en NULL y listas vacías NO es un perfil', () => {
    expect(perfilYaExiste(perfilDe({}))).toBe(false);
    expect(perfilYaExiste(undefined)).toBe(false);
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
