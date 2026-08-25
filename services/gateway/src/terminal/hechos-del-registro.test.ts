import { describe, expect, it } from 'vitest';
import { hechosDelRegistro } from './hechos-del-registro.js';
import { AgentRegistry, parseAgentPresence } from './registry.js';
import type { AgentPresence } from './types.js';

function presencia(extra: Record<string, unknown> = {}): AgentPresence {
  return parseAgentPresence({
    tenant_id: 'Steven',
    alias: 'zeus',
    container_id: '62581a008e83',
    generation: 'g1',
    image_id: 'sha256:abc',
    runtime_user: 'dev',
    runtime_uid: 1000,
    harness: 'claude',
    modes: ['shell'],
    connected_since: '2026-08-25T13:00:00Z',
    ...extra
  });
}

describe('hechos del registro de presencia', () => {
  it('compone los hechos del alias a partir de lo que su pty-agent publicó', async () => {
    const registry = new AgentRegistry();
    registry.observe([presencia({ home: '/home/dev' })]);

    const medido = await hechosDelRegistro(registry).factsFor('Steven', 'zeus');

    expect(medido).toEqual({
      facts: { harness: 'claude', home: '/home/dev' },
      source: 'registry'
    });
  });

  // El defecto que este fichero viene a cerrar: el gateway usaba `async () => undefined` y el modal
  // decía «contenedor sin identificar» con toda la cadena de lectura funcionando por debajo.
  it('NO devuelve undefined para un alias presente y con home', async () => {
    const registry = new AgentRegistry();
    registry.observe([presencia({ home: '/home/claw' })]);
    await expect(hechosDelRegistro(registry).factsFor('Steven', 'zeus')).resolves.toBeDefined();
  });

  it('devuelve undefined si el pty-agent es viejo y no publica home, en vez de adivinar la ruta', async () => {
    const registry = new AgentRegistry();
    registry.observe([presencia()]);
    await expect(hechosDelRegistro(registry).factsFor('Steven', 'zeus')).resolves.toBeUndefined();
  });

  it('devuelve undefined para un alias que nadie observó', async () => {
    const registry = new AgentRegistry();
    registry.observe([presencia({ home: '/home/dev' })]);
    await expect(hechosDelRegistro(registry).factsFor('Steven', 'socrates')).resolves.toBeUndefined();
  });

  // Control negativo del aislamiento: los hechos de un tenant no se sirven a otro.
  it('no cruza inquilinos', async () => {
    const registry = new AgentRegistry();
    registry.observe([presencia({ home: '/home/dev' })]);
    await expect(hechosDelRegistro(registry).factsFor('Miguel', 'zeus')).resolves.toBeUndefined();
  });

  it('un arnés que no reconocemos se llama unknown y no se fuerza a ninguno', async () => {
    const registry = new AgentRegistry();
    registry.observe([presencia({ home: '/home/stev', harness: 'hermes' })]);
    const medido = await hechosDelRegistro(registry).factsFor('Steven', 'zeus');
    expect(medido?.facts.harness).toBe('unknown');
  });
});

describe('home en la presencia', () => {
  it('se acepta cuando es una ruta absoluta', () => {
    expect(presencia({ home: '/home/dev' }).home).toBe('/home/dev');
  });

  it('se omite sin romper la presencia de un agente anterior', () => {
    expect(presencia().home).toBeUndefined();
  });

  it('se rechaza si no es absoluta o trae bytes nulos', () => {
    expect(() => presencia({ home: 'home/dev' })).toThrow(/home/);
    expect(() => presencia({ home: '/home/\0dev' })).toThrow(/home/);
    expect(() => presencia({ home: 42 })).toThrow(/home/);
  });
});
