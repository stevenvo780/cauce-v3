import type { DatabasePool } from '@cauce/store';

/**
 * Sessions closed before their cookie expired. A signed session cookie slides while it is used,
 * so closing it has to be remembered until the day its absolute ceiling would have ended it.
 */
export interface ConsoleSessionRevocations {
  revoke(sid: string, humanId: string, notAfterMs: number): Promise<void>;
  isRevoked(sid: string): Promise<boolean>;
}

export class PostgresConsoleSessionRevocations implements ConsoleSessionRevocations {
  constructor(private readonly pool: DatabasePool) {}

  async revoke(sid: string, humanId: string, notAfterMs: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO console_session_revocations(sid, human_id, not_after)
       VALUES ($1, $2::uuid, to_timestamp($3::double precision / 1000))
       ON CONFLICT (sid) DO NOTHING`,
      [sid, humanId, notAfterMs],
    );
    await this.pool.query('DELETE FROM console_session_revocations WHERE not_after < now() - interval \'1 day\'');
  }

  async isRevoked(sid: string): Promise<boolean> {
    const result = await this.pool.query('SELECT 1 FROM console_session_revocations WHERE sid=$1', [sid]);
    return result.rows.length > 0;
  }
}
