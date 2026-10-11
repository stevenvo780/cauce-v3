import type { ReactNode } from 'react';
import type { ConsoleAuthState } from '../../api/types';
import { CompanySession } from './company-authority';

export function CompanySessionProvider({ state, children }: { state?: ConsoleAuthState; children: ReactNode }) {
  return <CompanySession.Provider value={state}>{children}</CompanySession.Provider>;
}
