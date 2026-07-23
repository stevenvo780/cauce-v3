import { createContext, useContext, type ReactNode } from 'react';
import { cauceApi, type CauceApi } from './client';

const ApiContext = createContext<CauceApi>(cauceApi);

export function ApiProvider({ api, children }: { api: CauceApi; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useApi(): CauceApi {
  return useContext(ApiContext);
}
