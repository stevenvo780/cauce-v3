import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigMutationSchema } from '@cauce/protocol';

const CONFIGURATION_ENTRY = fileURLToPath(
  new URL('../../packages/store/src/configuration.ts', import.meta.url),
);
const CONFIGURATION_DIRECTORY = fileURLToPath(
  new URL('../../packages/store/src/configuration/', import.meta.url),
);

async function configurationFiles(directory: string = CONFIGURATION_DIRECTORY): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(async (entry): Promise<string[]> => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return configurationFiles(path);
      return entry.name.endsWith('.ts') ? [path] : [];
    }));
  return files.flat();
}

async function configurationSource(): Promise<string> {
  const files = [CONFIGURATION_ENTRY, ...await configurationFiles()];
  return (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
}

/**
 * 🔴 **FIVE CAPS THAT GOVERN THE FLEET AND COULD NOT BE TOUCHED FROM ANY SCREEN.**
 *
 * Migration 019 added five columns to `agent_chain_policies` — `delegation_caps_enabled`,
 * `max_fanout_per_turn`, `max_edge_repeats_per_root`, `max_delegations_per_root`,
 * `human_gate_enabled` — and the server APPLIES them: `loadChainPolicy` in
 * `packages/store/src/repository.ts` reads them and with them cuts delegations on the fly.
 *
 * And yet they were neither in the snapshot's `SELECT` nor in the mutation schema. So the only
 * way to change them was a raw `UPDATE` against the database — which 019 itself documents as the
 * "emergency kill switch" — with no revision, no inverse mutation that reaches the undo button,
 * no entry in `audit_events`, and no record of who did it.
 *
 * `console/src/features/config/areas.ts` had the defect written in a comment, with the exact
 * lines and the phrase "it still cannot be fixed here". It can be now.
 *
 * ── This is the MIRROR defect of what all this work pursues ──────────────────────────────────
 *
 * The other side was exposing eight editable fields of which only one had a real reader. This is
 * applying five caps that no screen exposes. Silencing a cap that governs the fleet is the same
 * lie as exposing a field that governs nothing, with the sign flipped.
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
     * The real case: the `UPDATE` documented in 019 turns off `delegation_caps_enabled` and
     * `human_gate_enabled` at the same moment. If they could only be sent one at a time, the
     * kill switch would leave the fleet half a second with the caps in a state nobody chose.
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
   * Copied one by one from the `agent_chain_policies_delegation_caps_check`:
   *   max_fanout_per_turn        BETWEEN 1 AND 100
   *   max_edge_repeats_per_root  BETWEEN 1 AND 1000
   *   max_delegations_per_root   BETWEEN 1 AND 10000
   *
   * Their matching is not symmetry: it is what makes an out-of-range value be rejected with a
   * message that NAMES the field, instead of blowing up as a constraint error mid-transaction with
   * text the operator cannot act on. In a disagreement the SQL wins: the column is what cannot be
   * moved without a migration.
   */
  const LIMITES = [
    ['max_fanout_per_turn', 1, 100],
    ['max_edge_repeats_per_root', 1, 1_000],
    ['max_delegations_per_root', 1, 10_000]
  ] as const;

  for (const [campo, minimo, maximo] of LIMITES) {
    it(`${campo}: acepta ${String(minimo)} y ${String(maximo)}, y rechaza lo de fuera`, () => {
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
     * Without this, a typo in the name from the console would pass the schema, find no column,
     * and save a change that changes nothing. The operator would see "saved" and the cap would
     * stay where it was: exactly the defect this work pursues.
     */
    expect(mutacion({ max_fanout_por_turno: 12 }).success).toBe(false);
  });

  it('CONTROL NEGATIVO: los campos que ya existían siguen aceptándose', () => {
    // Adding five fields cannot have broken the five from before.
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
     * The console cannot edit what it does not see: if the snapshot does not bring them, the
     * screen paints empty boxes and the first save writes those empties on top of the caps the fleet had.
     */
    const fuente = await configurationSource();
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
     * `oldValue` is LITERALLY the body of the inverse mutation. A column that does not travel
     * there comes back as absent on undo, and the `update` leaves it at its default: undoing a
     * threshold change and seeing the OTHER four move is worse than not having the button.
     */
    const fuente = await configurationSource();
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

/**
 * 🔴 **THE SAME DEFECT IN ANOTHER COLUMN: `agents.max_concurrent_deliveries` (migration 015).**
 *
 * It is the REAL cap on in-flight deliveries of an agent — `repository.ts` applies it when
 * splitting the budget — and it was neither in the snapshot nor in the mutation. Its only way
 * to change was a hand-written `UPDATE`, and 015 itself documents that `UPDATE ... = NULL` as the
 * emergency exit when the cap strangles an agent that can actually parallelize.
 *
 * It lives in this same file and not in another because it is THE SAME defect: a value that
 * governs production and that no screen exposes. Splitting them would suggest they are two cases.
 */
describe('el techo de entregas en vuelo de un agente se puede editar', () => {
  function agente(value: Record<string, unknown>) {
    return ConfigMutationSchema.safeParse({
      resource: 'agent', action: 'update', tenant_id: 'Steven', alias: 'zeus', value
    });
  }

  it('acepta un techo dentro del rango del CHECK (1-100)', () => {
    expect(agente({ max_concurrent_deliveries: 1 }).success).toBe(true);
    expect(agente({ max_concurrent_deliveries: 100 }).success).toBe(true);
  });

  it('rechaza lo de fuera del rango y los decimales', () => {
    expect(agente({ max_concurrent_deliveries: 0 }).success).toBe(false);
    expect(agente({ max_concurrent_deliveries: 101 }).success).toBe(false);
    expect(agente({ max_concurrent_deliveries: 2.5 }).success).toBe(false);
  });

  it('`null` se acepta y NO es lo mismo que no declararlo: significa SIN TECHO', () => {
    /*
     * The distinction is the whole emergency exit. Declared `null` removes the cap; an absent
     * field leaves whatever was there. A schema that were only `.optional()` could not express
     * "remove the cap from this agent" and that operation would need SQL again.
     */
    expect(agente({ max_concurrent_deliveries: null }).success).toBe(true);
    expect(agente({ display_name: 'Zeus' }).success).toBe(true);
  });

  it('el snapshot lo trae, o la consola pintaría una caja vacía y el primer guardado lo borraría', async () => {
    const fuente = await configurationSource();
    const desde = fuente.indexOf('FROM agents WHERE $1::text IS NULL OR tenant_id=$1');
    expect(desde).toBeGreaterThan(0);
    expect(fuente.slice(desde - 400, desde)).toContain('max_concurrent_deliveries');
  });

  it('el SELECT bajo lock lo trae, o el DESHACER le pondría techo a un agente destechado', async () => {
    /*
     * `oldValue` is the body of the inverse. Here `null` is not just a missing value: it is a
     * deliberate decision from the operator — "this agent has no cap" — that the undo would
     * revert without anyone asking for it.
     */
    const fuente = await configurationSource();
    const desde = fuente.indexOf('FROM agents WHERE tenant_id=$1 AND alias=$2 FOR UPDATE');
    expect(desde).toBeGreaterThan(0);
    expect(fuente.slice(desde - 400, desde)).toContain('max_concurrent_deliveries');
  });
});
