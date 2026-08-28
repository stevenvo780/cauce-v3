import type { RoleBriefHistoryEntry } from '../../api/types';
import {
  actorDeEntrada, cambioDePlantilla, entradasMasNuevasPrimero, estadoDelDiario, restauracionDe,
  resumirCambio,
} from './historial-rol';

/**
 * The journal's rules, tested without mounting a drawer.
 *
 * Each case here describes a concrete way of lying to the operator about a role's past:
 * ordering the log wrong, calling "rewrite" a change that did not touch the text, inventing
 * an author the server does not send, or painting a read failure as "never changed". All four
 * look identical on screen if nobody tests them.
 */

function entrada(parcial: Partial<RoleBriefHistoryEntry>): RoleBriefHistoryEntry {
  return { id: '1', tenant_id: 'Steven', alias: 'kant', operation: 'update', ...parcial };
}

describe('el orden del diario', () => {
  it('pone el cambio más reciente arriba, aunque el servidor los mande al revés', () => {
    const ordenadas = entradasMasNuevasPrimero([
      entrada({ id: '1', changed_at: '2026-08-23T03:00:00.000Z' }),
      entrada({ id: '2', changed_at: '2026-08-23T04:00:00.000Z' }),
    ]);

    expect(ordenadas.map((e) => e.id)).toEqual(['2', '1']);
  });

  it('desempata el id como NÚMERO: comparado como texto, la entrada 10 cae debajo de la 9', () => {
    // The `id` travels as a string and this repo already had a query that ordered
    // `id::text DESC`, which is exactly this bug. With the same date, the tiebreaker decides it.
    const ordenadas = entradasMasNuevasPrimero([
      entrada({ id: '9', changed_at: '2026-08-23T04:00:00.000Z' }),
      entrada({ id: '10', changed_at: '2026-08-23T04:00:00.000Z' }),
    ]);

    expect(ordenadas.map((e) => e.id)).toEqual(['10', '9']);
  });

  it('una entrada sin fecha se va al final, pero NO desaparece de la lista', () => {
    const ordenadas = entradasMasNuevasPrimero([
      entrada({ id: '5', changed_at: null }),
      entrada({ id: '6', changed_at: '2026-08-23T04:00:00.000Z' }),
    ]);

    expect(ordenadas.map((e) => e.id)).toEqual(['6', '5']);
    expect(ordenadas).toHaveLength(2);
  });
});

describe('qué pasó en cada entrada', () => {
  it('distingue el alta: antes NO tenía rol, y eso no es lo mismo que tenerlo vacío', () => {
    const cambio = resumirCambio(entrada({ previous_brief: null, new_brief: 'Sos kant.' }));

    expect(cambio.clase).toBe('alta');
    expect(cambio.titulo).toMatch(/por primera vez/i);
    expect(cambio.dejaSinRol).toBe(false);
  });

  it('marca el borrado como lo que es: el alias se queda sin identidad en cada entrega', () => {
    const cambio = resumirCambio(entrada({ previous_brief: 'Sos kant.', new_brief: null }));

    expect(cambio.clase).toBe('borrado');
    expect(cambio.dejaSinRol).toBe(true);
    expect(cambio.detalle).toMatch(/sin rol declarado/i);
  });

  it('no llama «reescritura» a un guardado que dejó el texto igual', () => {
    // The trigger logs ANY row change, including one that only moved the template.
    // Saying "the role was rewritten" there would be inventing a change that did not happen.
    const cambio = resumirCambio(entrada({ previous_brief: 'Sos kant.', new_brief: 'Sos kant.' }));

    expect(cambio.clase).toBe('sin-texto');
    expect(cambio.titulo).toMatch(/sin tocar el texto/i);
  });

  it('en una reescritura da el salto de longitud en puntos de código, no en unidades UTF-16', () => {
    // An emoji is ONE character for the database CHECK. Counting it as two would give a false delta.
    const cambio = resumirCambio(entrada({ previous_brief: 'ab', new_brief: 'ab🙂' }));

    expect(cambio.clase).toBe('reescritura');
    expect(cambio.delta).toBe(1);
  });
});

describe('el vínculo con la plantilla', () => {
  it('avisa de que editar a mano DESVINCULÓ la plantilla, que si no no se entera nadie', () => {
    const aviso = cambioDePlantilla(entrada({ previous_template_slug: 'orquestador', new_template_slug: null }));

    expect(aviso).toMatch(/desvinculado de la plantilla «orquestador»/i);
  });

  it('calla cuando el vínculo no se movió: un aviso por cada fila sería ruido', () => {
    expect(cambioDePlantilla(entrada({ previous_template_slug: null, new_template_slug: null }))).toBeUndefined();
  });
});

describe('quién lo cambió', () => {
  it('con las columnas de autor en NULL —que es lo que manda producción hoy— no inventa a nadie', () => {
    expect(actorDeEntrada(entrada({ actor_tenant: null, actor_alias: null }))).toBeUndefined();
  });

  it('cuando el servidor SÍ manda autor, lo muestra con su tenant', () => {
    expect(actorDeEntrada(entrada({ actor_tenant: 'Steven', actor_alias: 'zeus' }))).toBe('Steven/zeus');
  });
});

describe('qué se restaura al deshacer', () => {
  it('devuelve el texto ANTERIOR al cambio, que es lo que significa deshacerlo', () => {
    expect(restauracionDe(entrada({ previous_brief: 'Sos kant.' }))).toEqual({ clase: 'texto', texto: 'Sos kant.' });
  });

  it('recuperar un alta se marca aparte: prepara role_summary vacío sin escribir nada', () => {
    expect(restauracionDe(entrada({ previous_brief: null }))).toEqual({ clase: 'borra' });
  });
});

describe('los tres desenlaces del diario, que no son dos', () => {
  it('sin publicar es «no se pudo mirar», no «no cambió nunca»', () => {
    const estado = estadoDelDiario({ publicado: false, motivo: 'respondió 404.' });

    expect(estado.clase).toBe('no-publicado');
  });

  it('publicado y vacío es un hecho medido: se miró y no hay cambios', () => {
    expect(estadoDelDiario({ publicado: true, entries: [] }).clase).toBe('vacio');
  });

  it('publicado con entradas las devuelve ya ordenadas', () => {
    const estado = estadoDelDiario({
      publicado: true,
      entries: [
        entrada({ id: '1', changed_at: '2026-08-23T03:00:00.000Z' }),
        entrada({ id: '2', changed_at: '2026-08-23T04:00:00.000Z' }),
      ],
    });

    expect(estado.clase).toBe('entradas');
    if (estado.clase !== 'entradas') return;
    expect(estado.entradas.map((e) => e.id)).toEqual(['2', '1']);
  });
});
