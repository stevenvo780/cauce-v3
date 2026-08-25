import { describe, expect, it } from 'vitest';
import type { AgentFactsProbe } from './agent-documents.routes.js';
import { SondaCompartida, sondaDiferida } from './sonda-compartida.js';

/**
 * EL HUECO ENTRE DOS REGISTROS QUE NO PUEDEN VERSE.
 *
 * Las rutas de documentos se montan en `app.ts` y la sonda que de verdad lee el disco del
 * contenedor la construye el plano de terminal, que se registra DESPUÉS. Sin este hueco había que
 * elegir entre dos cosas malas: rutas caídas —404, el estado del que venimos— o rutas montadas y
 * muertas.
 *
 * Lo que se prueba acá es sobre todo la trampa: que la sonda se resuelva EN CADA llamada. Una
 * implementación que la capture al arrancar pasa cualquier prueba escrita al revés —instalar
 * primero, llamar después— y falla exactamente en el orden real de producción.
 */

function sondaFalsa(marca: string): AgentFactsProbe {
  return {
    factsFor: async () => ({ facts: { harness: 'claude', home: `/${marca}` }, source: 'measured' }),
    readGovernanceDocument: async () => ({ error: 'not_found', reason: marca }),
    listMemoryDirectory: async () => ({ error: 'not_found', reason: marca }),
  };
}

describe('sin sonda instalada, la degradada dice la verdad en vez de lanzar', () => {
  it('no hay hechos medidos', async () => {
    const hueco = new SondaCompartida();
    expect(await sondaDiferida(hueco).factsFor('Steven', 'zeus')).toBeUndefined();
  });

  it('leer contesta «no hay canal», no una excepción', async () => {
    /*
     * Lanzar convertiría un canal ausente en un 500 «internal error», que es lo que el operador no
     * puede accionar. Y peor: el manejador de las rutas envuelve la llamada, así que un throw se
     * vería como un fallo del gateway en vez de como lo que es.
     */
    const hueco = new SondaCompartida();
    const resultado = await sondaDiferida(hueco).readGovernanceDocument(
      '/home/dev/.claude/CLAUDE.md', { harness: 'claude', home: '/home/dev' }, 'Steven', 'zeus',
    );
    expect(resultado).toMatchObject({ error: 'unavailable' });
    expect('reason' in resultado ? resultado.reason : '').toContain('plano de terminal');
  });

  it('declara que NO hay sonda instalada', () => {
    expect(new SondaCompartida().instalada).toBe(false);
  });
});

describe('con sonda instalada, delega en ella', () => {
  it('los tres métodos van a la sonda real', async () => {
    const hueco = new SondaCompartida();
    hueco.instalar(sondaFalsa('real'));
    const diferida = sondaDiferida(hueco);

    expect((await diferida.factsFor('Steven', 'zeus'))?.facts.home).toBe('/real');
    const leido = await diferida.readGovernanceDocument(
      '/x', { harness: 'claude', home: '/home/dev' }, 'Steven', 'zeus',
    );
    expect('reason' in leido ? leido.reason : '').toBe('real');
    const memoria = await diferida.listMemoryDirectory(
      '/x', { harness: 'claude', home: '/home/dev' }, 'Steven', 'zeus',
    );
    expect('reason' in memoria ? memoria.reason : '').toBe('real');
    expect(hueco.instalada).toBe(true);
  });
});

describe('🔴 la trampa: se resuelve en CADA llamada, no al construirse', () => {
  it('una sonda diferida creada ANTES de instalar igual encuentra la real', async () => {
    /*
     * Éste es EL orden de producción: `app.ts` crea la diferida y monta las rutas, y sólo después
     * `main.ts` registra el plano de terminal que instala la real. Una implementación que capturase
     * `hueco.actual()` al construirse guardaría la degradada para siempre y este caso —el único
     * que ocurre de verdad— fallaría, mientras que instalar-antes-de-crear pasaría sin problema.
     *
     * Sin esta prueba, ese defecto no daría ningún error: las rutas seguirían contestando «no hay
     * canal» con el canal ya montado al lado.
     */
    const hueco = new SondaCompartida();
    const diferida = sondaDiferida(hueco);           // se crea PRIMERO, como en app.ts
    expect(await diferida.factsFor('Steven', 'zeus')).toBeUndefined();

    hueco.instalar(sondaFalsa('tarde'));             // se instala DESPUÉS, como en main.ts
    expect((await diferida.factsFor('Steven', 'zeus'))?.facts.home).toBe('/tarde');
  });

  it('reinstalar cambia a la nueva, no se queda con la primera', async () => {
    const hueco = new SondaCompartida();
    const diferida = sondaDiferida(hueco);
    hueco.instalar(sondaFalsa('primera'));
    expect((await diferida.factsFor('Steven', 'zeus'))?.facts.home).toBe('/primera');
    hueco.instalar(sondaFalsa('segunda'));
    expect((await diferida.factsFor('Steven', 'zeus'))?.facts.home).toBe('/segunda');
  });

  it('CONTROL NEGATIVO: dos huecos NO comparten sonda', () => {
    /*
     * Por esto el hueco se decora sobre la instancia de Fastify y no vive como estado de módulo:
     * los tests montan varios gateways en el mismo proceso, y con estado de módulo todos acabarían
     * usando la sonda del último en arrancar — o sea leyendo el disco del contenedor equivocado.
     */
    const uno = new SondaCompartida();
    const otro = new SondaCompartida();
    uno.instalar(sondaFalsa('uno'));
    expect(uno.instalada).toBe(true);
    expect(otro.instalada).toBe(false);
  });
});
