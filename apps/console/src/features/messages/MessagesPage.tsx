import { Send, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useApi } from '../../api/context';
import type { JobLane } from '../../api/types';
import { useResource } from '../../api/use-resource';
import { Badge, EmptyState, ErrorState, LoadingState, PageHeader, Panel, PermissionBadge, RefreshButton, Time, Unknown } from '../../components/ui';
import { compactId, createId, permissionState, safeDeliveryState, safeJobLane } from '../../lib';
import { MessageTimeline } from './MessageTimeline';

function parseRecipient(value: string): { tenant_id: string; alias: string } | undefined {
  const [tenant, alias, ...extra] = value.split(':').map((part) => part.trim());
  return tenant && alias && extra.length === 0 ? { tenant_id: tenant, alias } : undefined;
}

export function MessagesPage() {
  const api = useApi();
  const resource = useResource('messages', () => api.listMessages());
  const access = useResource('console-access', () => api.getConsoleAccess());
  const [room, setRoom] = useState('grp.steven');
  const [recipient, setRecipient] = useState('Steven:argos');
  const [text, setText] = useState('');
  const [lane, setLane] = useState<JobLane>('interactive');
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const canPublish = permissionState(access.data, 'message.publish') === 'allowed';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canPublish) {
      setFormError('Publicación bloqueada: permiso RBAC DENY o UNKNOWN.');
      return;
    }
    const parsed = parseRecipient(recipient);
    if (!parsed) {
      setFormError('Usá el formato Tenant:alias.');
      return;
    }
    if (!text.trim()) {
      setFormError('El mensaje no puede estar vacío.');
      return;
    }
    setSubmitting(true);
    setFormError(undefined);
    setNotice(undefined);
    try {
      const result = await api.publishMessage({
        room_id: room.trim(),
        recipients: [parsed],
        body: { text: text.trim() },
        lane,
        priority: lane === 'interactive' ? 10 : 0,
        idempotency_key: createId('console'),
      });
      setText('');
      setNotice(`Publish aceptado: ${compactId(result.message_id)}`);
      resource.reload();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Error desconocido');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <PageHeader eyebrow="Durable messaging" title="Messages & timeline" description="Seguimiento correlacionado desde publish hasta ACK terminal. Actor, tenant de origen y canal son autoridad del servidor." actions={<RefreshButton onClick={resource.reload} loading={resource.loading} />} />
      <PermissionBadge access={access.data} permission="message.publish" />
      <Panel title="Publicar por Cauce" subtitle="El backend deriva la identidad de la cookie HttpOnly; este formulario no acepta actor, session ni channel.">
        <form className="publish-form" onSubmit={(event) => void submit(event)}>
          <label>Room<input value={room} onChange={(event) => setRoom(event.target.value)} required /></label>
          <label>Destinatario <span className="label-hint">Tenant:alias</span><input value={recipient} onChange={(event) => setRecipient(event.target.value)} pattern="[^:]+:[^:]+" required /></label>
          <label>Lane<select value={lane} onChange={(event) => setLane(event.target.value as JobLane)}><option value="interactive">Interactive</option><option value="batch">Batch</option></select></label>
          <label className="message-input">Mensaje<textarea value={text} onChange={(event) => setText(event.target.value)} rows={3} maxLength={8000} required /></label>
          <button className="button primary" type="submit" disabled={!canPublish || submitting}><Send size={16} aria-hidden="true" />{submitting ? 'Publicando…' : 'Publicar'}</button>
        </form>
        <div className="trust-callout"><ShieldCheck size={17} aria-hidden="true" /><span>Sin Authorization header manual, sin storage persistente y sin campos de identidad del cliente.</span></div>
        {notice ? <p className="notice success" role="status">{notice}</p> : null}
        {formError ? <p className="notice error" role="alert">{formError}</p> : null}
      </Panel>
      {resource.loading && !resource.data ? <LoadingState /> : null}
      {resource.error && !resource.data ? <ErrorState error={resource.error} onRetry={resource.reload} /> : null}
      {resource.data ? (
        <div className="message-list" aria-label="Mensajes recientes">
          {(resource.data.items ?? []).length === 0 ? <EmptyState>No hay mensajes visibles para la identidad autenticada.</EmptyState> : (resource.data.items ?? []).map((message, index) => (
            <Panel className="message-card" key={message.message_id ?? index}>
              <div className="message-card-head">
                <div><p className="eyebrow"><Unknown value={message.room_id} /> · <Unknown value={safeJobLane(message.lane)} /></p><h2>{message.body_preview ?? 'Contenido UNKNOWN'}</h2></div>
                <Badge tone="info">{compactId(message.message_id)}</Badge>
              </div>
              <dl className="metadata-grid">
                <div><dt>Actor verificado</dt><dd><Unknown value={message.actor_alias} /></dd></div>
                <div><dt>Tenant</dt><dd><Unknown value={message.tenant_id} /></dd></div>
                <div><dt>Trace</dt><dd className="mono"><Unknown value={message.trace_id} /></dd></div>
                <div><dt>Publicado</dt><dd><Time value={message.created_at} /></dd></div>
              </dl>
              {(message.deliveries ?? []).length === 0 ? <EmptyState>Deliveries: UNKNOWN.</EmptyState> : (message.deliveries ?? []).map((delivery, deliveryIndex) => {
                const status = safeDeliveryState(delivery.status);
                return <section className="delivery" key={delivery.delivery_id ?? deliveryIndex}>
                  <header><strong><Unknown value={delivery.recipient_alias} /></strong><span><Unknown value={delivery.recipient_tenant} /></span><Badge tone={status === 'done' ? 'done' : status === 'failed' || status === 'dead' ? 'danger' : status ? 'running' : 'unknown'}><Unknown value={status} /></Badge></header>
                  <MessageTimeline events={delivery.timeline} />
                </section>;
              })}
            </Panel>
          ))}
        </div>
      ) : null}
    </>
  );
}
