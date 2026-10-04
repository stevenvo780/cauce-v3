import { useCallback, useSyncExternalStore } from 'react';
import { useConsoleAccess } from '../../api/console-access';
import { useApi } from '../../api/context';
import type { CauceApi } from '../../api/client';
import type { AgentDocumentKind } from '../../api/types';
import type { BorradorDeFichero } from './FicherosTab';
import type { ProfileDraft, ProfileOutcome, ProfileSettlement } from './profile-draft';

interface EditorState {
  profile?: ProfileDraft;
  files: Partial<Record<AgentDocumentKind, BorradorDeFichero>>;
  busy: boolean;
  revision: number;
  outcome?: ProfileOutcome;
}
interface EditorStore { state: EditorState; listeners: Set<() => void> }
const stores = new WeakMap<CauceApi, Map<string, EditorStore>>();

function storeFor(api: CauceApi, key: string): EditorStore {
  let registry = stores.get(api);
  if (!registry) { registry = new Map(); stores.set(api, registry); }
  let store = registry.get(key);
  if (!store) {
    store = { state: { files: {}, busy: false, revision: 0 }, listeners: new Set() };
    registry.set(key, store);
  }
  return store;
}

export function useContextEditorStore(tenantId: string, alias: string) {
  const api = useApi();
  const access = useConsoleAccess();
  const humanSubject = access.data?.human_subject;
  const subject = typeof humanSubject === 'string' && /^human:[a-f0-9]{64}$/u.test(humanSubject)
    ? humanSubject : access.data?.subject;
  const identity = JSON.stringify([subject, tenantId, alias]);
  const store = storeFor(api, identity);
  const subscribe = useCallback((listener: () => void) => {
    store.listeners.add(listener);
    return () => { store.listeners.delete(listener); };
  }, [store]);
  const state = useSyncExternalStore(subscribe, () => store.state);
  const update = useCallback((change: Partial<EditorState>) => {
    store.state = { ...store.state, ...change };
    for (const listener of store.listeners) listener();
  }, [store]);
  const settle = (result: ProfileSettlement) => {
    if (store.state.profile !== result.expectedDraft) return;
    update({ profile: result.draft, outcome: result.outcome });
  };
  const documentDraft = (kind: AgentDocumentKind, draft: BorradorDeFichero | undefined) => {
    if (draft === undefined) {
      const files = Object.fromEntries(Object.entries(store.state.files).filter(([key]) => key !== kind));
      update({ files });
    } else {
      update({ files: { ...store.state.files, [kind]: draft } });
    }
  };
  const refresh = () => { update({ revision: store.state.revision + 1 }); };
  return { identity, state, update, settle, documentDraft, refresh };
}
