import { describe, expect, it } from 'vitest';
import type { AgentFactsProbe } from './agent-documents.routes.js';
import { SondaCompartida, sondaDiferida } from './sonda-compartida.js';

/**
 * THE GAP BETWEEN TWO REGISTRIES THAT CANNOT SEE EACH OTHER.
 *
 * The document routes are mounted in `app.ts`, and the probe that actually reads the container's
 * disk is built by the terminal plane, which registers AFTER. Without this gap there was a choice
 * between two bad options: dead routes — 404, the state we came from — or routes mounted but dead.
 *
 * What is tested here is mainly the trap: that the probe is resolved on EVERY call. An
 * implementation that captures it at startup passes any test written the other way around —
 * install first, call later — and fails exactly in the real production order.
 */

function sondaFalsa(marca: string): AgentFactsProbe {
  return {
    factsFor: async () => ({ facts: { harness: 'claude', home: `/${marca}` }, source: 'measured' }),
    readGovernanceDocument: async () => ({ error: 'not_found', reason: marca }),
    listMemoryDirectory: async () => ({ error: 'not_found', reason: marca }),
    writeGovernanceDocument: async (_path, content) => ({ sha: marca.padEnd(64, 'a'), bytes: content.length }),
  };
}

describe('sin sonda instalada, la degradada dice la verdad en vez de lanzar', () => {
  it('no hay hechos medidos', async () => {
    const hueco = new SondaCompartida();
    expect(await sondaDiferida(hueco).factsFor('Steven', 'zeus')).toBeUndefined();
  });

  it('leer contesta «no hay canal», no una excepción', async () => {
    /*
     * Throwing would turn a missing channel into a 500 "internal error", which is what the
     * operator cannot act on. Worse: the routes' handler wraps the call, so a throw would show
     * up as a gateway failure instead of as what it really is.
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
    const escrito = await diferida.writeGovernanceDocument?.(
      '/x', 'abc', { state: 'absent' }, { harness: 'claude', home: '/home/dev' }, 'Steven', 'zeus',
    );
    expect(escrito).toMatchObject({ bytes: 3 });
    expect(hueco.instalada).toBe(true);
  });
});

describe('🔴 la trampa: se resuelve en CADA llamada, no al construirse', () => {
  it('una sonda diferida creada ANTES de instalar igual encuentra la real', async () => {
    /*
     * This IS the production order: `app.ts` creates the deferred and mounts the routes, and
     * only `main.ts` registers the terminal plane that installs the real one afterwards. An
     * implementation that captured `hueco.actual()` at build time would keep the degraded
     * probe forever and this case — the only one that actually occurs — would fail, while
     * install-before-create would pass without trouble.
     *
     * Without this test, the defect would not produce any error: the routes would keep
     * answering "no channel" while the channel is already mounted next door.
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

  it('una diferida creada antes reexpone escritura cuando la sonda tardía la publica', async () => {
    const hueco = new SondaCompartida();
    const diferida = sondaDiferida(hueco);
    const sinCanal = await diferida.writeGovernanceDocument?.(
      '/x', 'a', { state: 'absent' }, { harness: 'claude', home: '/home/dev' }, 'Steven', 'zeus',
    );
    expect(sinCanal).toMatchObject({ error: 'unavailable' });

    hueco.instalar(sondaFalsa('ack'));
    const aplicado = await diferida.writeGovernanceDocument?.(
      '/x', 'abcd', { state: 'absent' }, { harness: 'claude', home: '/home/dev' }, 'Steven', 'zeus',
    );
    expect(aplicado).toMatchObject({ bytes: 4 });
  });

  it('CONTROL NEGATIVO: dos huecos NO comparten sonda', () => {
    /*
     * This is why the gap is decorated onto the Fastify instance and does not live as module
     * state: the tests mount several gateways in the same process, and with module state they
     * would all end up using the last probe started — reading the wrong container's disk.
     */
    const uno = new SondaCompartida();
    const otro = new SondaCompartida();
    uno.instalar(sondaFalsa('uno'));
    expect(uno.instalada).toBe(true);
    expect(otro.instalada).toBe(false);
  });
});
