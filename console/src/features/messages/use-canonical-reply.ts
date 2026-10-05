import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { useApi } from '../../api/context';
import { usePolling } from '../../api/use-polling';
import { useResource } from '../../api/use-resource';
import type { DeliveryState, MessageDetail } from '../../api/types';

export interface CanonicalReplyRoot {
  messageId: string;
  deliveryId: string;
  status?: DeliveryState | null;
}

export interface CanonicalReply {
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

function project(detail: MessageDetail, root: CanonicalReplyRoot, tenantId: string, alias: string): CanonicalReply {
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
  return {
    messageId: root.messageId, deliveryId: root.deliveryId, tenantId, alias,
    ...(detail.chain_open === undefined ? {} : { chainOpen: detail.chain_open }),
    ...((root.status ?? delivery.status) === undefined ? {} : { status: root.status ?? delivery.status }),
    ...(delivery.reply === undefined ? {} : { reply: delivery.reply }),
  };
}

export function useCanonicalReply(input: {
  publisherSubject?: string | null;
  tenantId: string;
  alias: string;
  root?: CanonicalReplyRoot;
}) {
  const api = useApi();
  const { publisherSubject, tenantId, alias, root } = input;
  const active = Boolean(publisherSubject && root?.messageId && root.deliveryId);
  const key = active
    ? JSON.stringify([publisherSubject, tenantId, alias, root?.messageId, root?.deliveryId])
    : 'canonical-reply:inactive';
  const [automaticFailures, setAutomaticFailures] = useState({ key, count: 0 });
  const currentKey = useRef(key);
  useEffect(() => { currentKey.current = key; }, [key]);
  const resource = useResource<CanonicalReply | undefined>(key, async () => {
    if (!active || !root) return undefined;
    try {
      const reply = project(await api.getMessage(root.messageId), root, tenantId, alias);
      if (currentKey.current === key) setAutomaticFailures((current) => (
        current.key === key && current.count === 0 ? current : { key, count: 0 }
      ));
      return reply;
    } catch (error) {
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

  const effectiveStatus = root?.status ?? resource.data?.status;
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
    && data.chainOpen !== true && !data.reply?.trim();
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
    reply: data, loading: resource.loading, error, stale, accessDenied, retry,
  }), [accessDenied, data, error, resource.loading, retry, stale]);
}
