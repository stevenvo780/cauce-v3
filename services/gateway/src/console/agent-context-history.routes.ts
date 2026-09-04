import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AliasSchema, TenantSchema } from '@cauce/protocol';
import { isJournalCursor } from '@cauce/store';
import type { DocumentKind } from './agent-documents.js';

/**
 * Read side of the context journal (migration 041): what the profile of an alias said in each
 * version, and which governance file was rewritten for it. Read-only and permission `read`: the
 * restore itself is not here, it is the canonical profile PUT replaying one of these snapshots
 * with its own CAS and its own governed batch.
 */

/** One past version of the seven authored fields, whole: a restore replays all seven or none. */
export interface ProfileRevisionView {
  readonly id: string;
  readonly tenant_id: string;
  readonly alias: string;
  readonly revision: number;
  readonly operation: 'insert' | 'update' | 'delete';
  readonly purpose: string | null;
  readonly role_summary: string | null;
  readonly human_brief: string | null;
  readonly responsibilities: readonly string[];
  readonly restrictions: readonly string[];
  readonly tools: readonly string[];
  readonly operating_rules: readonly string[];
  /** NULL means "not recorded", never "nobody". */
  readonly actor_tenant: string | null;
  readonly actor_alias: string | null;
  readonly changed_at: string;
}

/** A governance write by fingerprint. No field of this shape can carry a body. */
export interface DocumentRevisionView {
  readonly id: string;
  readonly tenant_id: string;
  readonly alias: string;
  readonly kind: string;
  readonly path: string;
  readonly sha256: string | null;
  readonly bytes: number;
  readonly actor_tenant: string | null;
  readonly actor_alias: string | null;
  readonly written_at: string;
}

/**
 * One stretch of a journal. `next_cursor` is a string only when a row OLDER than this page exists;
 * `null` is the end of the diary, and the console stops walking on it.
 */
export interface RevisionPage<Entry> {
  readonly entries: readonly Entry[];
  readonly next_cursor: string | null;
}

export interface AgentContextHistoryDeps {
  /** Authenticates the principal and requires the role permission for the operation. */
  authorize(
    request: unknown, permission: 'read',
  ): Promise<{ tenant_id: string; alias: string }>;
  /** Exact lookup and authorization; `undefined` never reveals whether the alias exists. */
  authorizeTarget(
    actor: { tenant_id: string; alias: string },
    targetTenantId: string,
    targetAlias: string,
    permission: 'read',
    legacySameTenant: boolean,
  ): Promise<{ tenant_id: string; alias: string; enabled?: boolean } | undefined>;
  listProfileRevisions(
    tenantId: string, alias: string, limit: number, cursor?: string,
  ): Promise<RevisionPage<ProfileRevisionView>>;
  listDocumentRevisions(
    tenantId: string, alias: string, kind: string, limit: number, cursor?: string,
  ): Promise<RevisionPage<DocumentRevisionView>>;
}

const DEFAULT_PAGE = 100;
const MAX_PAGE = 200;

/**
 * Exhaustive in both directions: a kind added to the catalog leaves this record missing a key and
 * the compiler says so, instead of the route silently serving an empty journal for it.
 */
const KIND_VOCABULARY: Readonly<Record<DocumentKind, true>> = {
  directive: true, tools: true, prompts: true, mcp: true, identity: true, human: true,
  memory: true, heartbeat: true, configuration: true,
};

function pageSize(raw: unknown): number | undefined {
  if (raw === undefined) return DEFAULT_PAGE;
  if (typeof raw !== 'string' || !/^[0-9]{1,4}$/u.test(raw)) return undefined;
  const parsed = Number(raw);
  return parsed >= 1 && parsed <= MAX_PAGE ? parsed : undefined;
}

interface HistoryParams { tenantId: string; alias: string }
interface DocumentHistoryParams extends HistoryParams { kind: string }

export function registerAgentContextHistoryRoutes(
  app: FastifyInstance, deps: AgentContextHistoryDeps,
): void {
  /** Resolves identity, permission and page size, or answers and returns `undefined`. */
  async function destino(
    request: FastifyRequest<{ Params: HistoryParams; Querystring: Record<string, unknown> }>,
    reply: FastifyReply,
  ): Promise<{
    tenant_id: string; alias: string; limit: number; cursor: string | undefined;
  } | undefined> {
    const tenant = TenantSchema.safeParse(request.params.tenantId);
    const alias = AliasSchema.safeParse(request.params.alias);
    if (!tenant.success || !alias.success) {
      await reply.code(400).send({ error: 'invalid_input', message: 'tenantId or alias is invalid' });
      return undefined;
    }
    const limit = pageSize(request.query.limit);
    if (limit === undefined) {
      await reply.code(400).send({
        error: 'invalid_input', message: `limit tiene que ser un entero entre 1 y ${String(MAX_PAGE)}`,
      });
      return undefined;
    }
    const raw = request.query.cursor;
    let cursor: string | undefined;
    if (raw !== undefined) {
      if (!isJournalCursor(raw)) {
        await reply.code(400).send({
          error: 'invalid_input',
          message: 'cursor tiene que ser el identificador de una fila del diario',
        });
        return undefined;
      }
      cursor = raw;
    }
    const actor = await deps.authorize(request, 'read');
    const target = await deps.authorizeTarget(actor, tenant.data, alias.data, 'read', false);
    if (target?.tenant_id !== tenant.data || target.alias !== alias.data) {
      await reply.code(404).send({ error: 'not_found', message: 'agent not found or not visible' });
      return undefined;
    }
    /*
     * `enabled` is deliberately not checked: the journal exists to outlive the runtime it
     * describes, and hiding the past of a switched-off alias would hide exactly the version
     * somebody needs to read back when deciding whether to switch it on again.
     */
    return { tenant_id: target.tenant_id, alias: target.alias, limit, cursor };
  }

  app.get<{ Params: HistoryParams; Querystring: Record<string, unknown> }>(
    '/v3/console/tenants/:tenantId/agents/:alias/perfil/revisions',
    async (request, reply) => {
      const resuelto = await destino(request, reply);
      if (resuelto === undefined) return undefined;
      const page = await deps.listProfileRevisions(
        resuelto.tenant_id, resuelto.alias, resuelto.limit, resuelto.cursor,
      );
      return {
        observed_at: new Date().toISOString(),
        tenant_id: resuelto.tenant_id,
        alias: resuelto.alias,
        entries: page.entries,
        next_cursor: page.next_cursor,
      };
    },
  );

  app.get<{ Params: DocumentHistoryParams; Querystring: Record<string, unknown> }>(
    '/v3/console/tenants/:tenantId/agents/:alias/documents/:kind/revisions',
    async (request, reply) => {
      const { kind } = request.params;
      if (!Object.prototype.hasOwnProperty.call(KIND_VOCABULARY, kind)) {
        return reply.code(400).send({
          error: 'invalid_input', message: 'ese tipo de documento no existe',
        });
      }
      const resuelto = await destino(request, reply);
      if (resuelto === undefined) return undefined;
      const page = await deps.listDocumentRevisions(
        resuelto.tenant_id, resuelto.alias, kind, resuelto.limit, resuelto.cursor,
      );
      return {
        observed_at: new Date().toISOString(),
        tenant_id: resuelto.tenant_id,
        alias: resuelto.alias,
        kind,
        entries: page.entries,
        next_cursor: page.next_cursor,
      };
    },
  );
}
