import { createContext, createElement, useContext, type ReactNode } from 'react';
import { useApi } from './context';
import type { ConsoleAccess } from './types';
import { useResource, type Resource } from './use-resource';

const ConsoleAccessContext = createContext<Resource<ConsoleAccess> | undefined>(undefined);

/** Owns the sole console-access snapshot shared by navigation and every active view. */
export function ConsoleAccessProvider({ children }: { children?: ReactNode }) {
  const api = useApi();
  const access = useResource('console-access', () => api.getConsoleAccess());
  return createElement(ConsoleAccessContext.Provider, { value: access }, children);
}

/** Adds a local owner only for isolated renders; App already provides the shared resource. */
export function ConsoleAccessBoundary({ children }: { children: ReactNode }) {
  const shared = useContext(ConsoleAccessContext);
  return shared ? children : createElement(ConsoleAccessProvider, undefined, children);
}

export function useConsoleAccess(): Resource<ConsoleAccess> {
  const access = useContext(ConsoleAccessContext);
  if (!access) throw new Error('Console access must be read inside ConsoleAccessProvider.');
  return access;
}
