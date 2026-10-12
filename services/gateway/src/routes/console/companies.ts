import { z } from 'zod';
import { CompanyRegistrationSchema, INVALID_REGISTRATION, registerCompanyWithOwner } from '../../company-registration.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  COMPANY_ID_PATTERN, StoreError, assertPlatformAdmin, updateCompany, withTransaction,
  type CompanyAuthority, type DatabaseClient, type DatabasePool,
} from '@cauce/store';
import { AuthError, AuthorizationError, type AuthProvider } from '../../auth.js';
import { consoleHumanAccess } from '../../console-human-authority.js';
import { replyError } from '../shared.js';

const CompanyParams = z.object({ company_id: z.string().regex(COMPANY_ID_PATTERN) }).strict();
const CompanyUpdate = z.object({ expected_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  name: z.string().trim().min(1).max(80).optional(), state: z.enum(['enabled','disabled','retired']).optional() }).strict()
  .refine(value => value.name !== undefined || value.state !== undefined);
const CompanyVersion = z.object({ expected_version: z.string().regex(/^[1-9][0-9]{0,15}$/u).transform(Number)
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)) }).strict();

const EVENT_QUERY_KEYS = new Set(['limit', 'before', 'company']);
const EVENT_LIMIT = /^[1-9][0-9]{0,2}$/u;
const EVENT_CURSOR = /^[1-9][0-9]{0,17}$/u;

interface EventQuery { readonly limit: number; readonly before: string | null; readonly company: string | null }

function eventQuery(value: unknown): EventQuery {
  const query = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const { limit, before, company } = query;
  if (Object.keys(query).some((key) => !EVENT_QUERY_KEYS.has(key))
    || (limit !== undefined && (typeof limit !== 'string' || !EVENT_LIMIT.test(limit) || Number(limit) > 200))
    || (before !== undefined && (typeof before !== 'string' || !EVENT_CURSOR.test(before)))
    || (company !== undefined && (typeof company !== 'string' || !COMPANY_ID_PATTERN.test(company)))) {
    throw new StoreError('invalid_input', 'platform event query is invalid');
  }
  return { limit: limit === undefined ? 50 : Number(limit), before: before ?? null, company: company ?? null };
}

async function withCompanyAuthority<T>(
  provider: AuthProvider, pool: DatabasePool, request: FastifyRequest, reply: FastifyReply,
  work: (client: DatabaseClient, authority: CompanyAuthority) => Promise<T>,
): Promise<T> {
  const access = await consoleHumanAccess(provider, request, reply, 'read');
  if (access === undefined) throw new AuthorizationError('a console session is required');
  try {
    return await withTransaction(pool, async (client) => work(client, await access.companyAuthority(client)));
  } finally { access.close(); }
}

function failed(reply: FastifyReply, error: unknown): void {
  if (error instanceof z.ZodError) { void reply.code(400).send({ error: 'invalid_request', message: 'invalid company request' }); return; }
  if (!(error instanceof AuthError || error instanceof AuthorizationError || error instanceof StoreError)) throw error;
  replyError(reply, error);
}

/** The platform sees every company and platform event; owners and administrators only those touching their company. */
export function registerCompanyRoutes(app: FastifyInstance, provider: AuthProvider, pool: DatabasePool): void {
  app.get('/v3/console/companies', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      return await withCompanyAuthority(provider, pool, request, reply, async (client, authority) => {
        if (authority.role === 'none') throw new AuthorizationError();
        const companies = await client.query<{ id: string; name: string; state: string; version: number }>(
          `SELECT id,name,CASE WHEN retired_at IS NOT NULL THEN 'retired' WHEN enabled THEN 'enabled' ELSE 'disabled' END AS state,version::float8 AS version
           FROM companies WHERE $1::boolean OR id=$2 ORDER BY id`,
          [authority.role === 'platform_admin', authority.homeCompany]);
        return { home_company: authority.homeCompany, acting_company: authority.actingCompany, role: authority.role,
          scope: authority.scope, platform_override: authority.platformOverride, companies: companies.rows };
      });
    } catch (error) { failed(reply, error); }
  });

  app.post('/v3/console/companies', { bodyLimit: 8192 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const creator = await withCompanyAuthority(provider, pool, request, reply, async (_client, authority) => {
        assertPlatformAdmin(authority);
        return authority.humanId;
      });
      const input = CompanyRegistrationSchema.safeParse(request.body);
      if (!input.success) return await reply.code(400).send(INVALID_REGISTRATION);
      if (await registerCompanyWithOwner(pool, input.data, reply)) {
        request.log.info({ event: 'company_created', company_id: input.data.company.slug, actor_human_id: creator }, 'platform created a company');
      }
    } catch (error) { failed(reply, error); }
  });

  app.get('/v3/console/companies/:company_id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { company_id } = CompanyParams.parse(request.params);
      return await withCompanyAuthority(provider, pool, request, reply, async (client, authority) => {
        if (authority.role === 'none' || (authority.role !== 'platform_admin' && company_id !== authority.actingCompany)) {
          throw new AuthorizationError();
        }
        const row = (await client.query<{ id: string; name: string; version: number; state: string }>(`SELECT id,name,version::float8 AS version,
          CASE WHEN retired_at IS NOT NULL THEN 'retired' WHEN enabled THEN 'enabled' ELSE 'disabled' END AS state
          FROM companies WHERE id=$1`, [company_id])).rows[0];
        if (!row) throw new StoreError('not_found', 'company is unavailable');
        return row;
      });
    } catch (error) { failed(reply, error); }
  });

  app.patch('/v3/console/companies/:company_id', { bodyLimit: 4096 }, async (request, reply) => {
    try {
      const { company_id } = CompanyParams.parse(request.params); const input = CompanyUpdate.parse(request.body);
      return await withCompanyAuthority(provider, pool, request, reply,
        (client, authority) => updateCompany(client, authority, company_id, input));
    } catch (error) { failed(reply, error); }
  });

  app.delete('/v3/console/companies/:company_id', async (request, reply) => {
    try {
      const { company_id } = CompanyParams.parse(request.params); const input = CompanyVersion.parse(request.query);
      const company = await withCompanyAuthority(provider, pool, request, reply,
        (client, authority) => updateCompany(client, authority, company_id, { ...input, state: 'retired' }));
      return { ...company, deletion: 'retired', data_preserved: true };
    } catch (error) { failed(reply, error); }
  });

  app.get('/v3/console/platform/events', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const query = eventQuery(request.query);
      return await withCompanyAuthority(provider, pool, request, reply, async (client, authority) => {
        let company = query.company;
        if (authority.role !== 'company_owner' && authority.role !== 'company_admin') assertPlatformAdmin(authority);
        else if (company !== null && company !== authority.actingCompany) throw new AuthorizationError();
        else company = authority.actingCompany;
        const events = await client.query<Record<string, unknown> & { id: string }>(
          `SELECT id::text,action,company_id,peer_company_id,subject_human_id::text,actor_human_id::text,database_role,metadata,created_at
           FROM platform_authority_events
           WHERE ($1::text IS NULL OR company_id=$1 OR peer_company_id=$1) AND ($2::bigint IS NULL OR id<$2::bigint)
           ORDER BY id DESC LIMIT $3`, [company, query.before, query.limit]);
        return { items: events.rows,
          next_cursor: events.rows.length === query.limit ? events.rows.at(-1)?.id ?? null : null };
      });
    } catch (error) { failed(reply, error); }
  });
}
