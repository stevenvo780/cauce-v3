import { createContext, useContext } from 'react';
import type { ConsoleAuthState, ConsoleAuthorityRole } from '../../api/types';
import { sessionAuthority } from './auth-session';

export const CompanySession = createContext<ConsoleAuthState | undefined>(undefined);
export function useCompanyAuthority() { return sessionAuthority(useContext(CompanySession)); }
export const COMPANY_ROLE_LABEL: Record<ConsoleAuthorityRole, string> = {
  platform_admin: 'Administrador de plataforma', company_owner: 'Dueño de empresa', company_admin: 'Administrador de empresa',
  tenant_operator: 'Operador', reader: 'Lector', none: 'Sin permiso',
};
export function canManageCompany(role: ConsoleAuthorityRole | undefined): boolean {
  return role === 'company_owner' || role === 'company_admin' || role === 'platform_admin';
}
