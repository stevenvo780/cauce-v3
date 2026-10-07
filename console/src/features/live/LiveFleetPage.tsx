import { Menu } from '@base-ui/react/menu';
import { Check, ChevronDown, Pause, RefreshCw, Timer } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ErrorState, LoadingState } from '../../components/ui';
import { PageHelp } from '../../components/PageHelp';
import { cn } from '../../cn';
import { redirect, useRouteSearch } from '../../router';
import { useFleet } from '../../shell/fleet-context';
import { STATE_TONE, TONE_CLASS } from '../../status-tone';
import { MENU_ITEM, MENU_POPUP } from '../../components/kit';
import { OfficeCanvas, type OfficeAgent } from '../office/OfficeCanvas';
import { ORDEN_VIVO } from './activity';
import { AgentSheet } from './AgentSheet';
import {
  BURST_MS, LIVE_STATE_META, buildLiveViews, detectPulses, fleetVerdict, humanSeconds, rememberFleet, stateTally,
  type FleetMemory, type LiveState, type PulseMap,
} from './agent-state';
import { FleetActivityTable } from './FleetActivityTable';
import { projectLiveFleet } from './live-projection';

/** Three missed reads and the picture stops proving anything; never less than this window. */
const STALE_AFTER_MS = 15_000;
const PROBLEMS: ReadonlySet<LiveState> = new Set(['down', 'blocked']);
/** Poll periods the operator can pick; 0 pauses the shared activity poll. */
const REFRESH_OPTIONS = [
  { ms: 2_000, label: '2 s' },
  { ms: 5_000, label: '5 s' },
  { ms: 15_000, label: '15 s' },
  { ms: 0, label: 'En pausa' },
] as const;

function usePulses(snapshot: ReturnType<typeof projectLiveFleet>['snapshot']): PulseMap {
  const memory = useRef<FleetMemory>({});
  const [pulses, setPulses] = useState<PulseMap>({});
  useEffect(() => {
    if (!snapshot) return;
    const at = Date.now();
    const fresh = detectPulses(memory.current, snapshot, at);
    memory.current = rememberFleet(snapshot, at);
    setPulses((current) => {
      const merged: PulseMap = {};
      for (const [key, list] of Object.entries(current)) {
        const alive = list.filter((pulse) => at - pulse.atMs < BURST_MS);
        if (alive.length > 0) merged[key] = alive;
      }
      for (const [key, list] of Object.entries(fresh)) merged[key] = [...(merged[key] ?? []), ...list];
      return merged;
    });
  }, [snapshot]);
  return pulses;
}

function RefreshInterval({ value, onChange }: { value: number; onChange: (ms: number) => void }) {
  const current = REFRESH_OPTIONS.find((option) => option.ms === value);
  const text = current ? (current.ms === 0 ? current.label : `Cada ${current.label}`) : `Cada ${String(value / 1000)} s`;
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={`Frecuencia de lectura: ${text.toLowerCase()}`}
        title="Cada cuánto se lee la flota"
        className={cn(
          'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border bg-surface px-2 text-xs hover:bg-subtle data-[popup-open]:bg-subtle',
          value === 0 ? 'border-warn/40 text-warn-ink' : 'border-line text-fg-2',
        )}
      >
        {value === 0 ? <Pause size={13} aria-hidden="true" /> : <Timer size={13} aria-hidden="true" />}
        {text}
        <ChevronDown size={12} aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={6} className="z-50">
          <Menu.Popup className={cn(MENU_POPUP, 'w-44')}>
            <Menu.Group>
              <Menu.GroupLabel className="px-2.5 py-1 text-[11px] font-medium text-muted">Leer la flota</Menu.GroupLabel>
              <Menu.RadioGroup value={String(value)} onValueChange={(next: string) => { onChange(Number(next)); }}>
                {REFRESH_OPTIONS.map((option) => (
                  <Menu.RadioItem key={option.ms} value={String(option.ms)} closeOnClick className={MENU_ITEM}>
                    <span className="grid size-[15px] place-items-center">
                      <Menu.RadioItemIndicator><Check size={14} aria-hidden="true" /></Menu.RadioItemIndicator>
                    </span>
                    {option.ms === 0 ? option.label : `Cada ${option.label}`}
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { window.clearInterval(timer); };
  }, []);
  return now;
}

export function LiveFleetPage() {
  const fleet = useFleet();
  const { activity, topology, activityIntervalMs } = fleet;
  const staleAfterMs = activityIntervalMs === 0 ? STALE_AFTER_MS : Math.max(STALE_AFTER_MS, activityIntervalMs * 3);
  const now = useNow();
  const search = useRouteSearch();
  const selectedKey = new URLSearchParams(search).get('agente');
  const [filter, setFilter] = useState<ReadonlySet<LiveState>>(new Set());

  const { snapshot } = useMemo(() => projectLiveFleet(activity.data, topology.data), [activity.data, topology.data]);
  const pulses = usePulses(snapshot);

  const views = useMemo(() => {
    const visible = new Set((snapshot?.agents ?? []).map((agent) => `${agent.tenant_id}/${agent.alias}`));
    return buildLiveViews(activity.data, pulses, now).views.filter((view) => visible.has(view.key));
  }, [activity.data, snapshot, pulses, now]);

  const tally = useMemo(() => stateTally(views), [views]);
  const estados = useMemo(() => new Map(views.map((view) => [view.key, view.state])), [views]);
  const observedAt = snapshot?.observed_at ?? undefined;
  const verdict = useMemo(
    () => fleetVerdict(views, { error: activity.error, observedAt, nowMs: now, staleAfterMs }),
    [views, activity.error, observedAt, now, staleAfterMs],
  );

  const highlight = useMemo(
    () => (filter.size === 0 ? null : new Set(views.filter((view) => filter.has(view.state)).map((view) => view.key))),
    [views, filter],
  );

  const officeAgents = useMemo<OfficeAgent[]>(() => views.map((view) => ({
    id: view.key, name: view.alias, state: view.state, reason: view.reason, delegatesTo: view.delegatesTo,
  })), [views]);

  const select = (key: string) => { redirect(`/live?agente=${encodeURIComponent(key)}`); };
  const close = () => { redirect('/live'); };
  const toggle = (state: LiveState) => {
    setFilter((current) => {
      const next = new Set(current);
      if (next.has(state)) next.delete(state); else next.add(state);
      return next;
    });
  };

  if (activity.error && !activity.data) {
    return (
      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        <ErrorState error={activity.error} onRetry={() => { void activity.reload(); }} reintentando={activity.loading} />
      </div>
    );
  }
  if (!snapshot) {
    return <div className="flex-1 overflow-y-auto p-4 sm:p-6"><LoadingState label="Leyendo la actividad de la flota…" /></div>;
  }

  const problems = tally.down + tally.blocked;
  const connected = views.length - tally.down;
  const unknown = verdict.tone === 'desconocido';
  const age = observedAt ? Math.max(0, (now - Date.parse(observedAt)) / 1000) : null;
  const selected = views.find((view) => view.key === selectedKey) ?? null;
  const summary = `Oficina con ${String(views.length)} agentes: ${ORDEN_VIVO
    .filter((state) => tally[state] > 0)
    .map((state) => `${String(tally[state])} ${LIVE_STATE_META[state].label.toLowerCase()}`)
    .join(', ')}. Flechas para recorrerlos y Enter para abrir uno; WASD mueve la vista, + y − acercan, 0 muestra todo y P activa el modo paseo.`;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1680px] flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8 lg:py-6">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-1.5">
            <h1 className="m-0 text-[22px] font-semibold tracking-tight text-fg">Oficina</h1>
            <PageHelp
              title="Oficina"
              description="Cada persona es un agente de la flota. Trabaja en su escritorio, se va a dormir a la zona de descanso cuando no tiene nada, lleva papeles al escritorio de otro cuando le delega y levanta un «!» cuando se traba. El estado sale del trabajo que avanza (o no), no del latido. Vos también estás: arrastrá para mirar, acercá con la rueda o pellizcando y tocá el piso para caminar hasta alguien."
            >
              <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                {ORDEN_VIVO.map((state) => (
                  <div key={state} className="contents">
                    <dt className={cn('font-medium', TONE_CLASS[STATE_TONE[state]].ink)}>{LIVE_STATE_META[state].label}</dt>
                    <dd className="m-0">{LIVE_STATE_META[state].hint}</dd>
                  </div>
                ))}
              </dl>
            </PageHelp>
          </div>
          <p
            className="m-0 flex min-w-0 items-center gap-2 text-[13px]"
            role="status"
            aria-label="Veredicto de la flota"
            data-tone={verdict.tone}
          >
            <span
              aria-hidden="true"
              className={cn('size-2 shrink-0 rounded-full', unknown ? 'bg-warn' : problems > 0 ? 'bg-danger' : 'bg-ok')}
            />
            {unknown ? (
              <span className="text-warn-ink" title={verdict.apoyo}>{verdict.frase}</span>
            ) : problems > 0 ? (
              <span className="text-fg-2">
                <button
                  type="button"
                  className="cursor-pointer border-0 bg-transparent p-0 font-medium text-danger-ink underline-offset-2 hover:underline"
                  title={verdict.culpables.map((culprit) => `${culprit.alias}: ${culprit.motivo}`).join('\n')}
                  onClick={() => { setFilter(new Set(PROBLEMS)); }}
                >
                  {problems} {problems === 1 ? 'necesita' : 'necesitan'} atención
                </button>
                {' · '}{connected} {connected === 1 ? 'conectado' : 'conectados'}
              </span>
            ) : (
              <span className="text-fg-2">Todo en orden · {connected} {connected === 1 ? 'conectado' : 'conectados'}</span>
            )}
          </p>
          <div className="ml-auto flex items-center gap-2 text-xs text-muted">
            <span className="hidden tabular-nums sm:inline">
              {age === null ? 'sin lectura' : `hace ${humanSeconds(age)}`}
            </span>
            <RefreshInterval value={activityIntervalMs} onChange={fleet.setActivityIntervalMs} />
            <button
              type="button"
              onClick={fleet.reload}
              aria-label="Actualizar ahora"
              title="Actualizar ahora"
              className="grid size-8 cursor-pointer place-items-center rounded-md border border-line bg-surface text-fg-2 hover:bg-subtle"
            >
              <RefreshCw size={14} aria-hidden="true" className={activity.loading ? 'animate-spin' : undefined} />
            </button>
          </div>
        </header>

        <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-0.5 sm:mx-0 sm:flex-wrap sm:px-0" role="group" aria-label="Filtrar por estado">
          {ORDEN_VIVO.filter((state) => tally[state] > 0).map((state) => {
            const on = filter.has(state);
            const tone = TONE_CLASS[STATE_TONE[state]];
            return (
              <button
                key={state}
                type="button"
                aria-pressed={on}
                title={LIVE_STATE_META[state].hint}
                onClick={() => { toggle(state); }}
                className={cn(
                  'inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors',
                  on ? cn('border-transparent', tone.pill) : 'border-line bg-surface text-fg-2 hover:bg-subtle',
                )}
              >
                <span aria-hidden="true" className={cn('size-1.5 rounded-full', tone.dot)} />
                {LIVE_STATE_META[state].label}
                <span className="tabular-nums opacity-70">{tally[state]}</span>
              </button>
            );
          })}
          {filter.size > 0 ? (
            <button
              type="button"
              onClick={() => { setFilter(new Set()); }}
              className="h-7 shrink-0 cursor-pointer rounded-full border-0 bg-transparent px-2 text-xs text-muted hover:text-fg"
            >
              Quitar filtro
            </button>
          ) : null}
        </div>

        <section
          aria-label="Oficina"
          data-objeto-principal="oficina"
          className="-mx-4 overflow-hidden border-y border-line bg-subtle sm:mx-0 sm:rounded-xl sm:border sm:shadow-card"
        >
          {views.length === 0 ? (
            <p className="m-0 p-8 text-center text-[13px] text-muted">
              No hay ningún agente en la oficina: ni configurado, ni con entregas abiertas, ni con lease reciente.
            </p>
          ) : (
            <OfficeCanvas
              agents={officeAgents}
              selectedId={selected?.key ?? null}
              highlight={highlight}
              onSelect={select}
              label={summary}
            />
          )}
        </section>

        <FleetActivityTable
          snapshot={snapshot}
          estados={estados}
          only={highlight}
          selectedKey={selected?.key ?? null}
          onOpen={select}
        />
      </div>

      <AgentSheet view={selected} status={fleet.status} onClose={close} />
    </div>
  );
}
