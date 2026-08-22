import { ChevronDown, CircleOff, LockKeyhole, RefreshCw, Send, TerminalSquare } from 'lucide-react';
import { useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useApi } from '../../api/context';
import type { DeliveryView, MessagePage } from '../../api/types';
import { Badge, EmptyState, LoadingState, Time } from '../../components/ui';
import { compactId, createId } from '../../lib';
import { onNavClick } from '../../navigation';
import type { FleetAgent } from '../terminal/fleet';
import { transcriptForSession, type OperatorRoute, type OperatorSession } from '../terminal/session';
import { TerminalTranscript } from '../terminal/TerminalTranscript';
import { MessageTimeline } from './MessageTimeline';
import { LIMITE_MENSAJES, textoDeCifra, type SaludDeCola } from './queue-health';

interface ConversationPaneProps {
  agent: FleetAgent;
  page?: MessagePage;
  loading: boolean;
  error?: Error;
  route: OperatorRoute;
  canPublish: boolean;
  salud?: SaludDeCola;
  onReload: () => void;
}

/** Ruta del detalle del bot, que es donde vive su terminal (feed durable + PTY cuando existe). */
function rutaDeTui(agent: FleetAgent): string {
  return `/fleet/${encodeURIComponent(agent.tenantId)}/${encodeURIComponent(agent.alias)}`;
}

/**
 * El hilo con UN agente: cabecera con su estado y su cola, historial, y el campo para escribirle.
 *
 * El historial y el envío no se reimplementan: `transcriptForSession` y `TerminalTranscript`
 * son los mismos que usa Ultimate Terminal, y el room de origen lo deriva `operatorRouteForAgent`
 * a partir de la topología del actor. El formulario viejo pedía el room y un «Tenant:alias» a
 * mano; eso no era información que el operador tuviera que aportar, era una forma de equivocarse.
 */
export function ConversationPane({ agent, page, loading, error, route, canPublish, salud, onReload }: ConversationPaneProps) {
  const api = useApi();
  const [draft, setDraft] = useState('');
  const [roomElegido, setRoomElegido] = useState<string>();
  const [enviando, setEnviando] = useState(false);
  const [aviso, setAviso] = useState<{ tone: 'success' | 'error'; text: string }>();
  const [deliveryElegida, setDeliveryElegida] = useState<string>();

  const sesion: OperatorSession = useMemo(() => ({
    id: `messenger:${agent.id}`, agent, sourceRoomId: '', openedAt: new Date(0).toISOString(), mode: 'transcript',
  }), [agent]);
  const hilo = useMemo(() => transcriptForSession(page, sesion), [page, sesion]);

  const roomOrigen = roomElegido && route.sourceRoomIds.includes(roomElegido)
    ? roomElegido
    : route.sourceRoomIds[0] ?? '';
  const puedeEnviar = canPublish && route.allowed && Boolean(roomOrigen);
  const seleccionada = hilo.map((item) => item.delivery).find((delivery) => delivery?.delivery_id === deliveryElegida)
    ?? hilo.at(-1)?.delivery;
  const totalVisible = (page?.items ?? []).length;

  async function enviar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const texto = draft.trim();
    if (!puedeEnviar || !texto) return;
    setEnviando(true);
    setAviso(undefined);
    try {
      const resultado = await api.publishMessage({
        room_id: roomOrigen,
        recipients: [{ tenant_id: agent.tenantId, alias: agent.alias }],
        body: { text: texto },
        lane: 'interactive',
        priority: 10,
        idempotency_key: createId(`consola-mensajes-${agent.alias}`),
      });
      setDraft('');
      setAviso({ tone: 'success', text: `Aceptado por el control plane · ${compactId(resultado.message_id)}. El ACK llega por polling.` });
      onReload();
    } catch (causa) {
      setAviso({ tone: 'error', text: causa instanceof Error ? causa.message : 'No se pudo publicar el mensaje.' });
    } finally {
      setEnviando(false);
    }
  }

  function teclaDelCompositor(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <section className="messenger-thread" aria-label={`Conversación con ${agent.alias}`}>
      <header className="messenger-thread-head">
        <div className="messenger-thread-identity">
          <span className={`messenger-avatar ${agent.leaseState}`} aria-hidden="true">{agent.alias.slice(0, 2).toUpperCase()}</span>
          <div>
            <h2>{agent.alias}</h2>
            <p className="eyebrow">{agent.tenantId} · epoch {agent.presence?.epoch ?? 'UNKNOWN'} · lease <Time value={agent.presence?.lease_expires_at ?? agent.presence?.lease_until} /></p>
          </div>
          <Badge tone={agent.leaseState === 'online' ? 'online' : agent.leaseState === 'expired' ? 'offline' : 'unknown'}>{agent.leaseState}</Badge>
        </div>
        <div className="messenger-thread-actions">
          <a
            className="button small secondary"
            href={rutaDeTui(agent)}
            onClick={(event) => onNavClick(event, rutaDeTui(agent))}
            title={`Abrir la terminal de ${agent.alias} (feed durable y PTY cuando el servidor lo declara)`}
          ><TerminalSquare size={14} aria-hidden="true" /> Abrir TUI</a>
          <button className="button small secondary" type="button" onClick={onReload} disabled={loading}>
            <RefreshCw size={13} aria-hidden="true" /> Sincronizar
          </button>
        </div>
      </header>

      <dl className="messenger-queue-strip" aria-label={`Cola de ${agent.alias}`}>
        <div><dt>En cola</dt><dd>{textoDeCifra(salud?.pendientes)}</dd></div>
        <div><dt>En curso</dt><dd>{textoDeCifra(salud?.enCurso)}</dd></div>
        <div><dt>Reintentos</dt><dd>{textoDeCifra(salud?.reintentos)}</dd></div>
        <div data-alarm={(salud?.muertas ?? 0) > 0 || undefined}>
          <dt>Muertas</dt>
          <dd>{salud?.muertasTruncadas && salud.muertas !== undefined ? '≥ ' : ''}{textoDeCifra(salud?.muertas)}</dd>
        </div>
      </dl>

      {/*
        El techo del servidor se DICE, no se disimula. `listMessages` corta en 100 mensajes
        globales y no acepta filtro por par (medido en packages/store/src/repository.ts), así que
        este hilo es un filtro de cliente sobre esa ventana: en una flota cargada puede verse
        vacío sin que eso pruebe que no hay historia. Un hilo vacío mudo sería una afirmación
        falsa, y de esas ya hubo demasiadas en esta consola.
      */}
      <p className="messenger-window-note" data-truncated={totalVisible >= LIMITE_MENSAJES || undefined}>
        {totalVisible >= LIMITE_MENSAJES
          ? `Ventana llena: el servidor devuelve como máximo ${LIMITE_MENSAJES} mensajes de TODA la flota y este hilo se filtra sobre ellos. Puede haber historia anterior que no entra.`
          : `Hilo filtrado sobre los ${totalVisible} mensajes que el servidor publica para tu identidad (tope ${LIMITE_MENSAJES}, sin filtro por par).`}
      </p>

      {error && !page ? (
        <div role="alert"><EmptyState>No se pudo leer el feed de mensajes: {error.message}</EmptyState></div>
      ) : loading && !page ? (
        <LoadingState label="Abriendo el feed durable de mensajes…" />
      ) : (
        <TerminalTranscript
          key={agent.id}
          items={hilo}
          selectedDeliveryId={seleccionada?.delivery_id ?? undefined}
          onSelectDelivery={(delivery: DeliveryView) => delivery.delivery_id && setDeliveryElegida(delivery.delivery_id)}
        />
      )}

      {seleccionada ? (
        <div className="messenger-delivery-detail">
          <p className="eyebrow">Entrega {compactId(seleccionada.delivery_id)} → {seleccionada.recipient_alias ?? 'UNKNOWN'}</p>
          <MessageTimeline events={seleccionada.timeline} />
        </div>
      ) : null}

      <form className="terminal-composer messenger-composer" onSubmit={(event) => void enviar(event)}>
        <label htmlFor={`messenger-input-${agent.id}`}>Mensaje para {agent.alias}</label>
        {route.sourceRoomIds.length > 1 ? (
          <label className="messenger-room-select">Room de origen
            <span className="room-select-wrap">
              <select value={roomOrigen} onChange={(event) => setRoomElegido(event.target.value)}>
                {route.sourceRoomIds.map((room) => <option key={room} value={room}>{room}</option>)}
              </select>
              <ChevronDown size={14} aria-hidden="true" />
            </span>
          </label>
        ) : (
          <p className="messenger-room-fixed">Room de origen: <span className="mono">{roomOrigen || 'UNKNOWN'}</span> · derivado de tu topología, no escrito a mano.</p>
        )}
        <textarea
          id={`messenger-input-${agent.id}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={teclaDelCompositor}
          rows={3}
          maxLength={8_000}
          placeholder={agent.leaseState === 'online' ? 'Escribí un mensaje…' : 'El agente no tiene lease vigente; Cauce puede encolar el mensaje igual.'}
          disabled={!puedeEnviar || enviando}
        />
        <div className="composer-footer">
          <span><kbd>Enter</kbd> enviar · <kbd>Shift</kbd> + <kbd>Enter</kbd> nueva línea</span>
          <button className="button primary" type="submit" disabled={!puedeEnviar || enviando || !draft.trim()}>
            <Send size={15} aria-hidden="true" /> {enviando ? 'Enviando…' : 'Enviar'}
          </button>
        </div>
        {!canPublish ? <p className="composer-blocked"><LockKeyhole size={14} aria-hidden="true" /> Requiere el permiso message.publish.</p> : null}
        {!route.allowed ? <p className="composer-blocked"><CircleOff size={14} aria-hidden="true" /> {route.reason}</p> : null}
        {aviso ? <p className={`notice ${aviso.tone}`} role={aviso.tone === 'error' ? 'alert' : 'status'}>{aviso.text}</p> : null}
      </form>
    </section>
  );
}
