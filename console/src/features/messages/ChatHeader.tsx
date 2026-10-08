import { Dialog } from '@base-ui/react/dialog';
import { Menu } from '@base-ui/react/menu';
import { ArrowLeft, Check, Info, MoreHorizontal, RefreshCw, X } from 'lucide-react';
import { useState, type ReactNode, type RefObject } from 'react';
import type { JobLane } from '../../api/types';
import { AgentOrb } from '../../components/AgentOrb';
import { DesktopAlertsItem } from '../../shell/DesktopAlertsItem';
import { AgentActionItems, AgentContextMenu } from '../../components/agent-actions/AgentActionsMenu';
import { cn } from '../../cn';
import { Time } from '../../components/ui';
import { onNavClick } from '../../router';
import { LEASE_LABEL } from '../../vocabulario';
import { LIVE_STATE_META, type LiveState } from '../live/agent-state';
import { MENU_ITEM, MENU_POPUP, StatePill } from '../../components/kit';
import { LIMITE_MENSAJES, textoDeCifra, type SaludDeCola } from './queue-health';
import type { AgenteDeMensajeria } from './roster';

const LANES: { value: JobLane; label: string }[] = [
  { value: 'interactive', label: 'Interactivo · prioridad 10' },
  { value: 'batch', label: 'Batch · prioridad 0' },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-2">
      <h3 className="m-0 text-[11px] font-medium tracking-wide text-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

export function ChatHeader({ agent, state, reason, salud, lane, sending, loading, roomId, totalVisible, receipt, moreTriggerRef, onLaneChange, onReload }: {
  agent: AgenteDeMensajeria;
  state: LiveState;
  reason?: string;
  salud?: SaludDeCola;
  lane: JobLane;
  sending: boolean;
  loading: boolean;
  roomId: string;
  totalVisible: number;
  /** The last accepted publish, kept out of the composer: acceptance proves neither reading nor execution. */
  receipt?: string;
  moreTriggerRef: RefObject<HTMLButtonElement | null>;
  onLaneChange: (lane: JobLane) => void;
  onReload: () => void;
}) {
  const [infoOpen, setInfoOpen] = useState(false);
  const meta = LIVE_STATE_META[state];
  const attention = (salud?.muertas ?? 0) > 0 || (salud?.reintentos ?? 0) > 0;

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-2 min-[761px]:px-4">
      <a href="/messages" onClick={(event) => { onNavClick(event, '/messages'); }} aria-label="Volver a los agentes"
        className="grid size-9 shrink-0 place-items-center rounded-md text-fg-2 hover:bg-subtle min-[761px]:hidden">
        <ArrowLeft size={20} aria-hidden="true" />
      </a>
      <AgentContextMenu agent={agent} omit={['chat']} className="flex min-w-0 flex-1 items-center gap-2">
        <AgentOrb seed={`${agent.tenantId}/${agent.alias}`} state={state} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2 tabIndex={-1} className="m-0 truncate text-[15px] font-semibold tracking-tight outline-none">{agent.alias}</h2>
            <StatePill state={state} title={`${reason ?? meta.hint} · Lease: ${LEASE_LABEL[agent.leaseState]}`} data-live-state={state} />
          </div>
          <p className="m-0 truncate text-xs text-muted">{agent.tenantId}</p>
        </div>
      </AgentContextMenu>

      <Menu.Root>
        <Menu.Trigger ref={moreTriggerRef} aria-label="Opciones de la conversación" title="Opciones de la conversación"
          className="grid size-9 shrink-0 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-fg-2 hover:bg-subtle hover:text-fg data-[popup-open]:bg-subtle">
          <MoreHorizontal size={18} aria-hidden="true" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner sideOffset={6} align="end" className="z-50">
            <Menu.Popup className={cn(MENU_POPUP, 'menu-pop w-64')}>
              <AgentActionItems agent={agent} omit={['chat']} header={false} />
              <Menu.Separator className="my-1 h-px bg-line" />
              <Menu.Item className={MENU_ITEM} disabled={loading} onClick={onReload}>
                <RefreshCw size={15} aria-hidden="true" className="text-muted" />Sincronizar
              </Menu.Item>
              <DesktopAlertsItem />
              <Menu.Separator className="my-1 h-px bg-line" />
              <Menu.Group>
                <Menu.GroupLabel className="px-2.5 py-1 text-[11px] font-medium text-muted">Carril de envío</Menu.GroupLabel>
                <Menu.RadioGroup value={lane} onValueChange={(value: JobLane) => { onLaneChange(value === 'batch' ? 'batch' : 'interactive'); }}>
                  {LANES.map((option) => (
                    <Menu.RadioItem key={option.value} value={option.value} disabled={sending} closeOnClick className={MENU_ITEM}>
                      <span className="grid size-[15px] place-items-center">
                        <Menu.RadioItemIndicator><Check size={14} aria-hidden="true" /></Menu.RadioItemIndicator>
                      </span>
                      {option.label}
                    </Menu.RadioItem>
                  ))}
                </Menu.RadioGroup>
              </Menu.Group>
              <Menu.Separator className="my-1 h-px bg-line" />
              <Menu.Item className={MENU_ITEM} onClick={() => { setInfoOpen(true); }}>
                <Info size={15} aria-hidden="true" className="text-muted" />Detalles de la conversación
                {attention ? <span className="ml-auto size-2 rounded-full bg-danger" aria-label="Hay entregas que necesitan atención" /> : null}
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>

      <Dialog.Root open={infoOpen} onOpenChange={setInfoOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-40 bg-scrim" />
          <Dialog.Popup finalFocus={moreTriggerRef}
            className="fixed inset-y-0 right-0 z-50 grid w-[min(100vw,400px)] content-start gap-6 overflow-y-auto border-l border-line bg-surface p-5 text-[13px] text-fg shadow-pop outline-none">
            <div className="flex items-center justify-between gap-3">
              <Dialog.Title className="m-0 text-[15px] font-semibold">Detalles de la conversación</Dialog.Title>
              <Dialog.Close aria-label="Cerrar detalles" className="grid size-8 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-muted hover:bg-subtle hover:text-fg">
                <X size={16} aria-hidden="true" />
              </Dialog.Close>
            </div>
            <Section title="Estado del agente">
              <p className="m-0 flex items-center gap-2">
                <StatePill state={state} />
                <span className="text-fg-2">{reason ?? meta.hint}</span>
              </p>
              <p className="m-0 text-fg-2">
                Lease {LEASE_LABEL[agent.leaseState]} · epoch {agent.presence?.epoch ?? 'UNKNOWN'} · vence <Time value={agent.presence?.lease_expires_at ?? agent.presence?.lease_until} />
              </p>
            </Section>
            <Section title="Envío">
              <p className="m-0 text-fg-2" data-room-origin>Room de origen: <span className="font-mono">{roomId || 'UNKNOWN'}</span> · derivado de tu topología, no escrito a mano.</p>
              <p className="m-0 text-fg-2">Carril: {LANES.find((option) => option.value === lane)?.label}</p>
            </Section>
            <Section title="Cola">
              <dl className="m-0 grid grid-cols-4 gap-px overflow-hidden rounded-lg border border-line bg-line" aria-label={`Cola de ${agent.alias}`} data-queue-strip>
                {([
                  ['En cola', textoDeCifra(salud?.pendientes), false],
                  ['En curso', textoDeCifra(salud?.enCurso), false],
                  ['Reintentos', textoDeCifra(salud?.reintentos), (salud?.reintentos ?? 0) > 0],
                  ['Muertas', `${salud?.muertasTruncadas && salud.muertas !== undefined ? '≥ ' : ''}${textoDeCifra(salud?.muertas)}`, (salud?.muertas ?? 0) > 0],
                ] as const).map(([label, value, alarm]) => (
                  <div key={label} className="bg-surface px-2.5 py-2">
                    <dt className="text-[11px] text-muted">{label}</dt>
                    <dd className={cn('m-0 text-[15px] font-semibold tabular-nums', alarm && 'text-danger-ink')}>{value}</dd>
                  </div>
                ))}
              </dl>
              <p className="m-0 text-xs text-muted">Hilo filtrado sobre los {totalVisible} mensajes que el servidor publica para tu identidad (tope {LIMITE_MENSAJES}, sin filtro por par).</p>
            </Section>
            {receipt ? (
              <Section title="Recibo del último envío">
                <p className="m-0 rounded-md bg-ok-soft px-3 py-2 text-ok-ink">{receipt}</p>
                <p className="m-0 text-xs text-muted">La publicación durable no demuestra lectura ni ejecución. El estado actual aparece junto al mensaje.</p>
              </Section>
            ) : null}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </header>
  );
}
