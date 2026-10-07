import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../../api/context';
import { useOptionalConsoleAccess } from '../../api/console-access';
import type { MessagePage, PublishIntentSemantics } from '../../api/types';
import { compactId, permissionState } from '../../lib';
import { useFleet } from '../../shell/fleet-context';
import { publishDurably } from '../messages/durable-publish';
import type { AgenteDeMensajeria } from '../messages/roster';
import { fleetAgentId } from '../terminal/fleet';
import { operatorRouteForAgent, transcriptForSession } from '../terminal/session';
import type { Speech } from './speech';

/** A reply stays over the head this long. */
export const SAY_MS = 8_000;
/** Without news from the feed, the «…» gives up after this long. */
export const THINK_MS = 120_000;
const SETTLED = new Set(['done', 'failed', 'dead']);

export interface DialogLine { id: string; who: string; mine: boolean; text: string }
export type SendStatus = { tone: 'sending' | 'sent' | 'failed'; text: string } | null;

export interface OfficeDialogModel {
  id: string;
  tenantId: string;
  alias: string;
  lines: DialogLine[];
  /** Why the operator cannot write from here; the chat link stays as the way out. */
  blocked?: string;
  chatHref: string;
  draft: string;
  status: SendStatus;
  thinking: boolean;
  setDraft: (text: string) => void;
  send: () => void;
}

interface Pending { since: number; messageId?: string; seen: ReadonlySet<string> }

const splitId = (id: string) => {
  const cut = id.indexOf('/');
  return { tenantId: id.slice(0, cut), alias: id.slice(cut + 1) };
};

function preview(text: string | null | undefined, fallback: string): string {
  const trimmed = text?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : fallback;
}

function outputsOf(page: MessagePage | undefined, agent: AgenteDeMensajeria) {
  return transcriptForSession(page, { agent }).filter((item) => item.direction === 'output' && item.message.message_id);
}

/** Last lines of a thread as the dialog box shows them. */
export function dialogLines(page: MessagePage | undefined, agent: AgenteDeMensajeria, me: string | null | undefined, count = 3): DialogLine[] {
  return transcriptForSession(page, { agent }).slice(-count).map((item, index) => {
    const author = item.message.author;
    const mine = Boolean(me && author?.kind === 'human' && author.subject_id === me);
    const who = item.direction === 'output' ? agent.alias : mine ? 'Vos' : author?.display_name ?? item.message.actor_alias ?? 'Alguien';
    return { id: item.message.message_id ?? `linea-${String(index)}`, who, mine, text: preview(item.message.body_preview, '(sin texto)') };
  });
}

/**
 * The office's way of talking to an agent. Publishing is the chat's own durable path
 * (`publishDurably`, same room resolution and permission), never a copy of it.
 */
export function useOfficeChat(talkId: string | null): { dialog: OfficeDialogModel | null; speech: ReadonlyMap<string, Speech> } {
  const fleet = useFleet();
  const api = useApi();
  const access = useOptionalConsoleAccess();
  const verified = access?.error ? undefined : access?.data;
  const topology = fleet.topology.error ? undefined : fleet.topology.data;
  const page = fleet.messages.data;
  const reloadMessages = fleet.messages.reload;
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(new Map());
  const [status, setStatus] = useState<{ id: string; value: SendStatus } | null>(null);
  const [pending, setPending] = useState<ReadonlyMap<string, Pending>>(new Map());
  const [said, setSaid] = useState<ReadonlyMap<string, { text: string; until: number }>>(new Map());
  const [now, setNow] = useState(() => Date.now());
  const busy = useRef(new Set<string>());

  const agentOf = useCallback((id: string) => {
    const { tenantId, alias } = splitId(id);
    return fleet.agents.find((agent) => agent.id === fleetAgentId(tenantId, alias));
  }, [fleet.agents]);

  useEffect(() => {
    if (pending.size === 0) return;
    const replies = new Map<string, string>();
    const done = new Set<string>();
    for (const [id, wait] of pending) {
      const agent = agentOf(id);
      if (!agent) continue;
      const fresh = outputsOf(page, agent).filter((item) => !wait.seen.has(item.message.message_id ?? ''));
      const last = fresh.at(-1);
      if (last) replies.set(id, preview(last.message.body_preview, '…'));
      const mine = wait.messageId ? transcriptForSession(page, { agent }).find((item) => item.message.message_id === wait.messageId) : undefined;
      if (last || SETTLED.has(mine?.delivery?.status ?? '')) done.add(id);
    }
    if (done.size === 0) return;
    const at = Date.now();
    setPending((current) => new Map([...current].filter(([id]) => !done.has(id))));
    if (replies.size > 0) setSaid((current) => new Map([...current, ...[...replies].map(([id, text]) => [id, { text, until: at + SAY_MS }] as const)]));
  }, [page, pending, agentOf]);

  const ticking = pending.size > 0 || said.size > 0;
  useEffect(() => {
    if (!ticking) return undefined;
    const timer = window.setInterval(() => {
      const at = Date.now();
      setNow(at);
      setSaid((current) => ([...current.values()].some((entry) => entry.until <= at) ? new Map([...current].filter(([, entry]) => entry.until > at)) : current));
      setPending((current) => ([...current.values()].some((entry) => at - entry.since > THINK_MS) ? new Map([...current].filter(([, entry]) => at - entry.since <= THINK_MS)) : current));
    }, 1000);
    return () => { window.clearInterval(timer); };
  }, [ticking]);

  const speech = useMemo(() => {
    const map = new Map<string, Speech>();
    for (const [id, entry] of said) if (entry.until > now) map.set(id, { kind: 'say', text: entry.text });
    for (const id of pending.keys()) if (!map.has(id)) map.set(id, { kind: 'thinking' });
    return map;
  }, [said, pending, now]);

  const agent = talkId ? agentOf(talkId) : undefined;
  const route = useMemo(() => (agent ? operatorRouteForAgent(topology, verified, agent) : undefined), [agent, topology, verified]);

  const send = useCallback(() => {
    if (!talkId || !agent || !route) return;
    const snapshot = drafts.get(talkId) ?? '';
    const text = snapshot.trim();
    const roomId = route.sourceRoomIds.length === 1 ? route.sourceRoomIds[0] : '';
    if (!text || !roomId || busy.current.has(talkId)) return;
    busy.current.add(talkId);
    const id = talkId;
    const seen = new Set(outputsOf(page, agent).map((item) => item.message.message_id ?? ''));
    setStatus({ id, value: { tone: 'sending', text: 'Enviando…' } });
    setPending((current) => new Map(current).set(id, { since: Date.now(), seen }));
    const input: PublishIntentSemantics = {
      room_id: roomId,
      recipients: [{ tenant_id: agent.tenantId, alias: agent.alias }],
      body: { text },
      lane: 'interactive',
      priority: 10,
    };
    void publishDurably({
      api,
      input,
      publisherSubject: verified?.subject,
      expectedDeliveries: 1,
      reconcile: () => { void reloadMessages(); },
      onAccepted: ({ receipt }) => {
        setDrafts((current) => ((current.get(id) ?? '') === snapshot ? new Map(current).set(id, '') : current));
        setPending((current) => (current.has(id) ? new Map(current).set(id, { since: Date.now(), seen, messageId: receipt.message_id }) : current));
        void reloadMessages();
      },
    }).then(({ receipt, journalStatus }) => {
      setStatus({ id, value: { tone: 'sent', text: `Enviado · ${compactId(receipt.message_id)}${journalStatus === 'confirmed' ? '' : ' · confirmación pendiente'}` } });
    }, (cause: unknown) => {
      setPending((current) => new Map([...current].filter(([key]) => key !== id)));
      setStatus({ id, value: { tone: 'failed', text: cause instanceof Error ? cause.message : 'No se pudo enviar el mensaje.' } });
    }).finally(() => { busy.current.delete(id); });
  }, [talkId, agent, route, drafts, page, api, verified?.subject, reloadMessages]);

  const dialog = useMemo<OfficeDialogModel | null>(() => {
    if (!talkId) return null;
    const { tenantId, alias } = splitId(talkId);
    const canPublish = permissionState(verified, 'message.publish') === 'allowed';
    const blocked = !agent ? 'El chat todavía no conoce a este agente; probá desde Mensajes.'
      : !canPublish ? 'Requiere el permiso message.publish.'
        : route && !route.allowed ? route.reason
          : route && route.sourceRoomIds.length !== 1 ? 'Compartís varias salas con este agente: elegí desde cuál escribir en el chat.'
            : undefined;
    return {
      id: talkId,
      tenantId,
      alias,
      lines: agent ? dialogLines(page, agent, verified?.human_subject ?? verified?.subject) : [],
      blocked,
      chatHref: `/messages/${encodeURIComponent(tenantId)}/${encodeURIComponent(alias)}`,
      draft: drafts.get(talkId) ?? '',
      status: status?.id === talkId ? status.value : null,
      thinking: pending.has(talkId),
      setDraft: (text) => { setDrafts((current) => new Map(current).set(talkId, text)); },
      send,
    };
  }, [talkId, agent, route, verified, page, drafts, status, pending, send]);

  return { dialog, speech };
}
