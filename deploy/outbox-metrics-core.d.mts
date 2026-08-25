export interface OutboxMetricsQueryResult {
  readonly rows: readonly unknown[];
  readonly rowCount?: number | null;
}

export interface OutboxMetricsPool {
  query(sql: string): Promise<OutboxMetricsQueryResult>;
}

export function collectOutboxMetrics(pool: OutboxMetricsPool): Promise<string>;
