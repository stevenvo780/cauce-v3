export const schemaLockTimeoutSql = "SELECT setting::integer AS timeout_ms FROM pg_settings WHERE name='lock_timeout' AND unit='ms'";
const schemaSetTimeoutSql = "SELECT set_config('lock_timeout',$1,true)";
const schemaSharedLockSql = 'SELECT pg_advisory_xact_lock_shared(783_003_003)';

export const schemaBarrierStatements = [
  schemaLockTimeoutSql, schemaSetTimeoutSql, schemaSharedLockSql, schemaSetTimeoutSql,
] as const;

export function schemaBarrierReply(
  sql: string, params: readonly unknown[] = [],
): { rows: Record<string, unknown>[]; rowCount: number } | undefined {
  if (sql === schemaLockTimeoutSql) {
    if (params.length !== 0) throw new Error('Unexpected schema timeout parameters');
    return { rows: [{ timeout_ms: 0 }], rowCount: 1 };
  }
  if (sql === schemaSharedLockSql) {
    if (params.length !== 0) throw new Error('Unexpected schema barrier parameters');
    return { rows: [{ pg_advisory_xact_lock_shared: '' }], rowCount: 1 };
  }
  if (sql === schemaSetTimeoutSql) {
    if (params.length !== 1 || (params[0] !== '5000ms' && params[0] !== '0ms')) {
      throw new Error('Unexpected schema timeout value');
    }
    return { rows: [{ set_config: params[0] }], rowCount: 1 };
  }
  return undefined;
}
