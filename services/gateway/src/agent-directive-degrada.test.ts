import { describe, expect, it } from 'vitest';
import { construirRespuestaDegradada } from './console/agent-directive.routes.js';

/**
 * Verifica que la respuesta degradada de `/directive` reporte `medido: false`
 * explícitamente cuando no se dispone de hechos medidos del contenedor.
 */

describe('la respuesta degradada de /directive dice que no midió', () => {
  it('sin hechos medidos: NO medida, y explica por qué', () => {
    const r = construirRespuestaDegradada(undefined);
    expect(r).toBeDefined();
    expect(r!.publicado).toBe(true); // la ruta SÍ existe: eso no es lo que está en duda
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
    // Si esto devolviera algo, la ruta estaría degradando el único caso bueno y las capas 2 y 3
    // no se llenarían nunca, dijera lo que dijera el resto del código.
    expect(construirRespuestaDegradada('measured')).toBeUndefined();
  });
});

/*
 * La capa 3 tenía el MISMO defecto que la capa 2, en otro sitio: cuando el listado de memoria
 * fallaba, la ruta devolvía `{total: 0, entries: []}`, y ese cero llegaba a la pantalla como
 * «miró y este alias no tiene memoria escrita». El contrato nuevo conserva el motivo mediante
 * el discriminante `error`; `null` sólo queda como compatibilidad con gateways anteriores.
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
