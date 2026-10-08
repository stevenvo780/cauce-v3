import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type CauceApi } from '../../api/client';
import type { MessageDetail } from '../../api/types';
import { usePolling } from '../../api/use-polling';
import { canonicalReplyMedia } from './canonical-reply-media';
import type { CanonicalReply, CanonicalReplyRoot } from './use-canonical-reply';

const apiScopes = new WeakMap<CauceApi, number>();
let nextApiScope = 0;
const EMPTY_REPLIES: readonly CanonicalReply[] = [];
export function canonicalReplyScope(api: CauceApi, subject: string | null | undefined, tenant: string, alias: string): string {
  if (!apiScopes.has(api)) apiScopes.set(api, ++nextApiScope);
  return JSON.stringify([apiScopes.get(api), subject, tenant, alias]);
}

export function replyIdentity(reply: CanonicalReply): string {
  return JSON.stringify([reply.messageId, reply.deliveryId, reply.tenantId, reply.alias]);
}

function consolidated(reply: CanonicalReply): boolean {
  return reply.chainOpen === false && ['done', 'failed', 'dead'].includes(reply.status ?? '')
    && (Boolean(reply.reply?.trim()) || Boolean(reply.replyAttachments?.length));
}

export function projectReply(detail: MessageDetail, root: CanonicalReplyRoot, tenantId: string, alias: string): CanonicalReply {
  if (detail.message_id !== root.messageId && detail.id !== root.messageId) {
    throw new Error('El detalle no corresponde a la publicación seleccionada.');
  }
  if (detail.chain_open !== undefined && typeof detail.chain_open !== 'boolean') {
    throw new Error('El servidor devolvió un estado de cadena inválido.');
  }
  if (detail.deliveries !== undefined && detail.deliveries !== null && !Array.isArray(detail.deliveries)) {
    throw new Error('El servidor devolvió entregas inválidas.');
  }
  const delivery = detail.deliveries?.find((candidate) => candidate.delivery_id === root.deliveryId);
  if (delivery?.tenant_id !== tenantId || delivery.alias !== alias) {
    throw new Error('La entrega del detalle no coincide con este destinatario.');
  }
  if (delivery.reply !== undefined && delivery.reply !== null && typeof delivery.reply !== 'string') {
    throw new Error('El servidor devolvió una respuesta canónica inválida.');
  }
  const status = delivery.status === undefined ? root.status : delivery.status;
  return {
    messageId: root.messageId, deliveryId: root.deliveryId, tenantId, alias,
    ...(detail.chain_open === undefined ? {} : { chainOpen: detail.chain_open }),
    ...(status === undefined ? {} : { status }),
    ...(delivery.reply === undefined ? {} : { reply: delivery.reply }),
    ...canonicalReplyMedia(delivery),
  };
}


function publisherOwned(author: unknown, subject: string | null | undefined): boolean {
  if (author === undefined || author === null) return true;
  return typeof author === 'object' && 'kind' in author && author.kind === 'human'
    && 'subject_id' in author && author.subject_id === subject;
}

interface HistoryRead {
  failures: number;
  unresolved: number;
  complete: boolean;
  missingSince?: number;
  openReads?: number;
  nextAt?: number;
}

/** Older roots back off instead of polling forever: open chains after four reads, failures from the first. */
const backoff = (step: number) => Date.now() + Math.min(60_000, 2_500 * 2 ** step);

function afterRead(previous: HistoryRead, reply: CanonicalReply): HistoryRead {
  const terminal = ['done', 'failed', 'dead'].includes(reply.status ?? '');
  const missing = reply.status === 'done' && reply.chainOpen !== true && !reply.reply?.trim() && !reply.replyAttachments?.length;
  const unresolved = reply.chainOpen === false && !terminal ? previous.unresolved + 1 : 0;
  const ongoing = reply.chainOpen === true || (reply.chainOpen !== false && ['pending', 'leased', 'accepted', 'started', 'retry'].includes(reply.status ?? ''));
  const openReads = ongoing ? (previous.openReads ?? 0) + 1 : 0;
  return { failures: 0, unresolved, openReads, complete: !ongoing && !missing && !(reply.chainOpen === false && !terminal && unresolved < 3),
    ...(missing ? { missingSince: previous.missingSince ?? Date.now() } : {}),
    ...(openReads > 4 ? { nextAt: backoff(openReads - 4) } : {}) };
}

export function useCanonicalReplyHistory(api: CauceApi, scope: string, input: {
  publisherSubject?: string | null; tenantId: string; alias: string;
  root?: CanonicalReplyRoot; roots?: readonly CanonicalReplyRoot[];
}) {
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [cache, setCache] = useState<{ scope: string; replies: readonly CanonicalReply[] }>({ scope, replies: [] });
  const attempts = useRef(new Map<string, HistoryRead>());
  const busy = useRef(false);
  const fences = useRef(new Map<string, { next: number; denied: number; approved: number }>());
  const begin = useCallback((capturedScope: string, root: CanonicalReplyRoot) => {
    const key = JSON.stringify([capturedScope, root.messageId, root.deliveryId]);
    const fence = fences.current.get(key) ?? { next: 0, denied: 0, approved: 0 };
    fence.next += 1;
    fences.current.set(key, fence);
    return fence;
  }, []);
  const resetScope = useRef(scope);
  useEffect(() => {
    if (resetScope.current === scope) return;
    resetScope.current = scope;
    attempts.current.clear();
    fences.current.clear();
  }, [scope]);
  const remember = useCallback((capturedScope: string, reply: CanonicalReply, sequence: number) => {
    const fence = fences.current.get(JSON.stringify([capturedScope, reply.messageId, reply.deliveryId]));
    if (capturedScope !== currentScope.current || !fence || sequence <= fence.denied) return;
    fence.approved = Math.max(fence.approved, sequence);
    if (!consolidated(reply)) return;
    setCache((previous) => {
      const replies = previous.scope === capturedScope ? previous.replies : [];
      const index = replies.findIndex((stored) => replyIdentity(stored) === replyIdentity(reply));
      if (index < 0) return { scope: capturedScope, replies: [...replies, reply].slice(-100) };
      const stored = replies.at(index);
      if (!stored) return previous;
      const addText = !stored.reply?.trim() && Boolean(reply.reply?.trim());
      const addMedia = !stored.replyAttachments?.length && Boolean(reply.replyAttachments?.length);
      if (!addText && !addMedia) return previous;
      const merged = { ...stored, ...(addText ? { reply: reply.reply } : {}), ...(addMedia ? {
        replyAttachments: reply.replyAttachments, replyAttachmentDeliveryId: reply.replyAttachmentDeliveryId,
        replyAttachmentAttempt: reply.replyAttachmentAttempt,
      } : {}) };
      return { scope: capturedScope, replies: replies.map((entry, position) => position === index ? merged : entry) };
    });
  }, []);
  const reject = useCallback((capturedScope: string, root: CanonicalReplyRoot, error: unknown, sequence: number) => {
    const fence = fences.current.get(JSON.stringify([capturedScope, root.messageId, root.deliveryId]));
    if (capturedScope !== currentScope.current || !fence || sequence < fence.approved
      || !(error instanceof ApiError) || ![401, 403, 404].includes(error.status)) return false;
    fence.denied = Math.max(fence.denied, sequence);
    setCache((previous) => previous.scope !== capturedScope ? previous : {
      scope: capturedScope, replies: previous.replies.filter((reply) => reply.messageId !== root.messageId || reply.deliveryId !== root.deliveryId),
    });
    return true;
  }, []);
  const replies = cache.scope === scope ? cache.replies : EMPTY_REPLIES;
  const rootsKey = JSON.stringify([...new Map((input.roots ?? []).filter((root) => root.messageId && root.deliveryId)
    .map((root) => [JSON.stringify([root.messageId, root.deliveryId]), root])).values()].slice(-100));
  const hydrate = useCallback(() => {
    if (busy.current || !input.publisherSubject) return;
    const roots = JSON.parse(rootsKey) as CanonicalReplyRoot[];
    busy.current = true;
    void (async () => {
      try {
        for (const root of roots) {
          if (currentScope.current !== scope) break;
          if (root.messageId === input.root?.messageId && root.deliveryId === input.root.deliveryId) continue;
          const identity = JSON.stringify([scope, root.messageId, root.deliveryId, root.status]);
          const previous = attempts.current.get(identity) ?? { failures: 0, unresolved: 0, complete: false };
          if ((previous.nextAt !== undefined && Date.now() < previous.nextAt) || previous.complete || (previous.missingSince !== undefined && Date.now() - previous.missingSince >= 120_000)
            || replies.some((reply) => reply.messageId === root.messageId && reply.deliveryId === root.deliveryId)) continue;
          const sequence = begin(scope, root).next;
          try {
            const detail = await api.getMessage(root.messageId);
            if (!publisherOwned(detail.author, input.publisherSubject)) {
              throw new ApiError('La publicación pertenece a otro operador.', 403);
            }
            const reply = projectReply(detail, root, input.tenantId, input.alias);
            attempts.current.set(identity, afterRead(previous, reply));
            remember(scope, reply, sequence);
          } catch (error) {
            const revoked = reject(scope, root, error, sequence);
            attempts.current.set(identity, { ...previous, failures: previous.failures + 1, complete: revoked, nextAt: backoff(previous.failures) });
          }
        }
      } finally { busy.current = false; }
    })();
  }, [api, begin, input.alias, input.publisherSubject, input.root?.deliveryId, input.root?.messageId, input.tenantId, reject, remember, replies, rootsKey, scope]);
  useEffect(() => { hydrate(); }, [hydrate]);
  usePolling(hydrate, input.roots?.length && input.publisherSubject ? 2_500 : 0);
  return { replies, remember, reject, begin };
}
