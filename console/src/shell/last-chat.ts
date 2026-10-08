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

function selectedAgentPath(path: string | undefined, view: 'messages' | 'terminal'): string | undefined {
  if (!path) return undefined;
  const [leading, section, tenant, alias, ...extra] = path.split('/');
  if (leading !== '' || (section !== 'messages' && section !== 'terminal') || !tenant || !alias || extra.length) return undefined;
  try {
    return `/${view}/${encodeURIComponent(decodeURIComponent(tenant))}/${encodeURIComponent(decodeURIComponent(alias))}`;
  } catch {
    return undefined;
  }
}

/** An explicit agent route wins over memory; Chat inside a conversation opens its launcher. */
export function chatNavTarget(last: string | undefined, currentPath: string): string {
  const current = selectedAgentPath(currentPath, 'messages');
  if (current && currentPath.startsWith('/messages/')) return CHAT_LAUNCHER_PATH;
  return current ?? selectedAgentPath(last, 'messages') ?? CHAT_LAUNCHER_PATH;
}

export function terminalNavTarget(last: string | undefined, currentPath: string): string {
  return selectedAgentPath(currentPath, 'terminal') ?? selectedAgentPath(last, 'terminal') ?? '/terminal';
}

function useAgentNavTarget(view: 'messages' | 'terminal'): string {
  const last = useLastChat();
  const segments = useRouteSegments();
  const current = useMemo(() => `/${segments.map(encodeURIComponent).join('/')}`, [segments]);
  return view === 'messages' ? chatNavTarget(last, current) : terminalNavTarget(last, current);
}

export function useChatNavTarget(): string {
  return useAgentNavTarget('messages');
}

export function useTerminalNavTarget(): string {
  return useAgentNavTarget('terminal');
}
