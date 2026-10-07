import { useMemo, useSyncExternalStore } from 'react';
import { useRouteSegments } from '../router';

/* Memory only: the repository forbids browser storage, so a reload starts at the launcher. */
let lastChat: string | undefined;
const listeners = new Set<() => void>();

export const CHAT_LAUNCHER_PATH = '/messages';

export function lastChatPath(): string | undefined {
  return lastChat;
}

export function rememberChat(path: string | undefined): void {
  if (path === lastChat) return;
  lastChat = path;
  for (const listener of listeners) listener();
}

export function subscribeLastChat(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useLastChat(): string | undefined {
  return useSyncExternalStore(subscribeLastChat, lastChatPath, () => undefined);
}

/** The Chat entry resumes the last conversation; from inside that conversation it opens the launcher. */
export function chatNavTarget(last: string | undefined, currentPath: string): string {
  if (!last || last === currentPath) return CHAT_LAUNCHER_PATH;
  return last;
}

export function useChatNavTarget(): string {
  const last = useLastChat();
  const segments = useRouteSegments();
  const current = useMemo(() => `/${segments.map(encodeURIComponent).join('/')}`, [segments]);
  return chatNavTarget(last, current);
}
