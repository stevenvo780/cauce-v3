import type { ConsoleAuthState } from '../../api/types';
import { canManageCompany } from '../auth/company-authority';
import { sessionAuthority } from '../auth/auth-session';

export function canBackupSpace(state: ConsoleAuthState | undefined, tenant: string): boolean {
  const authority = sessionAuthority(state);
  return !!authority && (canManageCompany(authority.role)
    || authority.role === 'tenant_operator' && authority.scope === 'tenant' && state?.home_tenant === tenant);
}
