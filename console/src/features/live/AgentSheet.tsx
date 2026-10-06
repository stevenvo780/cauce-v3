import { Dialog } from '@base-ui/react/dialog';
import { Tabs } from '@base-ui/react/tabs';
import { FileText, MessageSquare, SquareTerminal, X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { FleetActivityItem, SystemStatus } from '../../api/types';
import type { Resource } from '../../api/use-resource';
import { AgentOrb } from '../../components/AgentOrb';
import { Badge, Time, Unknown } from '../../components/ui';
import { cn } from '../../cn';
import { UNKNOWN, compactId, safeJobLane } from '../../lib';
import { onNavClick } from '../../router';
import { useMediaQuery } from '../../shell/use-media-query';
import { STATE_TONE, TONE_CLASS } from '../../status-tone';
import { queueDeliveryPath } from '../deliveries/delivery-links';
import { deliveryPolicy } from '../deliveries/delivery-policy';
import { FLAG_LABEL } from './activity';
import { LIVE_STATE_META, aliasDe, humanSeconds, type LiveAgentView, type OrigenEncargo } from './agent-state';

/**
 * Read-only by design: the office refreshes every few seconds, so a destructive button here could
 * hit a row that just moved. Each delivery links to Queues, where retry and cancel live with their
 * own confirmation.
 */
export function AgentSheet({ view, status, onClose }: {
  view: LiveAgentView | null;
  status: Resource<SystemStatus>;
  onClose: () => void;
}) {
  const desktop = useMediaQuery('(min-width: 761px)');
  return (
    <Dialog.Root open={view !== null} onOpenChange={(open) => { if (!open) onClose(); }} modal={desktop ? false : true}>
      <Dialog.Portal>
        {desktop ? null : <Dialog.Backdrop className="fixed inset-0 z-40 bg-scrim" />}
        <Dialog.Popup
          className={cn(
            'fixed z-50 flex flex-col overflow-hidden border-line bg-surface shadow-pop outline-none',
            'inset-x-0 bottom-0 max-h-[85dvh] rounded-t-2xl border-t',
            'min-[761px]:inset-x-auto min-[761px]:top-3 min-[761px]:right-3 min-[761px]:bottom-3 min-[761px]:max-h-none min-[761px]:w-[400px] min-[761px]:rounded-xl min-[761px]:border',
          )}
        >
          {view ? <SheetBody view={view} status={status} /> : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SheetBody({ view, status }: { view: LiveAgentView; status: Resource<SystemStatus> }) {
  const tone = TONE_CLASS[STATE_TONE[view.state]];
  const tenant = encodeURIComponent(view.tenantId);
  const alias = encodeURIComponent(view.alias);
  const items = view.agent.in_flight_items ?? [];
  const links = [
    { href: `/messages/${tenant}/${alias}`, label: 'Abrir chat', icon: MessageSquare, primary: true },
    { href: `/terminal/${tenant}/${alias}`, label: 'Abrir terminal', icon: SquareTerminal, primary: false },
    { href: `/messages/${tenant}/${alias}?view=context`, label: 'Perfil y contexto', icon: FileText, primary: false },
  ];
  return (
    <>
      <header className="flex items-start gap-3 border-b border-line p-4">
        <AgentOrb seed={`${view.tenantId}/${view.alias}`} state={view.state} size={40} />
        <div className="min-w-0 flex-1">
          <Dialog.Title className="m-0 truncate text-base font-semibold text-fg">{view.alias}</Dialog.Title>
          <p className="m-0 truncate text-xs text-muted">
            {view.tenantId}{view.displayName && view.displayName !== view.alias ? ` · ${view.displayName}` : ''}
            {view.harnessId ? ` · ${view.harnessId}` : ''}
          </p>
          <span className={cn('mt-1.5 inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-[11px] font-medium', tone.pill)}>
            <span aria-hidden="true" className={cn('size-1.5 rounded-full', tone.dot)} />
            {LIVE_STATE_META[view.state].label}
            {view.overloaded ? ' · saturado' : ''}
          </span>
        </div>
        <Dialog.Close aria-label="Cerrar el detalle" className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-muted hover:bg-subtle hover:text-fg">
          <X size={16} aria-hidden="true" />
        </Dialog.Close>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <Dialog.Description className="m-0 text-[13px] leading-relaxed text-fg-2">{view.reason}</Dialog.Description>

        <dl className="mt-4 grid grid-cols-3 gap-2">
          <Stat label="En vuelo" value={String(view.inFlight)} />
          <Stat label="En cola" value={String(view.queued)} />
          <Stat label="Más antigua" value={typeof view.oldestInFlightSeconds === 'number' ? humanSeconds(view.oldestInFlightSeconds) : '—'} />
        </dl>

        <div className="mt-4 grid gap-2">
          {links.map(({ href, label, icon: Icon, primary }) => (
            <a
              key={label}
              href={href}
              onClick={(event) => { onNavClick(event, href); }}
              className={cn(
                'inline-flex h-9 items-center justify-center gap-2 rounded-md text-[13px] font-medium no-underline transition-colors',
                primary ? 'bg-brand text-on-brand hover:bg-brand-hover' : 'border border-line bg-surface text-fg hover:bg-subtle',
              )}
            >
              <Icon size={15} aria-hidden="true" /> {label}
            </a>
          ))}
        </div>

        <Tabs.Root defaultValue="ahora" className="mt-5">
          <Tabs.List aria-label="Secciones del detalle" className="flex gap-1 border-b border-line">
            {[['ahora', 'Ahora'], ['conexion', 'Conexión'], ['entregas', `Entregas · ${String(items.length)}`]].map(([value, label]) => (
              <Tabs.Tab
                key={value}
                value={value}
                className="-mb-px cursor-pointer border-0 border-b-2 border-transparent bg-transparent px-2.5 py-2 text-[13px] font-medium text-muted hover:text-fg data-[active]:border-brand data-[active]:text-fg"
              >
                {label}
              </Tabs.Tab>
            ))}
          </Tabs.List>
          <Tabs.Panel value="ahora" className="pt-3"><Now view={view} /></Tabs.Panel>
          <Tabs.Panel value="conexion" className="pt-3"><Connection view={view} status={status} /></Tabs.Panel>
          <Tabs.Panel value="entregas" className="pt-3"><Deliveries view={view} items={items} /></Tabs.Panel>
        </Tabs.Root>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-subtle px-3 py-2">
      <dt className="text-[11px] text-muted">{label}</dt>
      <dd className="m-0 text-base font-semibold tabular-nums text-fg">{value}</dd>
    </div>
  );
}

function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="m-0 grid grid-cols-[minmax(0,9rem)_1fr] gap-x-3 gap-y-2 text-[13px]">
      {rows.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-muted">{term}</dt>
          <dd className="m-0 min-w-0 break-words text-fg">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const none = (text: string) => <span className="text-muted">{text}</span>;

function Now({ view }: { view: LiveAgentView }) {
  return (
    <Rows rows={[
      ['Último ACK', view.secondsSinceLastAck === null || view.secondsSinceLastAck === undefined
        ? none('sin ACK dentro de la ventana de búsqueda')
        : `hace ${humanSeconds(view.secondsSinceLastAck)}`],
      ['Delega a', view.delegatesTo.length > 0 ? view.delegatesTo.map(aliasDe).join(', ') : none('nadie ahora mismo')],
      ['Trabaja para', view.delegatedFrom.length > 0 ? view.delegatedFrom.map(aliasDe).join(', ') : none('nadie ahora mismo')],
      ['Cerradas en 24 h', view.closed24h === undefined ? none('sin dato') : String(view.closed24h)],
      ['Señales', view.flags.length > 0
        ? view.flags.map((flag) => FLAG_LABEL[flag as keyof typeof FLAG_LABEL] ?? flag).join(' · ')
        : none('ninguna')],
    ]} />
  );
}

function Connection({ view, status }: { view: LiveAgentView; status: Resource<SystemStatus> }) {
  const presence = view.agent.presence;
  const capabilities = status.data?.presence
    ?.find((lease) => lease.tenant_id === view.tenantId && lease.alias === view.alias)?.capabilities;
  return (
    <Rows rows={[
      ['Epoch', <span className="font-mono text-xs" key="e"><Unknown value={presence?.epoch} /></span>],
      ['Instancia', <span className="font-mono text-xs" key="i"><Unknown value={presence?.instance_id} /></span>],
      ['Último latido', <Time value={presence?.last_heartbeat_at} key="h" />],
      ['Lease vence', <Time value={presence?.lease_until} key="l" />],
      ['Salas', view.rooms.length > 0 ? view.rooms.join(', ') : none('el servidor no informa las salas')],
      ['Habilitado', <Unknown value={view.agent.agent_enabled} key="en" />],
      ['En el registro', view.agent.registered === false
        ? none('no: apareció por entregas o por lease')
        : <Unknown value={view.agent.registered} key="r" />],
      ['Capacidades', status.error && !status.data
        ? none(`no se pudo leer /v3/status: ${status.error.message}`)
        : capabilities?.length ? capabilities.join(', ') : none('sin dato')],
    ]} />
  );
}

function Deliveries({ view, items }: { view: LiveAgentView; items: FleetActivityItem[] }) {
  if (items.length === 0) return <p className="m-0 text-[13px] text-muted">Ninguna entrega en vuelo.</p>;
  return (
    <ul className="m-0 grid list-none gap-2 p-0">
      {items.map((item, index) => {
        const policy = deliveryPolicy(item.status);
        const queuePath = queueDeliveryPath(item.delivery_id);
        return (
          <li key={item.delivery_id ?? index} className="rounded-lg border border-line p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="font-mono text-xs text-fg-2">{compactId(item.delivery_id)}</span>
              <Badge tone={policy.tone}>
                <Unknown
                  value={policy.known ? policy.label : undefined}
                  motivo={item.status && !policy.known ? `El servidor mandó un estado que esta consola no conoce: ${item.status}` : undefined}
                />
              </Badge>
            </div>
            <Rows rows={[
              ['Se lo pidió', origin(view.origenes[index])],
              ['Carril', <Unknown value={safeJobLane(item.lane)} key="c" />],
              ['Intento', <Unknown value={item.attempt} key="a" />],
              ['Deadline de ACK', <Time value={item.ack_deadline_at} key="d" />],
            ]} />
            {queuePath ? (
              <a
                href={queuePath}
                onClick={(event) => { onNavClick(event, queuePath); }}
                className="mt-2 inline-block text-xs font-medium text-brand-ink"
              >
                Ver en Colas
              </a>
            ) : null}
          </li>
        );
      })}
      {view.agent.in_flight_items_truncated ? (
        <li className="text-xs text-muted">Se muestran las {items.length} más antiguas de {view.inFlight}.</li>
      ) : null}
    </ul>
  );
}

function origin(source: OrigenEncargo | undefined): string {
  if (!source || source.tipo === 'desconocido') return UNKNOWN;
  if (source.tipo === 'puente') return `una persona, por ${source.adapter}`;
  const where = source.tenant ? ` (${source.tenant})` : '';
  return source.tipo === 'agente'
    ? `${source.alias}${where}, otro agente`
    : `${source.alias}${where}, que no es un alias de la flota`;
}
