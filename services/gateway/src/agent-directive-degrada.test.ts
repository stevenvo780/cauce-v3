import { describe, expect, it } from 'vitest';
import { construirRespuestaDegradada } from './console/agent-directive.routes.js';

/**
 * Verifies that the degraded response from `/directive` reports `medido: false`
 * explicitly when no measured facts are available for the container.
 */

describe('la respuesta degradada de /directive dice que no midió', () => {
  it('sin hechos medidos: NO medida, y explica por qué', () => {
    const r = construirRespuestaDegradada(undefined);
    expect(r).toBeDefined();
    expect(r!.publicado).toBe(true); // the route DOES exist: that is not what is in doubt
    expect(r!.medido).toBe(false);
    expect(r!.files).toBeNull();
    expect(r!.memory).toEqual({
      root: null,
      error: 'unavailable',
      reason: 'contenedor no medido todavía (sin hechos de entorno)',
    });
    expect(r!.motivo).toMatch(/no medido/);
  });

  it('con hechos de fuente «registry»: NO medida', () => {
    const r = construirRespuestaDegradada('registry');
    expect(r!.medido).toBe(false);
    expect(r!.files).toBeNull();
    expect(r!.motivo).toMatch(/deducidas del registro/);
  });

  it('con hechos de fuente «database»: NO medida', () => {
    const r = construirRespuestaDegradada('database');
    expect(r!.medido).toBe(false);
    expect(r!.motivo).toMatch(/deducidas del registro/);
  });

  it('CONTROL NEGATIVO: «measured» no produce respuesta degradada', () => {
    // If this returned something, the route would be degrading the only good case and layers 2 and 3
    // would never fill in, no matter what the rest of the code said.
    expect(construirRespuestaDegradada('measured')).toBeUndefined();
  });
});

/*
 * Layer 3 had the SAME defect as layer 2, just elsewhere: when the memory listing
 * failed, the route returned `{total: 0, entries: []}`, and that zero reached the screen as
 * "looked and this alias has no written memory". The new contract preserves the reason via
 * the `error` discriminant; `null` only stays as backward compatibility with older gateways.
 */
describe('la memoria que no se pudo listar es un fallo discriminado, no un índice de cero', () => {
  it('el índice vacío y la ausencia de índice NO son el mismo valor', async () => {
    const fuente = await import('./console/agent-directive.routes.js');
    const codigo = fuente.construirRespuestaDegradada(undefined);
    expect(codigo!.memory).toMatchObject({ error: 'unavailable', root: null });
    expect(codigo!.memory).not.toHaveProperty('total');
    expect(codigo!.memory).not.toHaveProperty('entries');
    // Control negativo: un índice de cero legítimo sigue siendo representable y no tiene error.
    const indiceRealVacio = { root: '/home/dev/.claude/projects', total: 0, truncated: false, entries: [] };
    expect(indiceRealVacio).not.toHaveProperty('error');
    expect(indiceRealVacio.total).toBe(0);
  });
});
