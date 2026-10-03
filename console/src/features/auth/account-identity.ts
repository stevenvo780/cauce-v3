import type { ConsoleAuthState } from '../../api/types';

export function humanProfileName(state: ConsoleAuthState | undefined): string {
  const name = state?.name?.trim();
  return name === undefined || name.length === 0 ? 'Persona autenticada' : name;
}

export function authSessionKey(state: ConsoleAuthState | undefined): string {
  return JSON.stringify([
    state?.authenticated, state?.login_mode, state?.subject,
    state?.csrf_token, state?.roles, state?.permissions,
  ]);
}
