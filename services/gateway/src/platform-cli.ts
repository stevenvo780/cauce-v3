import { applyPlatformConfiguration, exportCompanyConfiguration, importCompanyConfiguration,
  lockPlatformActor, planCompanyConfigurationImport, readPlatformConfiguration, rollbackPlatformConfiguration,
  withTransaction, type CompanyTransferOptions, type DatabasePool, type PlatformActor } from '@cauce/store';
import { normalizeEmail } from './console-users.js';
import { DECOY_PASSWORD_HASH_PROMISE, verifyPassword } from './password.js';

export type PlatformCliCommand =
  | { kind: 'show' | 'export' }
  | { kind: 'change'; mutation: unknown; dryRun: boolean; expectedRevision: number }
  | { kind: 'rollback'; revision: number; dryRun: boolean; expectedRevision: number }
  | { kind: 'plan-import'; bundle: unknown; expectedRevision: number }
  | { kind: 'import'; bundle: unknown; plan: unknown; dryRun: boolean };
interface PlatformCliRequest { email: string; password: string; companyId: string; command: PlatformCliCommand }

export async function runPlatformCli(pool: DatabasePool, request: PlatformCliRequest, options: CompanyTransferOptions = {}): Promise<unknown> {
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(request.companyId)) throw new Error('acting company is required');
  return withTransaction(pool, async client => {
    const account = (await client.query<{ id: string; tenant_id: string; alias: string; password_hash: string; active: boolean }>(
      'SELECT id::text,tenant_id,alias,password_hash,active FROM console_users WHERE email_normalized=$1 FOR SHARE',
      [normalizeEmail(request.email)])).rows[0];
    const valid = await verifyPassword(account?.password_hash ?? await DECOY_PASSWORD_HASH_PROMISE, request.password);
    if (!valid || !account?.active) throw new Error('platform authentication is unavailable');
    const actor: PlatformActor = { humanId: account.id, tenant: account.tenant_id, alias: account.alias, companyId: request.companyId };
    await lockPlatformActor(client, actor);
    const bound = { ...options, transactionClient: client };
    const command = request.command;
    switch (command.kind) {
      case 'show': return readPlatformConfiguration(pool, actor, client);
      case 'change': return applyPlatformConfiguration(pool, actor, command.mutation, command.dryRun, command.expectedRevision, client);
      case 'rollback': return rollbackPlatformConfiguration(pool, actor, command.revision, command.dryRun, command.expectedRevision, client);
      case 'export': return exportCompanyConfiguration(pool, actor, client);
      case 'plan-import': return planCompanyConfigurationImport(pool, actor, command.bundle, command.expectedRevision, bound);
      case 'import': return importCompanyConfiguration(pool, actor, command.bundle, command.plan, command.dryRun, bound);
    }
  });
}
