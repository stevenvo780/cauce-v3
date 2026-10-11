import type { ConsoleAuthState } from '../../api/types';
import { sessionAuthority } from './auth-session';

export function humanProfileName(state: ConsoleAuthState | undefined): string {
  const name = state?.name?.trim();
  return name === undefined || name.length === 0 ? 'Persona autenticada' : name;
}

/** A company switch or a change of company role remounts everything scoped to the session. */
export function authSessionKey(state: ConsoleAuthState | undefined): string {
  const authority = sessionAuthority(state);
  return JSON.stringify([
    state?.authenticated, state?.login_mode, state?.subject,
    state?.csrf_token, state?.roles, state?.permissions, state?.home_tenant,
    authority?.role, authority?.scope, authority?.acting_company,
  ]);
}
