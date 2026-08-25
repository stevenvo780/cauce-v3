import { describe, expect, it } from 'vitest';
import { ConfigMutationSchema } from '@cauce/protocol';

/**
 * 🔴 **CINCO TOPES QUE GOBIERNAN LA FLOTA Y NO SE PODÍAN TOCAR DESDE NINGUNA PANTALLA.**
 *
 * La migración 019 añadió a `agent_chain_policies` cinco columnas —`delegation_caps_enabled`,
 * `max_fanout_per_turn`, `max_edge_repeats_per_root`, `max_delegations_per_root`,
 * `human_gate_enabled`— y el servidor las APLICA: `loadChainPolicy` en
 * `packages/store/src/repository.ts` las lee y con ellas corta delegaciones en caliente.
 *
 * Y sin embargo no estaban ni en el `SELECT` del snapshot ni en el esquema de la mutación. O sea
 * que la única forma de cambiarlas era un `UPDATE` crudo contra la base —la propia 019 lo
 * documenta así, como el «apagado de emergencia»—: sin revisión, sin mutación inversa que alcance
 * el botón de deshacer, sin asiento en `audit_events` y sin quién lo hizo.
 *
 * `apps/console/src/features/config/areas.ts` llevaba el defecto escrito en un comentario, con
 * las líneas exactas, y la frase «todavía no se pueda arreglar acá». Ya se puede.
 *
 * ── Es el defecto ESPEJO del que persigue todo este trabajo ──────────────────────────────────
 *
 * El otro lado era enseñar ocho campos editables de los que sólo uno tenía lector real. Éste es
 * aplicar cinco topes que ninguna pantalla enseña. Callar un tope que gobierna la flota es la
 * misma mentira que enseñar un campo que no gobierna nada, con el signo cambiado.
 */

function mutacion(value: Record<string, unknown>) {
  return ConfigMutationSchema.safeParse({
    resource: 'chain_policy', action: 'update', id: 'default', value
  });
}

describe('los cinco topes de la 019 entran por la mutación de configuración', () => {
  const CAMPOS = [
    ['delegation_caps_enabled', false],
    ['max_fanout_per_turn', 12],
    ['max_edge_repeats_per_root', 5],
    ['max_delegations_per_root', 128],
    ['human_gate_enabled', false]
  ] as const;

  for (const [campo, valor] of CAMPOS) {
    it(`acepta ${campo}`, () => {
      expect(mutacion({ [campo]: valor }).success).toBe(true);
    });
  }

  it('acepta los cinco a la vez, que es como se hace un apagado de emergencia', () => {
    /*
     * El caso real: el `UPDATE` que la 019 documenta apaga `delegation_caps_enabled` y
     * `human_gate_enabled` en el mismo momento. Si sólo se pudieran mandar de uno en uno, el
     * apagado dejaría a la flota medio segundo con los topes en un estado que nadie eligió.
     */
    expect(mutacion({
      delegation_caps_enabled: false,
      max_fanout_per_turn: 6,
      max_edge_repeats_per_root: 3,
      max_delegations_per_root: 64,
      human_gate_enabled: false
    }).success).toBe(true);
  });
});

describe('los rangos son EXACTAMENTE los del CHECK de Postgres', () => {
  /*
   * Copiados uno a uno del `agent_chain_policies_delegation_caps_check`:
   *   max_fanout_per_turn        BETWEEN 1 AND 100
   *   max_edge_repeats_per_root  BETWEEN 1 AND 1000
   *   max_delegations_per_root   BETWEEN 1 AND 10000
   *
   * Que coincidan no es simetría: es lo que hace que un valor fuera de rango se rechace con un
   * mensaje que NOMBRA el campo, en vez de estallar como un error de restricción a mitad de la
   * transacción con un texto que el operador no puede accionar. En un desacuerdo manda el SQL: la
   * columna es la que no se puede mover sin migración.
   */
  const LIMITES = [
    ['max_fanout_per_turn', 1, 100],
    ['max_edge_repeats_per_root', 1, 1_000],
    ['max_delegations_per_root', 1, 10_000]
  ] as const;

  for (const [campo, minimo, maximo] of LIMITES) {
    it(`${campo}: acepta ${minimo} y ${maximo}, y rechaza lo de fuera`, () => {
      expect(mutacion({ [campo]: minimo }).success).toBe(true);
      expect(mutacion({ [campo]: maximo }).success).toBe(true);
      expect(mutacion({ [campo]: minimo - 1 }).success).toBe(false);
      expect(mutacion({ [campo]: maximo + 1 }).success).toBe(false);
    });

    it(`${campo}: rechaza un decimal, que el CHECK de un integer rechazaría igual`, () => {
      expect(mutacion({ [campo]: 2.5 }).success).toBe(false);
    });
  }

  it('CONTROL NEGATIVO: un campo inventado se rechaza — `.strict()` sigue puesto', () => {
    /*
     * Sin esto, una errata en el nombre desde la consola pasaría el esquema, no encontraría columna
     * y se guardaría un cambio que no cambia nada. El operador vería «guardado» y el tope seguiría
     * donde estaba: exactamente el defecto que este trabajo persigue.
     */
    expect(mutacion({ max_fanout_por_turno: 12 }).success).toBe(false);
  });

  it('CONTROL NEGATIVO: los campos que ya existían siguen aceptándose', () => {
    // Añadir cinco campos no puede haber roto los cinco de antes.
    expect(mutacion({
      progress_relay_enabled: true,
      progress_relay_max_events: 8,
      cycle_cut_enabled: true,
      failure_coalesce_enabled: true,
      failure_coalesce_window_seconds: 900
    }).success).toBe(true);
  });
});

describe('el snapshot y la inversa los llevan, o el botón de deshacer los borraría', () => {
  it('el SELECT del snapshot nombra las cinco columnas', async () => {
    /*
     * La consola no puede editar lo que no ve: si el snapshot no las trae, la pantalla pinta cajas
     * vacías y el primer guardado escribe esos vacíos encima de los topes que la flota tenía.
     */
    const fuente = await import('node:fs/promises').then((fs) => fs.readFile(
      new URL('../../packages/store/src/configuration.ts', import.meta.url), 'utf8'
    ));
    const snapshot = fuente.slice(fuente.indexOf('FROM agent_chain_policies ORDER BY id') - 600);
    for (const campo of [
      'delegation_caps_enabled', 'max_fanout_per_turn', 'max_edge_repeats_per_root',
      'max_delegations_per_root', 'human_gate_enabled'
    ]) {
      expect(snapshot.slice(0, 700)).toContain(campo);
    }
  });

  it('la inversa repone las cinco', async () => {
    /*
     * `oldValue` es LITERALMENTE el cuerpo de la mutación inversa. Una columna que no viaje ahí
     * vuelve como ausente al deshacer, y el `update` la deja en su valor por defecto: deshacer un
     * cambio de umbral y que se muevan OTROS cuatro es peor que no tener el botón.
     */
    const fuente = await import('node:fs/promises').then((fs) => fs.readFile(
      new URL('../../packages/store/src/configuration.ts', import.meta.url), 'utf8'
    ));
    const desde = fuente.indexOf("resource: 'chain_policy', action: 'update', id: mutation.id");
    expect(desde).toBeGreaterThan(0);
    const inversa = fuente.slice(desde, desde + 800);
    for (const campo of [
      'delegation_caps_enabled: old.delegation_caps_enabled',
      'max_fanout_per_turn: old.max_fanout_per_turn',
      'max_edge_repeats_per_root: old.max_edge_repeats_per_root',
      'max_delegations_per_root: old.max_delegations_per_root',
      'human_gate_enabled: old.human_gate_enabled'
    ]) {
      expect(inversa).toContain(campo);
    }
  });
});
