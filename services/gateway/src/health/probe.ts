import { withTransaction, type DatabaseClient, type DatabasePool } from '@cauce/store';
import { isLiteralTrue } from '@cauce/protocol';

interface SchemaContractSpec {
  readonly name: string;
  readonly sql: string;
  readonly params?: readonly unknown[];
  readonly required: readonly string[];
  /** Runs inside the same read-only transaction once the contract row has been accepted. */
  readonly after?: (client: DatabaseClient) => Promise<void>;
}

/**
 * Single home for the readiness scaffolding every schema probe shares: a read-only transaction
 * with bounded lock and statement timeouts, one contract row, and a boolean fan-out that refuses
 * PostgreSQL authority arriving as anything but a literal true.
 */
export async function probeSchemaContract(
  pool: DatabasePool, spec: SchemaContractSpec,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query('SET TRANSACTION READ ONLY');
    await client.query("SET LOCAL lock_timeout='1000ms'");
    await client.query("SET LOCAL statement_timeout='2000ms'");
    const schema = await client.query<Record<string, unknown>>(
      spec.sql, spec.params === undefined ? undefined : [...spec.params],
    );
    const contract = schema.rows[0];
    if (contract === undefined
        || spec.required.some((column) => !isLiteralTrue(contract[column]))) {
      throw new Error(`gateway ${spec.name} contract is unavailable`);
    }
    await spec.after?.(client);
  });
}
