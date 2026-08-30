import type { DatabasePool } from '@cauce/store';

interface AliasState {
  alias: string;
  lease_alive: boolean;
  active_instance_id?: string;
  lease_expires_at?: string;
  epoch?: number;
  last_activity?: string;
  available: boolean;
}

// Explicitly match the response structure
interface EstadoFlotaResult {
  data: AliasState[];
  available: boolean;
}

interface DeliveryRecord {
  id: string;
  message_id: string;
  recipient_alias: string;
  status: string;
  attempt: number;
  max_attempts: number;
  created_at: string;
  root_message_id?: string;
  available: boolean;
}

interface EntregasResult {
  data: DeliveryRecord[];
  available: boolean;
}

interface ChainNode {
  hop: number;
  source_alias?: string;
  source_tenant?: string;
  target_alias?: string;
  target_tenant?: string;
  status: string;
  created_at: string;
  rejection_code?: string;
}

interface CadenaResult {
  data: ChainNode[];
  available: boolean;
  trace_id?: string;
  root_message_id?: string;
}

interface DeadLetterGroup {
  cause: string;
  count: number;
  recent_examples: {
    delivery_id: string;
    alias: string;
    created_at: string;
    rejection_code?: string;
  }[];
}

interface HealthSummary {
  summary: string;
  timestamp: string;
}

export class FleetReadModel {
  constructor(
    private pool: DatabasePool,
    private tenantId: string
  ) {}

  async estadoFlota(alias?: string): Promise<EstadoFlotaResult> {
    try {
      // Get all aliases from deliveries and leases
      const result = await this.pool.query<{
        alias: string;
        active_instance_id: string | null;
        lease_expires_at: Date | null;
        // bigint: node-postgres hands these back as strings.
        epoch: string | null;
        last_activity: Date | null;
      }>(
        `
        WITH all_aliases AS (
          SELECT alias FROM agents
          WHERE tenant_id = $1 AND enabled = true
          UNION
          SELECT DISTINCT recipient_alias as alias FROM deliveries
          WHERE recipient_tenant = $1
          UNION
          SELECT alias FROM connection_leases
          WHERE tenant_id = $1
        )
        SELECT
          aa.alias,
          l.instance_id as active_instance_id,
          l.lease_until as lease_expires_at,
          l.epoch,
          MAX(m.created_at) as last_activity
        FROM all_aliases aa
        LEFT JOIN connection_leases l ON l.alias = aa.alias AND l.tenant_id = $1
        LEFT JOIN deliveries d ON d.recipient_alias = aa.alias AND d.recipient_tenant = $1
        LEFT JOIN messages m ON m.id = d.message_id
        WHERE $2::text IS NULL OR aa.alias = $2
        GROUP BY aa.alias, l.instance_id, l.lease_until, l.epoch
        ORDER BY aa.alias
        `,
        [this.tenantId, alias ?? null]
      );

      const mappedData = result.rows.map((row) => {
        const obj: AliasState = {
          alias: row.alias,
          lease_alive: row.lease_expires_at ? new Date(row.lease_expires_at) > new Date() : false,
          available: true,
        };
        if (row.active_instance_id) obj.active_instance_id = row.active_instance_id;
        if (row.lease_expires_at) obj.lease_expires_at = row.lease_expires_at.toISOString();
        if (row.epoch !== null) obj.epoch = Number(row.epoch);
        if (row.last_activity) obj.last_activity = row.last_activity.toISOString();
        return obj;
      });

      return { data: mappedData, available: true };
    } catch (error) {
      throw queryFailure('estado_flota', error);
    }
  }

  async entregas(
    alias?: string,
    estado?: string,
    limit = 100
  ): Promise<EntregasResult> {
    try {
      const bounded = Math.min(Math.max(Number.isInteger(limit) ? limit : 100, 1), 1000);

      const result = await this.pool.query<{
        id: string;
        message_id: string;
        recipient_alias: string;
        status: string;
        attempt: number;
        max_attempts: number;
        created_at: Date;
        root_message_id: string | null;
      }>(
        `
        SELECT
          d.id,
          d.message_id,
          d.recipient_alias,
          d.status,
          d.attempt,
          d.max_attempts,
          d.created_at,
          (m.body->'correlation'->>'root_message_id')::text as root_message_id
        FROM deliveries d
        LEFT JOIN messages m ON m.id = d.message_id
        WHERE d.recipient_tenant = $1
          AND ($2::text IS NULL OR d.recipient_alias = $2)
          AND ($3::text IS NULL OR d.status = $3)
        ORDER BY d.created_at DESC
        LIMIT $4
        `,
        [this.tenantId, alias ?? null, estado ?? null, bounded]
      );

      const mappedData = result.rows.map((row) => {
        const obj: DeliveryRecord = {
          id: row.id,
          message_id: row.message_id,
          recipient_alias: row.recipient_alias,
          status: row.status,
          attempt: row.attempt,
          max_attempts: row.max_attempts,
          created_at: row.created_at.toISOString(),
          available: true,
        };
        if (row.root_message_id) obj.root_message_id = row.root_message_id;
        return obj;
      });

      return { data: mappedData, available: true };
    } catch (error) {
      throw queryFailure('entregas', error);
    }
  }

  async cadena(traceId?: string, rootMessageId?: string): Promise<CadenaResult> {
    try {
      if (!traceId && !rootMessageId) {
        return { data: [], available: false };
      }

      const result = await this.pool.query<{
        hop_count: number;
        source_alias: string | null;
        source_tenant: string | null;
        target_alias: string | null;
        target_tenant: string | null;
        status: string;
        created_at: Date;
        rejection_code: string | null;
      }>(
        `
        SELECT
          aom.hop_count,
          aom.source_alias,
          aom.source_tenant,
          aom.target_alias,
          aom.target_tenant,
          aom.status,
          aom.created_at,
          aom.rejection_code
        FROM agent_output_materializations aom
        WHERE ($1::text IS NOT NULL AND aom.trace_id = $1)
           OR ($1::text IS NULL AND aom.correlation->>'root_message_id' = $2)
        ORDER BY aom.hop_count, aom.created_at
        LIMIT 500
        `,
        [traceId ?? null, rootMessageId ?? null]
      );

      const mappedData = result.rows.map((row) => {
        const node: ChainNode = {
          hop: row.hop_count,
          status: row.status,
          created_at: row.created_at.toISOString(),
        };
        if (row.source_alias) node.source_alias = row.source_alias;
        if (row.source_tenant) node.source_tenant = row.source_tenant;
        if (row.target_alias) node.target_alias = row.target_alias;
        if (row.target_tenant) node.target_tenant = row.target_tenant;
        if (row.rejection_code) node.rejection_code = row.rejection_code;
        return node;
      });

      return {
        data: mappedData,
        available: true,
        ...(traceId ? { trace_id: traceId } : { root_message_id: rootMessageId ?? '' }),
      };
    } catch (error) {
      throw queryFailure('cadena', error);
    }
  }

  async deadLetters(): Promise<{ data: DeadLetterGroup[]; available: boolean }> {
    try {
      const result = await this.pool.query<{
        rejection_code: string | null;
        count: string | number;
      }>(
        `
        SELECT
          aom.rejection_code,
          COUNT(*) as count
        FROM agent_output_materializations aom
        WHERE aom.rejection_code IS NOT NULL
          AND aom.source_tenant = $1
        GROUP BY aom.rejection_code
        ORDER BY count DESC
        `,
        [this.tenantId]
      );

      const groups: DeadLetterGroup[] = [];

      for (const row of result.rows) {
        const cause = row.rejection_code ?? 'unknown';

        // Get recent examples
        const examples = await this.pool.query<{
          id: string;
          recipient_alias: string;
          created_at: Date;
          rejection_code: string | null;
        }>(
          `
          SELECT
            aom.produced_delivery_id as id,
            aom.target_alias as recipient_alias,
            aom.created_at,
            aom.rejection_code
          FROM agent_output_materializations aom
          WHERE aom.source_tenant = $1
            AND aom.rejection_code = $2
          ORDER BY aom.created_at DESC
          LIMIT 3
          `,
          [this.tenantId, row.rejection_code]
        );

        const mappedExamples = examples.rows.map((ex) => {
          const example: {
            delivery_id: string;
            alias: string;
            created_at: string;
            rejection_code?: string;
          } = {
            delivery_id: ex.id || 'unavailable',
            alias: ex.recipient_alias || 'unknown',
            created_at: ex.created_at.toISOString(),
          };
          if (ex.rejection_code) example.rejection_code = ex.rejection_code;
          return example;
        });

        groups.push({
          cause,
          count: nonNegativeCount(row.count, 'dead_letters count'),
          recent_examples: mappedExamples,
        });
      }

      return { data: groups, available: true };
    } catch (error) {
      throw queryFailure('dead_letters', error);
    }
  }

  async salud(): Promise<HealthSummary> {
    try {
      // Count live leases
      const leaseResult = await this.pool.query<{ live: string; total: string }>(
        `
        SELECT
          COUNT(*) FILTER (WHERE lease.lease_until > now()) as live,
          COUNT(*) as total
        FROM agents agent
        LEFT JOIN connection_leases lease
          ON lease.tenant_id = agent.tenant_id AND lease.alias = agent.alias
        WHERE agent.tenant_id = $1 AND agent.enabled = true
        `,
        [this.tenantId]
      );

      // node-postgres returns bigint counts as strings; comparing them raw made
      // `live >= total` a lexicographic test ("9" >= "10") instead of a numeric one.
      const live = nonNegativeCount(leaseResult.rows[0]?.live ?? '0', 'live alias count');
      const total = nonNegativeCount(leaseResult.rows[0]?.total ?? '0', 'enabled alias count');

      // Count deliveries by status
      const deliveriesResult = await this.pool.query<{
        status: string;
        count: string;
      }>(
        `
        SELECT status, COUNT(*) as count
        FROM deliveries
        WHERE recipient_tenant = $1
        GROUP BY status
        `,
        [this.tenantId]
      );

      const deliveriesByStatus: Record<string, number> = {};
      for (const row of deliveriesResult.rows) {
        deliveriesByStatus[row.status] = nonNegativeCount(
          row.count, `delivery count for status ${row.status}`,
        );
      }

      // `acked` is not a deliveries.status value. Only terminal outcomes belong in the success
      // rate; counting pending/leased/started as failures makes a busy healthy fleet look sick.
      const done = deliveriesByStatus.done ?? 0;
      const terminalDeliveries = done
        + (deliveriesByStatus.failed ?? 0)
        + (deliveriesByStatus.dead ?? 0);
      const okRate = terminalDeliveries > 0 ? Math.round((done / terminalDeliveries) * 100) : 100;

      const status =
        total > 0 && live === total && okRate > 90
          ? 'healthy'
          : total > 0 && live >= Math.ceil(total * 0.5) && okRate > 70
            ? 'degraded'
            : 'critical';

      const summary =
        `Flota: ${String(total)} alias, ${String(live)} vivos (${status}), ${String(okRate)}% entregas OK`;

      return {
        summary,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      throw queryFailure('salud', error);
    }
  }
}

/** PostgreSQL returns bigint as text. An invalid counter degrades the tool, not its truth. */
function nonNegativeCount(value: string | number, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} is not a non-negative safe integer`);
  }
  return parsed;
}

/**
 * Wraps database query errors with context for MCP tool error reporting.
 */
function queryFailure(tool: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${tool} read model query failed: ${message}`);
}
