import type { Permission, Tenant } from '@cauce/protocol';
import type { DatabasePool } from '../db.js';

export abstract class BaseRepository {
  constructor(protected readonly pool: DatabasePool) {}

  protected abstract assertPermission(
    tenantId: Tenant,
    alias: string,
    permission: Permission
  ): Promise<void>;
}
