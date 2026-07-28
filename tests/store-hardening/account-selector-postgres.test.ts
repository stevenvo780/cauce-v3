/**
 * Cobertura del selector de cuenta (packages/store/src/accounts.ts).
 *
 * Corre contra Postgres de verdad —no un doble— porque lo que se está probando ES el SQL: el
 * orden de fallback sale de un ORDER BY, el agotamiento de un LATERAL contra `quota_window_state`,
 * y la defensa de la pausa manual vive ENTERA en el WHERE de un UPDATE. Un mock de `pg` habría
 * pasado con el `ON CONFLICT` roto que este mismo parche arregla.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  selectAccountForAlias, AUTOMATIC_PAUSE_PREFIX, type DatabasePool
} from '@cauce/store';
import { startTestDatabase, type TestDatabase } from '../helpers/postgres.js';

let database: TestDatabase;
let pool: DatabasePool;

/** Reloj fijo: la selección depende de `paused_until > now` y de `reset_at > now`, así que un
 *  `new Date()` real haría que el resultado dependiera de cuánto tardó el contenedor en arrancar. */
const NOW = new Date('2026-07-28T12:00:00.000Z');
const IN_AN_HOUR = new Date('2026-07-28T13:00:00.000Z');
const AN_HOUR_AGO = new Date('2026-07-28T11:00:00.000Z');

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
}, 180_000);

afterAll(async () => {
  if (pool) await pool.end();
  if (database?.container) await database.container.stop();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM quota_window_state`);
  await pool.query(`DELETE FROM agent_account_bindings`);
  await pool.query(`DELETE FROM alias_routing_ceiling`);
  await pool.query(`DELETE FROM provider_accounts`);
  await pool.query(`DELETE FROM agents WHERE tenant_id='Steven'`);
  await pool.query(
    `INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory)
     VALUES('Steven','argos','claude','Argos',true,'ws-argos','dev','/home/dev','/datos/agents/argos')`
  );
});

/** Alta de una suscripción + su techo + su binding, que es el trío mínimo que el selector lee.
 *  `alias_routing_ceiling` no es opcional: `agent_account_bindings` referencia al TECHO, no a
 *  `provider_accounts` (migración 010), así que sin la fila de techo el binding ni siquiera entra. */
async function account(options: {
  id: string;
  priority: number;
  provider?: string;
  accountEnabled?: boolean;
  bindingEnabled?: boolean;
  pausedUntil?: Date | null;
  pausedReason?: string | null;
}): Promise<void> {
  const provider = options.provider ?? 'claude';
  await pool.query(
    `INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,label,
       credential_ref_kind,credential_ref,shared_with_pool,enabled,paused_until,paused_reason)
     VALUES($1,$2,$3,'Steven',$4,'env_path',$5,false,$6,$7,$8)`,
    [
      options.id, provider, `ext-${options.id}`, `Cuenta ${options.id}`,
      `CAUCE_${options.id.toUpperCase().replaceAll('-', '_')}_PATH`,
      options.accountEnabled ?? true, options.pausedUntil ?? null, options.pausedReason ?? null
    ]
  );
  await pool.query(
    `INSERT INTO alias_routing_ceiling(tenant_id,alias,account_id,account_payer_tenant,created_by_tenant)
     VALUES('Steven','argos',$1,'Steven','Steven')`,
    [options.id]
  );
  await pool.query(
    `INSERT INTO agent_account_bindings(tenant_id,agent_alias,account_id,priority,enabled)
     VALUES('Steven','argos',$1,$2,$3)`,
    [options.id, options.priority, options.bindingEnabled ?? true]
  );
}

/** Una ventana de cuota atada a la cuenta. `remaining_percent<=0` o `status='rate-limited'` es
 *  agotamiento, misma condición que la auto-pausa de la migración 013 §(d). */
async function quotaWindow(options: {
  accountId: string;
  remaining: number | null;
  status?: string | null;
  resetAt?: Date | null;
  windowKey?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO quota_window_state(collector_tenant,host,provider,group_key,window_key,
       captured_at,remaining_percent,status,reset_at,account_id)
     VALUES('Steven','kratos','claude','default',$1,$2,$3,$4,$5,$6)`,
    [
      options.windowKey ?? 'session', NOW.toISOString(), options.remaining,
      options.status ?? null, options.resetAt ?? null, options.accountId
    ]
  );
}

const select = () => selectAccountForAlias(pool, {
  tenant_id: 'Steven', alias: 'argos', provider: 'claude', now: NOW
});

describe('selector de cuenta', () => {
  it('respeta la prioridad de agent_account_bindings', async () => {
    await account({ id: 'claude-b', priority: 50 });
    await account({ id: 'claude-a', priority: 10 });

    const selection = await select();

    expect(selection.selected?.account_id).toBe('claude-a');
    expect(selection.failover).toBe(false);
    // El orden de la traza es el orden real de fallback, no el de inserción.
    expect(selection.candidates.map((c) => c.account_id)).toEqual(['claude-a', 'claude-b']);
    // El locator viaja al adaptador (es una referencia, no el secreto: migración 010).
    expect(selection.selected?.credential_ref).toBe('CAUCE_CLAUDE_A_PATH');
  });

  it('salta un binding deshabilitado y cae a la siguiente, dejando traza', async () => {
    await account({ id: 'claude-a', priority: 10, bindingEnabled: false });
    await account({ id: 'claude-b', priority: 50 });

    const selection = await select();

    expect(selection.selected?.account_id).toBe('claude-b');
    expect(selection.failover).toBe(true);
    expect(selection.candidates[0]).toMatchObject({
      account_id: 'claude-a', skipped: 'binding_disabled'
    });
  });

  it('salta una cuenta deshabilitada globalmente', async () => {
    await account({ id: 'claude-a', priority: 10, accountEnabled: false });
    await account({ id: 'claude-b', priority: 50 });

    const selection = await select();

    expect(selection.selected?.account_id).toBe('claude-b');
    expect(selection.candidates[0]?.skipped).toBe('account_disabled');
  });

  it('salta una cuenta con paused_until vigente y hace failover', async () => {
    await account({
      id: 'claude-a', priority: 10,
      pausedUntil: IN_AN_HOUR, pausedReason: `${AUTOMATIC_PAUSE_PREFIX}claude/default/session`
    });
    await account({ id: 'claude-b', priority: 50 });

    const selection = await select();

    expect(selection.selected?.account_id).toBe('claude-b');
    expect(selection.failover).toBe(true);
    expect(selection.candidates[0]).toMatchObject({
      account_id: 'claude-a', skipped: 'paused_automatic', paused_until: IN_AN_HOUR.toISOString()
    });
  });

  it('una pausa YA VENCIDA no descarta a la cuenta', async () => {
    await account({
      id: 'claude-a', priority: 10,
      pausedUntil: AN_HOUR_AGO, pausedReason: `${AUTOMATIC_PAUSE_PREFIX}claude/default/session`
    });
    await account({ id: 'claude-b', priority: 50 });

    const selection = await select();

    expect(selection.selected?.account_id).toBe('claude-a');
    expect(selection.failover).toBe(false);
  });

  it('detecta agotamiento desde quota_window_state, auto-pausa y cae a la siguiente', async () => {
    await account({ id: 'claude-a', priority: 10 });
    await account({ id: 'claude-b', priority: 50 });
    await quotaWindow({ accountId: 'claude-a', remaining: 0, resetAt: IN_AN_HOUR });

    const selection = await select();

    expect(selection.selected?.account_id).toBe('claude-b');
    expect(selection.failover).toBe(true);
    expect(selection.candidates[0]?.skipped).toBe('quota_exhausted');
    expect(selection.candidates[0]?.exhausted_window).toBe('claude/default/session');
    expect(selection.auto_paused).toEqual([{
      account_id: 'claude-a',
      paused_until: IN_AN_HOUR.toISOString(),
      paused_reason: `${AUTOMATIC_PAUSE_PREFIX}claude/default/session`
    }]);

    // La pausa quedó PERSISTIDA: la próxima selección no tiene que volver a descubrirla.
    const persisted = await pool.query<{ paused_until: Date; paused_reason: string }>(
      `SELECT paused_until,paused_reason FROM provider_accounts WHERE id='claude-a'`
    );
    expect(persisted.rows[0]?.paused_reason).toBe(`${AUTOMATIC_PAUSE_PREFIX}claude/default/session`);
    expect(persisted.rows[0]?.paused_until?.toISOString()).toBe(IN_AN_HOUR.toISOString());
  });

  it('trata como agotamiento el status rate-limited aunque remaining no sea 0', async () => {
    await account({ id: 'claude-a', priority: 10 });
    await account({ id: 'claude-b', priority: 50 });
    await quotaWindow({ accountId: 'claude-a', remaining: 42, status: 'rate-limited', resetAt: IN_AN_HOUR });

    const selection = await select();

    expect(selection.selected?.account_id).toBe('claude-b');
    expect(selection.candidates[0]?.skipped).toBe('quota_exhausted');
  });

  it('ignora una muestra agotada cuyo reset YA pasó', async () => {
    // Sin esta guarda, un remaining=0 viejo que nadie volvió a muestrear dejaría al alias sin
    // ninguna cuenta para siempre — y en prod NADIE muestreaba, porque la ingesta estaba rota.
    await account({ id: 'claude-a', priority: 10 });
    await quotaWindow({ accountId: 'claude-a', remaining: 0, resetAt: AN_HOUR_AGO });

    const selection = await select();

    expect(selection.selected?.account_id).toBe('claude-a');
    expect(selection.auto_paused).toEqual([]);
  });

  it('agotada SIN reset: la salta pero NO persiste una pausa sin horizonte', async () => {
    await account({ id: 'claude-a', priority: 10 });
    await account({ id: 'claude-b', priority: 50 });
    await quotaWindow({ accountId: 'claude-a', remaining: 0, resetAt: null });

    const selection = await select();

    expect(selection.selected?.account_id).toBe('claude-b');
    expect(selection.candidates[0]?.skipped).toBe('quota_exhausted');
    expect(selection.auto_paused).toEqual([]);
    const persisted = await pool.query<{ paused_until: Date | null }>(
      `SELECT paused_until FROM provider_accounts WHERE id='claude-a'`
    );
    expect(persisted.rows[0]?.paused_until).toBeNull();
  });

  it('NUNCA pisa una pausa manual, ni siquiera con la cuota agotada', async () => {
    // Éste es el bug del intento anterior: escribía paused_reason sin condición, así que el
    // automatismo se comía el motivo escrito por el operador. La migración 013 §(e) documenta el
    // LIKE 'quota_exhausted:%' justamente para esto.
    await account({
      id: 'claude-a', priority: 10,
      pausedUntil: AN_HOUR_AGO, pausedReason: 'suspendida a mano: Steven revisando la facturación'
    });
    await account({ id: 'claude-b', priority: 50 });
    await quotaWindow({ accountId: 'claude-a', remaining: 0, resetAt: IN_AN_HOUR });

    const selection = await select();

    expect(selection.selected?.account_id).toBe('claude-b');
    expect(selection.candidates[0]?.skipped).toBe('paused_manual');
    expect(selection.auto_paused).toEqual([]);

    const persisted = await pool.query<{ paused_until: Date | null; paused_reason: string | null }>(
      `SELECT paused_until,paused_reason FROM provider_accounts WHERE id='claude-a'`
    );
    expect(persisted.rows[0]?.paused_reason).toBe('suspendida a mano: Steven revisando la facturación');
    expect(persisted.rows[0]?.paused_until?.toISOString()).toBe(AN_HOUR_AGO.toISOString());
  });

  it('una pausa manual VIGENTE se respeta y se reporta como manual', async () => {
    await account({
      id: 'claude-a', priority: 10,
      pausedUntil: IN_AN_HOUR, pausedReason: 'suspendida a mano'
    });
    await account({ id: 'claude-b', priority: 50 });

    const selection = await select();

    expect(selection.selected?.account_id).toBe('claude-b');
    expect(selection.candidates[0]?.skipped).toBe('paused_manual');
  });

  it('devuelve selected=null cuando ninguna cuenta queda disponible', async () => {
    await account({ id: 'claude-a', priority: 10, accountEnabled: false });
    await account({ id: 'claude-b', priority: 50, bindingEnabled: false });

    const selection = await select();

    expect(selection.selected).toBeNull();
    expect(selection.failover).toBe(false);
    expect(selection.candidates).toHaveLength(2);
    // Sin cuenta pero CON traza: el operador tiene que poder ver por qué se quedó sin ninguna.
    expect(selection.candidates.map((c) => c.skipped)).toEqual(['account_disabled', 'binding_disabled']);
  });

  it('devuelve selected=null y traza vacía cuando el alias no tiene bindings', async () => {
    const selection = await select();
    expect(selection.selected).toBeNull();
    expect(selection.candidates).toEqual([]);
  });

  it('no cruza proveedores: un binding de otro proveedor no es candidato', async () => {
    await account({ id: 'codex-a', priority: 10, provider: 'codex' });
    await account({ id: 'claude-b', priority: 50 });

    const selection = await select();

    expect(selection.selected?.account_id).toBe('claude-b');
    expect(selection.candidates.map((c) => c.account_id)).toEqual(['claude-b']);
  });

  it('es determinista: dos llamadas seguidas dan el mismo orden y la misma elegida', async () => {
    await account({ id: 'claude-a', priority: 10, bindingEnabled: false });
    await account({ id: 'claude-b', priority: 10, bindingEnabled: false });
    await account({ id: 'claude-c', priority: 20 });

    const first = await select();
    const second = await select();

    // Dos bindings DESHABILITADOS pueden compartir prioridad (el índice único es parcial
    // `WHERE enabled`), así que sin el desempate por account_id el orden sería el que devuelva
    // el planificador.
    expect(first.candidates.map((c) => c.account_id)).toEqual(['claude-a', 'claude-b', 'claude-c']);
    expect(second.candidates.map((c) => c.account_id)).toEqual(first.candidates.map((c) => c.account_id));
    expect(second.selected?.account_id).toBe(first.selected?.account_id);
  });

  it('falla en cascada por dos niveles hasta la tercera cuenta', async () => {
    await account({ id: 'claude-a', priority: 10 });
    await account({ id: 'claude-b', priority: 20 });
    await account({ id: 'claude-c', priority: 30 });
    await quotaWindow({ accountId: 'claude-a', remaining: 0, resetAt: IN_AN_HOUR, windowKey: 'session' });
    await quotaWindow({ accountId: 'claude-b', remaining: 0, resetAt: IN_AN_HOUR, windowKey: 'week_all' });

    const selection = await select();

    expect(selection.selected?.account_id).toBe('claude-c');
    expect(selection.failover).toBe(true);
    expect(selection.auto_paused.map((a) => a.account_id)).toEqual(['claude-a', 'claude-b']);
    expect(selection.candidates[1]?.exhausted_window).toBe('claude/default/week_all');
  });
});
