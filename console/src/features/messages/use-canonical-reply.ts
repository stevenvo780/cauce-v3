import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { useApi } from '../../api/context';
import { usePolling } from '../../api/use-polling';
import { useResource } from '../../api/use-resource';
import type { DeliveryState } from '../../api/types';
import { type CanonicalReplyMedia } from './canonical-reply-media';
import { canonicalReplyScope, projectReply, useCanonicalReplyHistory } from './canonical-reply-history';

export interface CanonicalReplyRoot {
  messageId: string;
  deliveryId: string;
  status?: DeliveryState | null;
}

export interface CanonicalReply extends CanonicalReplyMedia {
  messageId: string;
  deliveryId: string;
  tenantId: string;
  alias: string;
  chainOpen?: boolean;
  status?: DeliveryState | null;
  reply?: string | null;
}

const MISSING_REPLY_WINDOW_MS = 120_000;
const REPLY_POLL_INTERVAL_MS = 2_500;

function terminal(status: DeliveryState | null | undefined): boolean {
  return status === 'done' || status === 'failed' || status === 'dead';
}


export function useCanonicalReply(input: {
  publisherSubject?: string | null;
  tenantId: string;
  alias: string;
  root?: CanonicalReplyRoot;
  roots?: readonly CanonicalReplyRoot[];
}) {
  const api = useApi();
  const { publisherSubject, tenantId, alias, root } = input;
  const identity = canonicalReplyScope(api, publisherSubject, tenantId, alias);
  const session = useRef({ identity, generation: 0 });
  if (session.current.identity !== identity) session.current = { identity, generation: session.current.generation + 1 };
  const scope = `${identity}:${String(session.current.generation)}`;
  const history = useCanonicalReplyHistory(api, scope, input);
  const active = Boolean(publisherSubject && root?.messageId && root.deliveryId);
  const key = active
    ? JSON.stringify([scope, root?.messageId, root?.deliveryId])
    : `${scope}:inactive`;
  const [automaticFailures, setAutomaticFailures] = useState({ key, count: 0 });
  const currentKey = useRef(key);
  useEffect(() => { currentKey.current = key; }, [key]);
  const resource = useResource<CanonicalReply | undefined>(key, async () => {
    if (!active || !root) return undefined;
    const sequence = history.begin(scope, root).next;
    try {
      const reply = projectReply(await api.getMessage(root.messageId), root, tenantId, alias);
      history.remember(scope, reply, sequence);
      if (currentKey.current === key) setAutomaticFailures((current) => (
        current.key === key && current.count === 0 ? current : { key, count: 0 }
      ));
      return reply;
    } catch (error) {
      history.reject(scope, root, error, sequence);
      if (currentKey.current === key) setAutomaticFailures((current) => ({
        key, count: Math.min(3, (current.key === key ? current.count : 0) + 1),
      }));
      throw error;
    }
  });
  const reload = resource.reload;
  const [purgedKey, setPurgedKey] = useState<string>();
  const [unresolvedClose, setUnresolvedClose] = useState({ key, reads: 0 });
  const [missingReplyWindow, setMissingReplyWindow] = useState<{ key: string; startedAt?: number }>({ key });
  const previousStatus = useRef<DeliveryState | null | undefined>(root?.status);
  const rootTerminal = terminal(root?.status);

  useEffect(() => {
    if (resource.error instanceof ApiError && [401, 403, 404].includes(resource.error.status)) {
      setPurgedKey(key);
    } else if (!resource.error && resource.data) {
      setPurgedKey((current) => current === key ? undefined : current);
    }
  }, [key, resource.data, resource.error]);

  const effectiveStatus = resource.data === undefined ? root?.status : resource.data.status;
  const effectiveTerminal = terminal(effectiveStatus);
  useEffect(() => {
    if (!resource.data) return;
    if (resource.data.chainOpen === true || effectiveTerminal) {
      setUnresolvedClose({ key, reads: 0 });
    } else if (resource.data.chainOpen === false) {
      setUnresolvedClose((current) => ({
        key,
        reads: Math.min(3, (current.key === key ? current.reads : 0) + 1),
      }));
    }
  }, [effectiveTerminal, key, resource.data]);

  useEffect(() => {
    if (rootTerminal && !terminal(previousStatus.current) && active) void reload();
    previousStatus.current = root?.status;
  }, [active, reload, root?.status, rootTerminal]);

  const accessError = resource.error instanceof ApiError && [401, 403, 404].includes(resource.error.status);
  const accessDenied = purgedKey === key || accessError;
  const data = accessDenied ? undefined : resource.data;
  const waitingForMissingReply = effectiveStatus === 'done' && data !== undefined
    && data.chainOpen !== true && !data.reply?.trim() && !data.replyAttachments?.length;
  useEffect(() => {
    setMissingReplyWindow((current) => {
      if (!waitingForMissingReply) return current.key === key && current.startedAt === undefined ? current : { key };
      return current.key === key && current.startedAt !== undefined ? current : { key, startedAt: Date.now() };
    });
  }, [key, waitingForMissingReply]);
  const withinMissingReplyWindow = waitingForMissingReply && (missingReplyWindow.key !== key
    || missingReplyWindow.startedAt === undefined || Date.now() - missingReplyWindow.startedAt < MISSING_REPLY_WINDOW_MS);
  const retry = useCallback(() => {
    setAutomaticFailures({ key, count: 0 });
    if (waitingForMissingReply) setMissingReplyWindow({ key, startedAt: Date.now() });
    void reload();
  }, [key, reload, waitingForMissingReply]);

  const rootInProgress = ['pending', 'leased', 'accepted', 'started', 'retry'].includes(effectiveStatus ?? '');
  const unresolvedReads = unresolvedClose.key === key ? unresolvedClose.reads : 0;
  const boundedUnresolvedClose = resource.data?.chainOpen === false && !effectiveTerminal;
  const shouldPoll = active && !resource.loading && !accessDenied && (automaticFailures.key !== key || automaticFailures.count < 3)
    && (data?.chainOpen === true || (data?.chainOpen !== false && rootInProgress)
      || (boundedUnresolvedClose && unresolvedReads < 3) || withinMissingReplyWindow);
  const poll = useCallback(() => { void reload(); }, [reload]);
  usePolling(poll, shouldPoll ? REPLY_POLL_INTERVAL_MS : 0, { pausedWhile: resource.loading });

  const error = resource.error;
  const stale = Boolean(error && data && !(error instanceof ApiError && [401, 403, 404].includes(error.status)));
  return useMemo(() => ({
    reply: data, replies: history.replies, loading: resource.loading, error, stale, accessDenied, retry,
  }), [accessDenied, data, error, history.replies, resource.loading, retry, stale]);
}
