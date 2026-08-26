export function collectReleaseStateMetrics(
  path: string,
  activeConnectionLeases: number,
): Promise<string>;

export function activeConnectionLeaseCount(pool: {
  query(sql: string): Promise<{
    rowCount: number | null;
    rows: Array<{ count?: unknown }>;
  }>;
}): Promise<number>;
