import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { COMPANY_ID_PATTERN, CompanyPurgeBlockedError, StoreError, purgeCompany, withAbortableTransaction, type DatabasePool } from '@cauce/store';
import { AuthError, AuthorizationError, type AuthProvider } from '../auth.js';
import { consoleHumanAccess } from '../console-human-authority.js';
import { prepareSpaceBackupDirectory } from '../fleet/space-backup.files.js';
import { PasswordAuthProvider } from '../password-auth.js';
import { replyError } from '../routes/shared.js';

const CompanyParams = z.object({ company_id: z.string().regex(COMPANY_ID_PATTERN) }).strict();
const PurgeInput = z.object({ confirmation: z.string().regex(COMPANY_ID_PATTERN) }).strict();

async function saveCompanyBackup(company: string, serializedSnapshot: string): Promise<string> {
  const directory = process.env.CAUCE_SPACE_BACKUP_DIRECTORY === undefined
    ? '/var/lib/cauce-v3/company-backups' : join(process.env.CAUCE_SPACE_BACKUP_DIRECTORY, 'companies');
  await prepareSpaceBackupDirectory({ directory, projectRoot: process.cwd() });
  const path = join(directory, `${company}-${randomUUID()}.json`);
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(serializedSnapshot, 'utf8');
    await file.sync();
  } finally { await file.close(); }
  for (let current = directory; ; current = dirname(current)) {
    const parent = await open(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
    if (current === dirname(current)) break;
  }
  return path;
}

export function registerCompanyPurgeRoutes(app: FastifyInstance, provider: AuthProvider, pool: DatabasePool): void {
  app.post('/v3/console/companies/:company_id/purge', { bodyLimit: 4096 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      if (provider instanceof PasswordAuthProvider) await provider.requireCsrf(request);
      const { company_id } = CompanyParams.parse(request.params);
      const input = PurgeInput.parse(request.body);
      const access = await consoleHumanAccess(provider, request, reply, 'read');
      if (!access) throw new AuthorizationError('a console session is required');
      try {
        const receipt = await withAbortableTransaction(pool, access.options.signal, async client => purgeCompany(client,
          await access.companyAuthority(client), company_id, input, (_snapshot, serialized) => saveCompanyBackup(company_id, serialized)));
        request.log.info({ event: 'company_purged', company_id }, 'platform purged a retired company');
        return receipt;
      } finally { access.close(); }
    } catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_request', message: 'Escribe el identificador de la empresa para confirmar la purga.' });
      if (error instanceof CompanyPurgeBlockedError) return reply.code(409).send({
        error: 'company_purge_blocked', blockers: error.blockers,
        message: `Primero purga los recursos desde Flota o resuelve las referencias de otra empresa: ${error.blockers.map(item => `${item.kind}: ${item.id}`).join(', ')}.`,
      });
      if (error instanceof StoreError || error instanceof AuthError || error instanceof AuthorizationError) { replyError(reply, error); return; }
      return reply.code(503).send({ error: 'company_purge_unavailable', message: 'No se pudo guardar la copia o completar la purga. Relee la empresa antes de reintentar.' });
    }
  });
}
