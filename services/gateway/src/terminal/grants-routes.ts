import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  StoreError, createTerminalGrant, listTerminalGrants, revokeTerminalGrant, updateTerminalGrant,
  withTransaction, type CompanyAuthority, type DatabaseClient, type DatabasePool,
} from '@cauce/store';
import { AuthError, AuthorizationError, type AuthProvider } from '../auth.js';
import { consoleHumanAccess } from '../console-human-authority.js';
import { replyError } from '../routes/shared.js';

const GrantIdParams = z.object({ id: z.uuid() }).strict();
const GrantCreate = z.object({
  tenant_id: z.string().min(1).max(128),
  alias: z.string().min(1).max(64),
  grantee_human_id: z.uuid(),
  modes: z.array(z.enum(['shell', 'harness', 'harness_rw'])).min(1).max(3),
  expires_at: z.iso.datetime({ offset: true }).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
}).strict();
const GrantUpdate = z.object({
  expected_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  modes: z.array(z.enum(['shell', 'harness', 'harness_rw'])).min(1).max(3).optional(),
  expires_at: z.iso.datetime({ offset: true }).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
}).strict().refine((value) => value.modes !== undefined || value.expires_at !== undefined || value.note !== undefined);
const GrantVersionQuery = z.object({
  expected_version: z.string().regex(/^[1-9][0-9]{0,15}$/u).transform(Number)
    .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)),
}).strict();

function failed(reply: FastifyReply, error: unknown): void {
  if (error instanceof z.ZodError) {
    void reply.code(400).send({ error: 'invalid_request', message: 'invalid terminal grant request' });
    return;
  }
  if (!(error instanceof AuthError || error instanceof AuthorizationError || error instanceof StoreError)) throw error;
  replyError(reply, error);
}

async function withGrantAuthority<T>(
  provider: AuthProvider, pool: DatabasePool, request: FastifyRequest, reply: FastifyReply,
  work: (client: DatabaseClient, authority: CompanyAuthority) => Promise<T>,
): Promise<T> {
  const access = await consoleHumanAccess(provider, request, reply, 'read');
  if (access === undefined) throw new AuthorizationError('a console session is required');
  try {
    return await withTransaction(pool, async (client) => work(client, await access.companyAuthority(client)));
  } finally { access.close(); }
}

/**
 * Console administration of `terminal_grants`. Only the owner or an admin of the agent's
 * company grants over its agents; the platform admin grants over any company. A grant of
 * another company answers as unavailable, never as data.
 */
export function registerTerminalGrantRoutes(
  app: FastifyInstance, options: { pool: DatabasePool; authProvider: AuthProvider },
): void {
  const { pool, authProvider } = options;

  app.get('/v3/console/terminal/grants', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const result = await withGrantAuthority(authProvider, pool, request, reply,
        (client, authority) => listTerminalGrants(client, authority));
      return { ...result, capabilities: { create: true, update: true, revoke: true } };
    } catch (error) { failed(reply, error); }
  });

  app.post('/v3/console/terminal/grants', { bodyLimit: 4096 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const input = GrantCreate.parse(request.body);
      const grant = await withGrantAuthority(authProvider, pool, request, reply,
        (client, authority) => createTerminalGrant(client, authority, input));
      return await reply.code(201).send(grant);
    } catch (error) { failed(reply, error); }
  });

  app.patch('/v3/console/terminal/grants/:id', { bodyLimit: 4096 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { id } = GrantIdParams.parse(request.params);
      const input = GrantUpdate.parse(request.body);
      return await withGrantAuthority(authProvider, pool, request, reply,
        (client, authority) => updateTerminalGrant(client, authority, id, input));
    } catch (error) { failed(reply, error); }
  });

  app.delete('/v3/console/terminal/grants/:id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { id } = GrantIdParams.parse(request.params);
      const { expected_version } = GrantVersionQuery.parse(request.query);
      return await withGrantAuthority(authProvider, pool, request, reply,
        (client, authority) => revokeTerminalGrant(client, authority, id, expected_version));
    } catch (error) { failed(reply, error); }
  });
}
