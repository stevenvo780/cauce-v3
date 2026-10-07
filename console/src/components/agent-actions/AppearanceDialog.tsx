import { Dialog } from '@base-ui/react/dialog';
import { Toggle } from '@base-ui/react/toggle';
import { ToggleGroup } from '@base-ui/react/toggle-group';
import { Minus, Plus, RotateCcw, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { useOptionalConsoleAccess } from '../../api/console-access';
import {
  AGENT_APPEARANCE_STYLES, appearanceDraftProblem, isAgentGlyph, isRevisionConflict,
  type AgentAppearanceStyle, type AppearanceDraft,
} from '../../api/client/agent-preferences-client';
import { cn } from '../../cn';
import type { LiveState } from '../../features/live/agent-state';
import { BOTTOM_BAR_VIEWPORT } from '../../breakpoints';
import { permissionState } from '../../lib';
import { useMediaQuery } from '../../shell/use-media-query';
import { orbHues } from '../../orb-hues';
import { OrbView, type OrbLook } from '../AgentOrb';
import { Button, Notice } from '../kit';
import { APPEARANCE_DENIED_REASON, APPEARANCE_GLYPHS, agentKey, type AgentRef } from './agent-actions';
import { useAgentPreferences } from './preferences-context';

const HUES = [0, 30, 55, 90, 140, 175, 200, 225, 255, 280, 310, 335] as const;

const STYLE_LABEL: Record<AgentAppearanceStyle, string> = { orb: 'Orbe', aurora: 'Aurora', pulse: 'Pulso', pixel: 'Píxel' };
const STYLE_HINT: Record<AgentAppearanceStyle, string> = {
  orb: 'El degradé que gira', aurora: 'Cintas de luz boreal', pulse: 'Ondas concéntricas', pixel: 'Un bichito de 8 bits',
};
const PREVIEW_STATES: { state: LiveState; label: string }[] = [
  { state: 'idle', label: 'Reposo' }, { state: 'thinking', label: 'Trabajando' }, { state: 'down', label: 'Caído' },
];

const DEFAULT_DRAFT: AppearanceDraft = { glyph: null, hue: null, style: 'orb' };

function sameDraft(a: AppearanceDraft, b: AppearanceDraft): boolean {
  return a.glyph === b.glyph && a.hue === b.hue && a.style === b.style;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0">
      <legend className="mb-2 p-0 text-[13px] font-medium text-fg">
        {label}{hint ? <span className="ml-1.5 font-normal text-muted">{hint}</span> : null}
      </legend>
      {children}
    </fieldset>
  );
}

const NUDGE = 'grid size-7 cursor-pointer place-items-center rounded-md border border-line bg-surface text-fg-2 hover:bg-subtle pointer-coarse:size-11';

const CHIP = 'grid cursor-pointer place-items-center rounded-lg border border-transparent bg-transparent transition-[transform,background-color] hover:bg-subtle active:scale-90 aria-pressed:border-brand aria-pressed:bg-brand-soft';

type CloseGuard = RefObject<() => boolean>;

function Editor({ agent, guard, onClose }: { agent: AgentRef; guard: CloseGuard; onClose: () => void }) {
  const preferences = useAgentPreferences();
  const access = useOptionalConsoleAccess();
  const phone = useMediaQuery(BOTTOM_BAR_VIEWPORT);
  const permission = permissionState(access?.error ? undefined : access?.data, 'config.write');
  const key = agentKey(agent);
  const saved = preferences?.appearances.get(key);
  const savedDraft: AppearanceDraft = saved ? { glyph: saved.glyph, hue: saved.hue, style: saved.style } : DEFAULT_DRAFT;
  const [draft, setDraft] = useState<AppearanceDraft>(savedDraft);
  const [glyphText, setGlyphText] = useState(saved?.glyph ?? '');
  const [busy, setBusy] = useState<'save' | 'reset'>();
  const [confirm, setConfirm] = useState<'discard' | 'reset'>();
  const [outcome, setOutcome] = useState<{ tone: 'danger' | 'warn'; text: string }>();
  const [previewState, setPreviewState] = useState<LiveState>('idle');
  const safeChoice = useRef<HTMLButtonElement>(null);

  const seededHue = orbHues(key)[0];
  const hue = draft.hue ?? seededHue;
  const problem = appearanceDraftProblem(draft);
  const look: OrbLook = { glyph: draft.glyph !== null && isAgentGlyph(draft.glyph) ? draft.glyph : null, hue: draft.hue, style: draft.style };
  const dirty = !sameDraft(draft, savedDraft);
  const canWrite = permission === 'allowed' && preferences !== null;
  const initial = Array.from(agent.alias)[0]?.toLocaleUpperCase();

  const requestClose = (): boolean => {
    if (busy !== undefined) return false;
    if (!dirty || confirm === 'discard') return true;
    setConfirm('discard');
    return false;
  };
  useLayoutEffect(() => { guard.current = requestClose; });
  useEffect(() => { if (confirm) safeChoice.current?.focus(); }, [confirm]);

  const update = (patch: Partial<AppearanceDraft>) => { setDraft((current) => ({ ...current, ...patch })); setOutcome(undefined); setConfirm(undefined); };
  const pickGlyph = (glyph: string | null) => { setGlyphText(glyph ?? ''); update({ glyph }); };
  const nudge = (delta: number) => { update({ hue: (((hue + delta) % 360) + 360) % 360 }); };

  async function run(kind: 'save' | 'reset') {
    if (!preferences) return;
    setBusy(kind);
    setConfirm(undefined);
    setOutcome(undefined);
    try {
      if (kind === 'save') {
        await preferences.saveAppearance(agent, draft);
        preferences.notify(`Listo: ${agent.alias} estrena look.`);
      } else {
        await preferences.resetAppearance(agent);
        preferences.notify(`${agent.alias} volvió a su orbe de siempre.`);
      }
      onClose();
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'el servidor no contestó';
      setOutcome(isRevisionConflict(error)
        ? { tone: 'warn', text: 'Otra persona cambió este icono mientras lo editabas. Cargamos su versión (la ves como «En el servidor»); tu borrador sigue acá y podés guardarlo encima.' }
        : { tone: 'danger', text: kind === 'save' ? `No se guardó: ${detail}` : `No se restableció: ${detail}` });
    } finally {
      setBusy(undefined);
    }
  }

  const gate = permission === 'denied'
    ? `${APPEARANCE_DENIED_REASON} Podés probar combinaciones, pero no guardarlas.`
    : permission === 'unknown'
      ? 'No se pudo acreditar config.write: podés probar combinaciones, pero Guardar queda apagado hasta que el servidor confirme el permiso.'
      : undefined;

  return (
    <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] min-[761px]:grid-cols-[220px_minmax(0,1fr)] min-[761px]:grid-rows-[minmax(0,1fr)_auto]">
      <div className="flex min-h-0 items-center gap-4 border-b border-line bg-[radial-gradient(circle_at_50%_30%,var(--c-brand-soft),transparent_70%)] px-4 py-3 min-[761px]:grid min-[761px]:content-start min-[761px]:justify-items-center min-[761px]:overflow-y-auto min-[761px]:border-r min-[761px]:border-b-0 min-[761px]:p-5">
        <div className="grid size-20 shrink-0 place-items-center min-[761px]:size-32">
          <OrbView seed={key} look={look} state={previewState} size={phone ? 64 : 96} label={`Vista previa del icono de ${agent.alias}`} />
        </div>
        <div className="grid min-w-0 gap-2 min-[761px]:w-full min-[761px]:justify-items-center min-[761px]:gap-4">
          <div className="flex w-fit gap-1 rounded-lg bg-muted-bg p-0.5" role="group" aria-label="Probar con el estado">
            {PREVIEW_STATES.map((option) => (
              <button key={option.state} type="button" aria-pressed={previewState === option.state} onClick={() => { setPreviewState(option.state); }}
                className="h-6 cursor-pointer rounded-md border-0 bg-transparent px-2 text-[11px] font-medium whitespace-nowrap text-muted aria-pressed:bg-surface aria-pressed:text-fg aria-pressed:shadow-card pointer-coarse:h-8">
                {option.label}
              </button>
            ))}
          </div>
          <div className="grid w-full gap-2 text-xs max-[760px]:hidden" aria-label="Así se verá" role="group">
            <div className="flex items-center gap-2 rounded-lg bg-surface px-2 py-1.5 shadow-card">
              <OrbView seed={key} look={look} size={24} />
              <span className="min-w-0 flex-1 truncate font-medium text-fg">{agent.alias}</span>
              <span className="truncate text-[11px] text-muted">{agent.tenantId}</span>
            </div>
            <div className="flex justify-center">
              <span className="rounded-full bg-[rgba(37,28,24,0.78)] px-2 py-0.5 text-[11px] font-semibold text-white">
                {look.glyph ? `${look.glyph} ` : ''}{agent.alias}
              </span>
            </div>
          </div>
          {saved && dirty ? (
            <div className="flex items-center gap-2 text-xs text-muted min-[761px]:justify-center">
              <OrbView seed={key} look={saved} size={18} />En el servidor
            </div>
          ) : null}
        </div>
      </div>

      <div className="grid min-h-0 min-w-0 content-start gap-5 overflow-y-auto overscroll-contain p-5 max-[760px]:px-4">
        {gate ? <Notice tone="warn" role="note">{gate}</Notice> : null}
        <Field label="Icono" hint="Un emoji, una letra o nada">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(36px,1fr))] gap-1 pointer-coarse:grid-cols-[repeat(auto-fill,minmax(44px,1fr))]" role="group" aria-label="Iconos sugeridos">
            <button type="button" aria-pressed={draft.glyph === null} aria-label="Sin icono" title="Sin icono" onClick={() => { pickGlyph(null); }}
              className={cn(CHIP, 'aspect-square text-xs text-muted')}>—</button>
            {initial ? (
              <button type="button" aria-pressed={draft.glyph === initial} aria-label={`Inicial ${initial}`} title="La inicial del alias" onClick={() => { pickGlyph(initial); }}
                className={cn(CHIP, 'aspect-square text-[15px] font-bold text-fg')}>{initial}</button>
            ) : null}
            {APPEARANCE_GLYPHS.map((glyph) => (
              <button key={glyph} type="button" aria-pressed={draft.glyph === glyph} aria-label={`Icono ${glyph}`} onClick={() => { pickGlyph(glyph); }}
                className={cn(CHIP, 'aspect-square text-lg leading-none')}>{glyph}</button>
            ))}
          </div>
          <label className="grid gap-1 text-xs font-normal text-muted">
            O escribí cualquiera
            <input type="text" value={glyphText} placeholder="🐉, Ω, K…" maxLength={16} aria-invalid={problem !== undefined && draft.glyph !== null}
              onChange={(event) => { setGlyphText(event.target.value); update({ glyph: event.target.value.trim() || null }); }}
              className="max-w-40 text-center text-base" />
          </label>
          {problem && draft.glyph !== null ? <Notice tone="danger" role="alert">{problem}</Notice> : null}
        </Field>

        <Field label="Color" hint={draft.hue === null ? 'Automático, según el alias' : `Tono ${String(hue)}°`}>
          <div className="flex flex-wrap items-center gap-1.5 pointer-coarse:gap-2.5" role="group" aria-label="Tonos">
            <button type="button" aria-pressed={draft.hue === null} onClick={() => { update({ hue: null }); }}
              className="h-7 cursor-pointer rounded-full border border-line bg-surface px-2.5 text-[11px] font-medium text-fg-2 hover:bg-subtle aria-pressed:border-brand aria-pressed:bg-brand-soft aria-pressed:text-brand-ink pointer-coarse:h-10 pointer-coarse:px-3.5">
              Automático
            </button>
            {HUES.map((value) => (
              <button key={value} type="button" aria-pressed={draft.hue === value} aria-label={`Tono ${String(value)}°`} title={`${String(value)}°`}
                onClick={() => { update({ hue: value }); }}
                style={{ background: `oklch(0.7 0.16 ${String(value)})` }}
                className="size-6 cursor-pointer rounded-full border-2 border-surface shadow-card transition-transform hover:scale-110 aria-pressed:ring-2 aria-pressed:ring-fg pointer-coarse:size-10" />
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" aria-label="Bajar el tono 5°" onClick={() => { nudge(-5); }} className={NUDGE}><Minus size={14} aria-hidden="true" /></button>
            <input type="range" min={0} max={359} step={1} value={hue} aria-label="Tono fino" aria-valuetext={`${String(hue)} grados`}
              onChange={(event) => { update({ hue: Number(event.target.value) }); }}
              style={{ '--thumb': `oklch(0.7 0.16 ${String(hue)})` } as CSSProperties} className="hue-range min-w-0 flex-1" />
            <button type="button" aria-label="Subir el tono 5°" onClick={() => { nudge(5); }} className={NUDGE}><Plus size={14} aria-hidden="true" /></button>
          </div>
        </Field>

        <Field label="Estilo">
          <ToggleGroup value={[draft.style]} aria-label="Estilo del icono" className="grid grid-cols-4 gap-1.5"
            onValueChange={(value) => {
              const next = AGENT_APPEARANCE_STYLES.find((style) => style === value[0]);
              if (next) update({ style: next });
            }}>
            {AGENT_APPEARANCE_STYLES.map((style) => (
              <Toggle key={style} value={style} title={STYLE_HINT[style]}
                className="grid cursor-pointer justify-items-center gap-1.5 rounded-lg border border-line bg-surface px-1 py-2 text-[11px] font-medium text-fg-2 transition-colors hover:bg-subtle data-[pressed]:border-brand data-[pressed]:bg-brand-soft data-[pressed]:text-brand-ink">
                <OrbView seed={key} look={{ ...look, style }} size={30} state="idle" />
                {STYLE_LABEL[style]}
              </Toggle>
            ))}
          </ToggleGroup>
        </Field>
      </div>

      <div className="grid gap-2 border-t border-line bg-surface px-5 py-3 max-[760px]:px-4 min-[761px]:col-span-2">
        {outcome ? <Notice tone={outcome.tone} role="alert">{outcome.text}</Notice> : null}
        {confirm ? (
          <div className="flex flex-wrap items-center justify-end gap-2" role="group" aria-label="Confirmar">
            <p className="m-0 basis-full text-[13px] text-fg min-[761px]:basis-0 min-[761px]:flex-1" role="status">
              {confirm === 'discard' ? '¿Descartar los cambios sin guardar?' : `¿Borrar el look guardado de ${agent.alias}? Toda la flota vuelve a ver su orbe automático.`}
            </p>
            <Button ref={safeChoice} onClick={() => { setConfirm(undefined); }}>{confirm === 'discard' ? 'Seguir editando' : 'Cancelar'}</Button>
            <Button variant="danger" onClick={() => { if (confirm === 'discard') onClose(); else void run('reset'); }}>
              {confirm === 'discard' ? 'Descartar' : 'Restablecer'}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" disabled={!canWrite || busy !== undefined || (!saved && sameDraft(draft, DEFAULT_DRAFT))}
              onClick={() => { if (saved) setConfirm('reset'); else { pickGlyph(null); update(DEFAULT_DRAFT); } }}
              title={saved ? 'Borra el look guardado y vuelve al orbe automático' : 'Vuelve al orbe automático'}>
              <RotateCcw size={14} aria-hidden="true" />{busy === 'reset' ? 'Restableciendo…' : 'Restablecer'}
            </Button>
            <span className="flex-1" />
            <Button size="md" disabled={busy !== undefined} onClick={() => { if (requestClose()) onClose(); }}>Cancelar</Button>
            <Button variant="primary" disabled={!canWrite || !dirty || problem !== undefined || busy !== undefined} onClick={() => { void run('save'); }}>
              {busy === 'save' ? 'Guardando…' : 'Guardar'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Glyph, hue and style of one agent, shared by the whole fleet. A bottom sheet on phones. */
export function AppearanceDialog({ agent, onClose }: { agent: AgentRef | null; onClose: () => void }) {
  const guard = useRef<() => boolean>(() => true);
  return (
    <Dialog.Root open={agent !== null} onOpenChange={(open) => { if (!open && guard.current()) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[60] bg-scrim" />
        <Dialog.Popup className={cn(
          'fixed z-[60] grid grid-rows-[auto_minmax(0,1fr)] overflow-hidden border-line bg-surface shadow-pop outline-none',
          'top-1/2 left-1/2 h-[min(660px,calc(100dvh-1.5rem))] w-[min(94vw,720px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border',
          'max-[760px]:top-auto max-[760px]:bottom-0 max-[760px]:left-0 max-[760px]:h-auto max-[760px]:max-h-[92dvh] max-[760px]:w-full max-[760px]:translate-x-0 max-[760px]:translate-y-0 max-[760px]:rounded-b-none max-[760px]:border-x-0 max-[760px]:border-b-0 max-[760px]:pb-[env(safe-area-inset-bottom)]',
        )}>
          <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3 max-[760px]:px-4">
            <div className="min-w-0">
              <Dialog.Title className="m-0 text-base font-semibold">Personalizar icono{agent ? ` de ${agent.alias}` : ''}</Dialog.Title>
              <Dialog.Description className="m-0 mt-0.5 text-xs text-muted">Lo ve toda la flota: barra lateral, chat, terminal y oficina.</Dialog.Description>
            </div>
            <Dialog.Close aria-label="Cerrar" className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-muted hover:bg-subtle hover:text-fg pointer-coarse:size-11">
              <X size={16} aria-hidden="true" />
            </Dialog.Close>
          </div>
          {agent ? <Editor key={agentKey(agent)} agent={agent} guard={guard} onClose={onClose} /> : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
