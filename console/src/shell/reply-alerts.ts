import { useEffect, useRef, useState } from 'react';
import { useOptionalConsoleAccess } from '../api/console-access';
import type { MessagePage } from '../api/types';
import { isClientMailboxDelivery } from '../features/deliveries/client-mailbox';
import { humanAuthor } from '../features/terminal/message-author';
import { useFleet } from './fleet-context';

const SETTLED = new Set(['done', 'failed', 'dead']);
const COUNT_PREFIX = /^\(\d+\) /u;

/** Deliveries of the operator's own messages that settled since `before`: one entry per settled delivery. */
export function settledSince(before: ReadonlyMap<string, string>, page: MessagePage | undefined, me: string): {
  statuses: Map<string, string>; settled: { alias: string; ok: boolean }[];
} {
  const statuses = new Map<string, string>();
  const settled: { alias: string; ok: boolean }[] = [];
  for (const message of page?.items ?? []) {
    if (humanAuthor(message)?.subject_id !== me) continue;
    for (const delivery of message.deliveries ?? []) {
      if (!delivery.delivery_id || !delivery.status || isClientMailboxDelivery(delivery)) continue;
      statuses.set(delivery.delivery_id, delivery.status);
      const previous = before.get(delivery.delivery_id);
      if (previous !== undefined && !SETTLED.has(previous) && SETTLED.has(delivery.status)) {
        settled.push({ alias: delivery.recipient_alias ?? 'Un agente', ok: delivery.status === 'done' });
      }
    }
  }
  return { statuses, settled };
}

let paints = 0;

function paintFavicon(count: number, original: string): void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  const paint = ++paints;
  if (count === 0) { link.href = original; return; }
  const image = new Image();
  image.onload = () => {
    if (paint !== paints) return;
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(image, 0, 0, 64, 64);
    context.fillStyle = '#e5484d';
    context.beginPath(); context.arc(50, 14, 13, 0, Math.PI * 2); context.fill();
    link.href = canvas.toDataURL('image/png');
  };
  image.src = original;
}

/**
 * While the tab is hidden, settled replies to the operator's own messages count in the tab title,
 * dot the favicon and, if the browser already granted it, raise a desktop notification.
 */
export function useReplyAlerts(): void {
  const fleet = useFleet();
  const access = useOptionalConsoleAccess();
  const me = access?.error ? undefined : access?.data?.human_subject ?? access?.data?.subject;
  const statuses = useRef<Map<string, string> | null>(null);
  const [unread, setUnread] = useState(0);
  const original = useRef<string | null>(null);

  useEffect(() => {
    if (!me || !fleet.messages.data) return;
    const result = settledSince(statuses.current ?? new Map(), fleet.messages.data, me);
    const first = statuses.current === null;
    statuses.current = result.statuses;
    if (first || !document.hidden || result.settled.length === 0) return;
    setUnread((count) => count + result.settled.length);
    if ('Notification' in window && Notification.permission === 'granted') {
      const last = result.settled.at(-1);
      // Android Chrome refuses the constructor even with permission; the title and favicon still tell.
      try {
        if (last) new Notification(last.ok ? `${last.alias} respondió` : `${last.alias}: la entrega falló`, { body: 'Abrí Cauce para verlo.', tag: 'cauce-reply' });
      } catch { /* the badge is enough */ }
    }
  }, [fleet.messages.data, me]);

  useEffect(() => {
    const onVisible = () => { if (!document.hidden) setUnread(0); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  useEffect(() => {
    original.current ??= document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href ?? null;
    const base = document.title.replace(COUNT_PREFIX, '');
    document.title = unread > 0 ? `(${String(unread)}) ${base}` : base;
    if (original.current) paintFavicon(unread, original.current);
  }, [unread]);

  useEffect(() => () => {
    document.title = document.title.replace(COUNT_PREFIX, '');
    if (original.current) paintFavicon(0, original.current);
  }, []);
}
