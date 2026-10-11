import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { COMPANY_ID_PATTERN, StoreError, setCompanyAdmin, withTransaction, type DatabasePool } from '@cauce/store';
import { AuthError, AuthorizationError, type AuthProvider } from '../../auth.js';
import { consoleHumanAccess } from '../../console-human-authority.js';
import { replyError } from '../shared.js';

const Params = z.object({ company_id:z.string().regex(COMPANY_ID_PATTERN) }).strict();
const Update = z.object({ user_id:z.uuid(),role:z.enum(['owner','admin']).nullable(),
  expected_version:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();
export function registerCompanyAdminRoutes(app: FastifyInstance,provider: AuthProvider,pool: DatabasePool): void {
  const handler = async (request: FastifyRequest,reply: FastifyReply) => {
    reply.header('Cache-Control','no-store');
    try {
      const { company_id } = Params.parse(request.params);
      const access = await consoleHumanAccess(provider,request,reply,'read');
      if (!access) throw new AuthorizationError('a console session is required');
      try {
        return await withTransaction(pool,async client => {
          const authority = await access.companyAuthority(client);
          const platform = authority.role==='platform_admin'; const owner = authority.role==='company_owner';
          if ((!platform && company_id!==authority.actingCompany) || (!platform && !owner && authority.role!=='company_admin')) {
            throw new AuthorizationError();
          }
          if (request.method==='PUT') return setCompanyAdmin(client,authority,company_id,Update.parse(request.body));
          const rows = await client.query<{ user_id:string; email:string; display_name:string; role:string; version:number }>(
            `SELECT admin.human_id::text AS user_id,person.email,person.display_name,admin.role,admin.version::float8 AS version
             FROM company_admins admin JOIN console_users person ON person.id=admin.human_id
             WHERE admin.company_id=$1 ORDER BY person.display_name,admin.human_id`,[company_id]);
          return { company_id,items:rows.rows,capabilities:{grant_admin:platform||owner,grant_owner:platform,revoke:platform||owner} };
        });
      } finally { access.close(); }
    } catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({error:'invalid_request',message:'invalid company administrator request'});
      if (error instanceof StoreError || error instanceof AuthError || error instanceof AuthorizationError) {replyError(reply,error);return;}
      throw error;
    }
  };
  app.get('/v3/console/companies/:company_id/admins',handler);
  app.put('/v3/console/companies/:company_id/admins',{bodyLimit:4096},handler);
}
