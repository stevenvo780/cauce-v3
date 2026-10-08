import { ArrowLeft, ArrowRight, Braces, CircleCheck, RotateCcw, Save, SearchCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ConfigMutation } from '../../api/types';
import { Button, Outcome, PREVIEW } from '../../components/kit';
import { Badge, EmptyState } from '../../components/ui';
import { CONFIG_SIN_CONTROL_REASON } from '../../router';
import { textoRecarga, type ConfigChangeOutcome } from './config-change';
import { CHECK_LABEL, FORM_GRID, HINT } from './config-ui';

type SpaceStep = 'tenant' | 'room' | 'membership' | 'harness';
type WizardStep = SpaceStep | 'review';

const wizardSteps: WizardStep[] = ['tenant', 'room', 'membership', 'harness', 'review'];
const stepTitles: Record<WizardStep, string> = {
  tenant: 'Tenant', room: 'Room', membership: 'Membership', harness: 'Harness', review: 'Dry-run y aplicar',
};

// Same expressions as TenantSchema and AliasSchema in packages/protocol/src/schemas.ts.
const TENANT_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SLUG = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * `harnessCommand` NO LONGER EXISTS, and its absence is the change.
 *
 * `harness_definitions.command` was being saved, audited, and undoable… and nobody reads it:
 * `listAdapters` does not even select it (packages/store/src/repository/agents.ts:278), and the
 * adapter takes the command it runs from its own compiled table
 * (packages/adapter-sdk/src/harnesses/index.ts:12) or from its local config file's
 * `harness_command` (packages/adapter-sdk/src/bin/config.ts:179). A create field that writes a
 * column nobody obeys is exactly the false promise this change withdraws.
 *
 * No capability is lost: `HarnessConfigMutationSchema` still admits it
 * (packages/protocol/src/schemas/configuration.ts:31) and the raw-mutation editor can send it.
 * What disappears is the invitation to fill it in.
 */
interface SpaceDraft {
  tenantId: string; tenantLabel: string; tenantIsHub: boolean; withTenant: boolean;
  roomId: string; roomLabel: string; withRoom: boolean;
  alias: string; role: string; withMembership: boolean;
  harnessId: string; harnessLabel: string; harnessCapabilities: string; withHarness: boolean;
}

const emptyDraft: SpaceDraft = {
  tenantId: 'Acme', tenantLabel: 'Acme', tenantIsHub: false, withTenant: true,
  roomId: 'grp.acme', roomLabel: 'Acme room', withRoom: true,
  alias: 'agent', role: 'agent', withMembership: true,
  harnessId: 'custom', harnessLabel: 'Custom harness', harnessCapabilities: '', withHarness: true,
};

function capabilityList(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
}

interface PlanEntry { step: SpaceStep; mutation: ConfigMutation }

/**
 * Identity of a plan step: the step PLUS the exact JSON of the mutation. What was applied is
 * recorded under this key, not the step's name, because the name survives any edit of the draft:
 * if the operator changes a field after applying, the mutation is a different one —one the plan
 * control never received— and the step has to become pending again instead of inheriting "applied".
 */
function entryKey(entry: PlanEntry): string {
  return `${entry.step}:${JSON.stringify(entry.mutation)}`;
}

function planFor(draft: SpaceDraft): PlanEntry[] {
  const plan: PlanEntry[] = [];
  const tenantId = draft.tenantId.trim();
  const roomId = draft.roomId.trim();
  if (draft.withTenant) {
    plan.push({ step: 'tenant', mutation: {
      resource: 'tenant', action: 'create', id: tenantId,
      value: { display_name: draft.tenantLabel.trim() || null, is_hub: draft.tenantIsHub, enabled: true },
    } });
  }
  if (draft.withRoom) {
    plan.push({ step: 'room', mutation: {
      resource: 'room', action: 'create', tenant_id: tenantId, id: roomId,
      value: { display_name: draft.roomLabel.trim() || null, enabled: true },
    } });
  }
  if (draft.withMembership) {
    plan.push({ step: 'membership', mutation: {
      resource: 'membership', action: 'create', tenant_id: tenantId, room_id: roomId, alias: draft.alias.trim(),
      value: { role: draft.role.trim(), enabled: true },
    } });
  }
  if (draft.withHarness) {
    plan.push({ step: 'harness', mutation: {
      resource: 'harness', action: 'create', id: draft.harnessId.trim(),
      // Without `command`: the key is not sent, and no `null` is sent "just in case". Sending
      // `null` would let a create overwrite with NULL the value another operator set through the
      // raw editor, which is writing a field this form no longer claims to govern.
      value: {
        display_name: draft.harnessLabel.trim(),
        capabilities: capabilityList(draft.harnessCapabilities), enabled: true,
      },
    } });
  }
  return plan;
}

function stepError(step: WizardStep, draft: SpaceDraft): string | undefined {
  if (step === 'tenant') {
    if (!draft.withTenant && !draft.withRoom && !draft.withMembership) return undefined;
    return TENANT_ID.test(draft.tenantId.trim())
      ? undefined
      : 'El tenant debe empezar con letra y seguir con letras, números, guion o guion bajo (máx. 64).';
  }
  if (step === 'room') {
    if (!draft.withRoom && !draft.withMembership) return undefined;
    const roomId = draft.roomId.trim();
    return roomId.length >= 1 && roomId.length <= 128 ? undefined : 'El room necesita un id de 1 a 128 caracteres.';
  }
  if (step === 'membership') {
    if (!draft.withMembership) return undefined;
    if (!SLUG.test(draft.alias.trim())) return 'El alias debe ser minúsculas, empezar con letra y usar sólo letras, números, guion o guion bajo.';
    return SLUG.test(draft.role.trim()) ? undefined : 'El rol de permisos debe ser minúsculas, empezar con letra y usar sólo letras, números, guion o guion bajo.';
  }
  if (step === 'harness') {
    if (!draft.withHarness) return undefined;
    if (!SLUG.test(draft.harnessId.trim())) return 'El id de harness debe ser minúsculas y empezar con letra.';
    const label = draft.harnessLabel.trim();
    return label.length >= 1 && label.length <= 128 ? undefined : 'El harness necesita un display name de 1 a 128 caracteres.';
  }
  if (!planFor(draft).length) return 'El plan quedó vacío: incluí al menos un recurso.';
  for (const previous of wizardSteps) {
    if (previous === 'review') break;
    const error = stepError(previous, draft);
    if (error) return `${stepTitles[previous]}: ${error}`;
  }
  return undefined;
}

/**
 * Guides tenant -> room -> membership -> harness over the same POST /v3/console/config/changes
 * that the raw editor uses. The endpoint applies ONE atomic mutation per call and each step
 * depends on the rows the previous one created, so the plan is previewed and applied one step
 * at a time: there is no possible dry-run of the room before the tenant exists.
 */
export function SpaceWizard({ canWrite, busy, onChange }: {
  canWrite: boolean;
  busy: boolean;
  onChange: (mutation: ConfigMutation, dryRun: boolean) => Promise<ConfigChangeOutcome>;
}) {
  const [draft, setDraft] = useState<SpaceDraft>(emptyDraft);
  const [step, setStep] = useState<WizardStep>('tenant');
  // Keys (entryKey) of the mutations the server accepted, not step names.
  const [applied, setApplied] = useState<string[]>([]);
  const [validated, setValidated] = useState<string>();
  const [preview, setPreview] = useState<string>();
  const [notice, setNotice] = useState<{ text: string; tone: 'success' | 'error' | 'parcial' }>();

  const plan = useMemo(() => planFor(draft), [draft]);
  const progress = useMemo(() => {
    const confirmed = new Set(applied);
    return plan.map((entry) => {
      const key = entryKey(entry);
      return { ...entry, key, done: confirmed.has(key) };
    });
  }, [plan, applied]);
  const doneSteps = useMemo(
    () => new Set<WizardStep>(progress.filter((entry) => entry.done).map((entry) => entry.step)),
    [progress],
  );
  const pending = progress.find((entry) => !entry.done);
  const pendingKey = pending?.key;
  const pendingText = pending ? JSON.stringify(pending.mutation, null, 2) : undefined;
  const invalid = stepError(step, draft);
  const writeControls = { disabled: !canWrite || busy, ...(!canWrite ? { title: CONFIG_SIN_CONTROL_REASON } : {}) };
  // Apply is only enabled against the exact mutation the server already validated in dry-run.
  const applicable = pendingKey !== undefined && validated === pendingKey && !invalid;
  const index = wizardSteps.indexOf(step);

  function edit(patch: Partial<SpaceDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setPreview(undefined);
    setNotice(undefined);
  }

  function reset() {
    setDraft(emptyDraft);
    setApplied([]);
    setValidated(undefined);
    setPreview(undefined);
    setNotice(undefined);
    setStep('tenant');
  }

  async function run(dryRun: boolean) {
    if (!pending || pendingKey === undefined) return;
    setNotice(undefined);
    const outcome = await onChange(pending.mutation, dryRun);
    if (!outcome.ok) {
      if (outcome.conflict) {
        setValidated(undefined);
        setPreview(undefined);
      }
      setNotice({ text: outcome.message, tone: 'error' });
      return;
    }
    if (dryRun) {
      setValidated(pendingKey);
      setPreview(JSON.stringify(outcome.result, null, 2));
      setNotice({ text: `Dry-run de ${stepTitles[pending.step]} aceptado: revisá el resultado antes de aplicar.`, tone: 'success' });
      return;
    }
    // The mutation the server accepted is recorded, even if the draft changed during the await.
    setApplied((current) => (current.includes(pendingKey) ? current : [...current, pendingKey]));
    setValidated(undefined);
    setPreview(undefined);
    // The wizard was the only one of the four write paths that discarded the outcome of the
    // re-read: it said "applied at revision 2" even when the subsequent GET had failed with a
    // 500, and the next step was built against a stale snapshot with no one calling it out.
    const falloLaRelectura = outcome.recarga !== undefined && !outcome.recarga.releido;
    setNotice({
      tone: falloLaRelectura ? 'parcial' : 'success',
      text: `${stepTitles[pending.step]} aplicado en revisión ${String(outcome.result.revision ?? 'UNKNOWN')}.`
        + textoRecarga(outcome.recarga),
    });
  }

  return <div className="grid gap-3" role="group" aria-label="Wizard de espacios">
    <p className={HINT}>Cada paso pasa por dry-run y se aplica por separado.</p>
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Pasos del wizard">
      {wizardSteps.map((item, position) => <Button key={item} size="sm" variant={item === step ? 'primary' : 'secondary'} onClick={() => { setStep(item); }}>
        {doneSteps.has(item) ? <CircleCheck size={14} aria-hidden="true" /> : null}{position + 1}. {stepTitles[item]}
      </Button>)}
    </div>

    {step === 'tenant' ? <div className={FORM_GRID}>
      <label className={`${CHECK_LABEL} md:col-span-2`}><input {...writeControls} type="checkbox" checked={draft.withTenant} onChange={(event) => { edit({ withTenant: event.target.checked }); }} /> Crear el tenant <span className={HINT}>destildá si ya existe; el id se sigue usando en los pasos siguientes</span></label>
      <label>Tenant id<input {...writeControls} value={draft.tenantId} onChange={(event) => { edit({ tenantId: event.target.value }); }} /></label>
      <label>Display name <span className={HINT}>opcional</span><input {...writeControls} value={draft.tenantLabel} onChange={(event) => { edit({ tenantLabel: event.target.value }); }} /></label>
      <label className={CHECK_LABEL}><input {...writeControls} type="checkbox" checked={draft.tenantIsHub} onChange={(event) => { edit({ tenantIsHub: event.target.checked }); }} /> Es hub</label>
    </div> : null}

    {step === 'room' ? <div className={FORM_GRID}>
      <label className={`${CHECK_LABEL} md:col-span-2`}><input {...writeControls} type="checkbox" checked={draft.withRoom} onChange={(event) => { edit({ withRoom: event.target.checked }); }} /> Crear el room</label>
      <label>Room id<input {...writeControls} value={draft.roomId} onChange={(event) => { edit({ roomId: event.target.value }); }} /></label>
      <label>Display name <span className={HINT}>opcional</span><input {...writeControls} value={draft.roomLabel} onChange={(event) => { edit({ roomLabel: event.target.value }); }} /></label>
    </div> : null}

    {step === 'membership' ? <div className={FORM_GRID}>
      <label className={`${CHECK_LABEL} md:col-span-2`}><input {...writeControls} type="checkbox" checked={draft.withMembership} onChange={(event) => { edit({ withMembership: event.target.checked }); }} /> Crear la membership</label>
      <label>Alias<input {...writeControls} value={draft.alias} onChange={(event) => { edit({ alias: event.target.value }); }} /></label>
      <label>Rol de permisos <span className={HINT}>route/read/control salen de role_policies; no cambia el contexto</span><input {...writeControls} value={draft.role} onChange={(event) => { edit({ role: event.target.value }); }} /></label>
    </div> : null}

    {step === 'harness' ? <div className={FORM_GRID}>
      <label className={`${CHECK_LABEL} md:col-span-2`}><input {...writeControls} type="checkbox" checked={draft.withHarness} onChange={(event) => { edit({ withHarness: event.target.checked }); }} /> Registrar el harness</label>
      <label>Harness id<input {...writeControls} value={draft.harnessId} onChange={(event) => { edit({ harnessId: event.target.value }); }} /></label>
      <label>Display name<input {...writeControls} value={draft.harnessLabel} onChange={(event) => { edit({ harnessLabel: event.target.value }); }} /></label>
      <label>Capabilities <span className={HINT}>separadas por coma</span><input {...writeControls} value={draft.harnessCapabilities} onChange={(event) => { edit({ harnessCapabilities: event.target.value }); }} /></label>
      {/* Where did "Command" go. Removing a field without saying so leaves the operator hunting for
          it and thinking the screen broke; saying nobody reads it answers the question at once. */}
      <p className={`${HINT} md:col-span-2`}>
        «Command» ya no se pide: esa columna se guarda pero no la lee ningún camino de ejecución —el
        adaptador toma su orden de su propio paquete o de su fichero local—. Sigue admitida por el
        editor de mutaciones JSON de «Avanzado» para quien la necesite.
      </p>
    </div> : null}

    {step === 'review' ? <>
      {!plan.length ? <EmptyState>El plan quedó vacío: volvé a los pasos e incluí al menos un recurso.</EmptyState> : <ul className="m-0 grid list-none gap-2 p-0" aria-label="Plan del espacio">
        {progress.map((entry) => <li key={entry.step} className="rounded-lg border border-line p-2.5">
          <Badge tone={entry.done ? 'done' : entry === pending ? 'info' : 'unknown'}>{entry.done ? 'aplicado' : entry === pending ? 'en curso' : 'en cola'}</Badge>{' '}
          <code className="text-xs break-all">{JSON.stringify(entry.mutation)}</code>
        </li>)}
      </ul>}
      {/* The pending step's JSON is not lost: it stops being open. What matters for the decision is
          the list above —which step goes and in what state—, not how it is encoded. */}
      {pendingText !== undefined ? <details className="text-[13px]">
        <summary className="flex cursor-pointer items-center gap-1.5 text-muted"><Braces size={13} aria-hidden="true" /> Ver la mutación del paso pendiente</summary>
        <pre className={`${PREVIEW} mt-2`} aria-label="Mutación pendiente del wizard">{pendingText}</pre>
      </details> : null}
      {plan.length > 0 && !pending ? <Outcome tone="success">Espacio completo: los {plan.length} pasos quedaron aplicados.</Outcome> : null}
      <div className="flex flex-wrap gap-2">
        <Button disabled={!canWrite || busy || !pending || Boolean(invalid)} onClick={() => void run(true)}><SearchCheck size={16} aria-hidden="true" />Previsualizar paso</Button>
        <Button variant="primary" disabled={!canWrite || busy || !applicable} onClick={() => void run(false)}><Save size={16} aria-hidden="true" />Aplicar paso</Button>
        <Button size="sm" onClick={reset}><RotateCcw size={14} aria-hidden="true" />Reiniciar wizard</Button>
      </div>
      {preview ? <pre className={PREVIEW} aria-label="Dry-run del wizard">{preview}</pre> : null}
    </> : null}

    {invalid ? <Outcome tone="error">{invalid}</Outcome> : null}
    {notice ? <Outcome tone={notice.tone}>{notice.text}</Outcome> : null}

    {step === 'review' ? null : <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={index === 0} onClick={() => { setStep(wizardSteps[index - 1]); }}><ArrowLeft size={14} aria-hidden="true" />Atrás</Button>
      <Button size="sm" disabled={Boolean(invalid)} onClick={() => { setStep(wizardSteps[index + 1]); }}>Siguiente<ArrowRight size={14} aria-hidden="true" /></Button>
    </div>}
  </div>;
}
