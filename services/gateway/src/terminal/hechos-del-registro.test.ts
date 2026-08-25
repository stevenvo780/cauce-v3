import { describe, expect, it } from 'vitest';
import { AgentRegistry } from './registry.js';
import { hechosDelRegistro } from './hechos-del-registro.js';

/**
 * 🔴 **LA FUENTE DE HECHOS MEDIDOS ESTABA VACÍA EN PRODUCCIÓN, Y ESO CERRABA TODA LA VÍA.**
 *
 * `MeasuredFactsSource` existía, `TerminalRelayFactsProbe` la consumía y de ella colgaba la
 * lectura y edición de los ficheros de gobierno de cada agente. En producción se inyectaba
 * `{ factsFor: async () => undefined }`: un doble que dice «nadie ha medido nada» SIEMPRE.
 *
 * El motivo estaba escrito en el propio plugin —«el pty-agent conoce su `home` y su `harness` por
 * el bundle con el que arranca, pero no los publica»—. El `harness` sí viajaba en la presencia;
 * el `home` no. Una línea de Python.
 *
 * Estas pruebas cubren sobre todo lo que esta pieza se NIEGA a contestar, porque ahí está el
 * daño: un hecho a medias hace que la consola pase de decir honestamente «no se miró» a servir un
 * fichero equivocado con cara de medido.
 */

function presencia(extra: Record<string, unknown> = {}) {
  return {
    tenant_id: 'Steven',
    alias: 'zeus',
    container_id: 'abc123',
    generation: '1',
    image_id: 'img1',
    runtime_user: 'dev',
    runtime_uid: 1000,
    harness: 'claude',
    home: '/home/dev',
    modes: ['shell', 'harness'],
    connected_since: '2026-08-25T00:00:00.000Z',
    ...extra
  } as never;
}

describe('los hechos salen de lo que el agente publica', () => {
  it('un agente que publica harness y home da hechos MEDIDOS', async () => {
    const registry = new AgentRegistry();
    registry.observe([presencia()]);
    const hechos = await hechosDelRegistro(registry).factsFor('Steven', 'zeus');
    expect(hechos?.source).toBe('measured');
    expect(hechos?.facts.harness).toBe('claude');
    expect(hechos?.facts.home).toBe('/home/dev');
  });

  it('CONTROL NEGATIVO: un alias que nadie reportó no tiene hechos', async () => {
    const registry = new AgentRegistry();
    expect(await hechosDelRegistro(registry).factsFor('Steven', 'zeus')).toBeUndefined();
  });
});

describe('lo que se NIEGA a contestar', () => {
  it('un agente VIEJO, que no publica `home`, no da hechos — no se deduce', async () => {
    /*
     * Deducir el `home` del registro de la base sería exactamente el fallo que esta vía evita: el
     * 23-ago-2026 `agents.harness_id` era incorrecto en 5 de los 14 alias, así que resolver
     * `~/.claude/CLAUDE.md` con esos datos no da «no se pudo leer», da el fichero de OTRO arnés
     * servido como si fuera el bueno.
     */
    const registry = new AgentRegistry();
    registry.observe([presencia({ home: undefined })]);
    expect(await hechosDelRegistro(registry).factsFor('Steven', 'zeus')).toBeUndefined();
  });

  it('un `home` que no es ruta absoluta se descarta', async () => {
    const registry = new AgentRegistry();
    registry.observe([presencia({ home: 'home/dev' })]);
    expect(await hechosDelRegistro(registry).factsFor('Steven', 'zeus')).toBeUndefined();
  });

  it('un arnés que esta vía no sabe resolver no da hechos, aunque el `home` esté', async () => {
    // Son dos ausencias distintas y ninguna autoriza a inventar la otra.
    const registry = new AgentRegistry();
    registry.observe([presencia({ harness: 'algo-que-no-conozco' })]);
    expect(await hechosDelRegistro(registry).factsFor('Steven', 'zeus')).toBeUndefined();
  });

  it('una medición VIEJA no vale: el contenedor pudo recrearse con otro $HOME', async () => {
    /*
     * `stale` cuenta como no medido. Recrear un contenedor es una operación normal en esta flota y
     * puede cambiar el `$HOME`; servir la ruta de antes sería afirmar sobre un proceso que ya no
     * existe. La ventana la decide `AGENT_STALE_AFTER_MS` del registro, no este módulo.
     */
    const registry = new AgentRegistry();
    const hace = Date.now() - 24 * 60 * 60 * 1000;
    registry.observe([presencia()], hace);
    const observacion = registry.get('Steven', 'zeus');
    expect(observacion?.stale).toBe(true);
    expect(await hechosDelRegistro(registry).factsFor('Steven', 'zeus')).toBeUndefined();
  });

  it('CONTROL NEGATIVO: recién reportado NO está viejo, o esta pieza no serviría nunca', async () => {
    // Sin esto, una implementación que devolviera `undefined` siempre pasaría las cinco de arriba.
    const registry = new AgentRegistry();
    registry.observe([presencia()]);
    expect(await hechosDelRegistro(registry).factsFor('Steven', 'zeus')).toBeDefined();
  });

  it('los hechos son POR ALIAS: el `home` de zeus no se le sirve a otro', async () => {
    const registry = new AgentRegistry();
    registry.observe([
      presencia(),
      presencia({ alias: 'argos', harness: 'openclaw', home: '/home/argos' })
    ]);
    const fuente = hechosDelRegistro(registry);
    expect((await fuente.factsFor('Steven', 'zeus'))?.facts.home).toBe('/home/dev');
    expect((await fuente.factsFor('Steven', 'argos'))?.facts.home).toBe('/home/argos');
    // Y un alias del mismo nombre en OTRO inquilino es otro agente.
    expect(await fuente.factsFor('Miguel', 'zeus')).toBeUndefined();
  });
});

describe('la presencia acepta el `home` sin exigirlo', () => {
  it('un agente viejo NO tira su propia presencia por no mandarlo', async () => {
    /*
     * Ésta es la que evita el incidente de despliegue. `parseAgentPresence` lanza cuando un campo
     * obligatorio falta, y `registry.observe` recibe el array ya mapeado: una excepción ahí tira
     * la presencia de TODOS los alias del informe, no sólo la del que va viejo. Desplegar el
     * gateway antes que el agente dejaría terminales caídas por toda la flota — la misma lección
     * que el comentario de `features` en el propio pty-agent.
     */
    const registry = new AgentRegistry();
    expect(() => registry.observe([presencia({ home: undefined })])).not.toThrow();
    expect(registry.state('Steven', 'zeus')).toBe('online');
  });
});
