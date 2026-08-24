import { ArrowLeft, ArrowRight, Braces, CircleCheck, RotateCcw, Save, SearchCheck } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import type { ConfigMutation } from '../../api/types';
import { Badge, EmptyState, Panel } from '../../components/ui';
import { textoRecarga, type ConfigChangeOutcome } from './config-change';
import './toggles.css';

type SpaceStep = 'tenant' | 'room' | 'membership' | 'harness';
type WizardStep = SpaceStep | 'review';

const wizardSteps: WizardStep[] = ['tenant', 'room', 'membership', 'harness', 'review'];
const stepTitles: Record<WizardStep, string> = {
  tenant: 'Tenant', room: 'Room', membership: 'Membership', harness: 'Harness', review: 'Dry-run y aplicar',
};

// Mismas expresiones que TenantSchema y AliasSchema en packages/protocol/src/schemas.ts.
const TENANT_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SLUG = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * `harnessCommand` YA NO EXISTE, y su ausencia es el cambio.
 *
 * `harness_definitions.command` se guardaba, se auditaba y se podía deshacer… y no lo lee nadie:
 * `listAdapters` ni siquiera lo selecciona (packages/store/src/repository.ts:7566), y el adaptador
 * toma la orden que ejecuta de su propia tabla compilada
 * (packages/adapter-sdk/src/harnesses/index.ts:12) o del `harness_command` de su fichero de
 * configuración local (packages/adapter-sdk/src/bin/config.ts:184). Un campo de alta que escribe una
 * columna que nadie obedece es justo la promesa falsa que este cambio retira.
 *
 * No se pierde capacidad: `HarnessConfigMutationSchema` lo sigue admitiendo
 * (packages/protocol/src/schemas.ts:503) y el editor de mutaciones crudas lo puede mandar. Lo que
 * desaparece es la invitación a rellenarlo.
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
 * Identidad de un paso del plan: el paso MÁS el JSON exacto de la mutación. Lo aplicado se registra
 * con esta clave y no con el nombre del paso, porque el nombre sobrevive a cualquier edición del
 * draft: si el operador cambia un campo después de aplicar, la mutación es otra —una que el control
 * plane nunca recibió— y el paso tiene que volver a quedar pendiente en vez de heredar el "aplicado".
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
      // Sin `command`: la clave no viaja, no se manda `null` «por si acaso». Mandar `null` haría
      // que un alta pisara con NULL el valor que otro operador hubiera puesto por el editor crudo,
      // y eso es escribir un campo que este formulario ya no dice gobernar.
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
    return SLUG.test(draft.role.trim()) ? undefined : 'El rol debe ser minúsculas, empezar con letra y usar sólo letras, números, guion o guion bajo.';
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
 * Guía tenant -> room -> membership -> harness sobre el mismo POST /v3/console/config/changes que
 * usa el editor crudo. El endpoint aplica UNA mutación atómica por llamada y cada paso depende de
 * las filas que creó el anterior, así que el plan se previsualiza y se aplica de a un paso: no hay
 * dry-run posible del room antes de que exista el tenant.
 */
export function SpaceWizard({ canWrite, busy, onChange, encabezado }: {
  canWrite: boolean;
  busy: boolean;
  onChange: (mutation: ConfigMutation, dryRun: boolean) => Promise<ConfigChangeOutcome>;
  /** El control que elige entre este wizard y el alta de un solo recurso. Ver `AltaDeEspacios`. */
  encabezado?: ReactNode;
}) {
  const [draft, setDraft] = useState<SpaceDraft>(emptyDraft);
  const [step, setStep] = useState<WizardStep>('tenant');
  // Claves (entryKey) de las mutaciones que el servidor aceptó, no nombres de paso.
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
  // El apply sólo se habilita contra la mutación exacta que el servidor ya validó en dry-run.
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
    // Se registra la mutación que el servidor aceptó, aunque el draft haya cambiado durante el await.
    setApplied((current) => (current.includes(pendingKey) ? current : [...current, pendingKey]));
    setValidated(undefined);
    setPreview(undefined);
    // El wizard era el único de los cuatro caminos de escritura que tiraba el desenlace de la
    // relectura: decía «aplicado en revisión 2» aunque el GET posterior hubiera fallado con un 500,
    // y el paso siguiente se armaba contra un snapshot vencido sin que nadie lo dijera.
    const falloLaRelectura = outcome.recarga !== undefined && !outcome.recarga.releido;
    setNotice({
      tone: falloLaRelectura ? 'parcial' : 'success',
      text: `${stepTitles[pending.step]} aplicado en revisión ${outcome.result.revision ?? 'UNKNOWN'}.`
        + textoRecarga(outcome.recarga),
    });
  }

  return <Panel title="Wizard de espacios" subtitle="Cada paso pasa por dry-run y se aplica por separado, sobre el mismo change endpoint.">
    {encabezado}
    <div className="config-actions" role="group" aria-label="Pasos del wizard">
      {wizardSteps.map((item, position) => <button key={item} type="button" className={`button small${item === step ? ' primary' : ''}`} onClick={() => setStep(item)}>
        {doneSteps.has(item) ? <CircleCheck size={14} aria-hidden="true" /> : null}{position + 1}. {stepTitles[item]}
      </button>)}
    </div>

    {step === 'tenant' ? <div className="config-form">
      <label className="config-json casilla"><input type="checkbox" checked={draft.withTenant} onChange={(event) => edit({ withTenant: event.target.checked })} /> Crear el tenant <span className="label-hint">destildá si ya existe; el id se sigue usando en los pasos siguientes</span></label>
      <label>Tenant id<input value={draft.tenantId} onChange={(event) => edit({ tenantId: event.target.value })} /></label>
      <label>Display name <span className="label-hint">opcional</span><input value={draft.tenantLabel} onChange={(event) => edit({ tenantLabel: event.target.value })} /></label>
      <label className="casilla"><input type="checkbox" checked={draft.tenantIsHub} onChange={(event) => edit({ tenantIsHub: event.target.checked })} /> Es hub</label>
    </div> : null}

    {step === 'room' ? <div className="config-form">
      <label className="config-json casilla"><input type="checkbox" checked={draft.withRoom} onChange={(event) => edit({ withRoom: event.target.checked })} /> Crear el room</label>
      <label>Room id<input value={draft.roomId} onChange={(event) => edit({ roomId: event.target.value })} /></label>
      <label>Display name <span className="label-hint">opcional</span><input value={draft.roomLabel} onChange={(event) => edit({ roomLabel: event.target.value })} /></label>
    </div> : null}

    {step === 'membership' ? <div className="config-form">
      <label className="config-json casilla"><input type="checkbox" checked={draft.withMembership} onChange={(event) => edit({ withMembership: event.target.checked })} /> Crear la membership</label>
      <label>Alias<input value={draft.alias} onChange={(event) => edit({ alias: event.target.value })} /></label>
      <label>Rol <span className="label-hint">route/read/control salen de role_policies</span><input value={draft.role} onChange={(event) => edit({ role: event.target.value })} /></label>
    </div> : null}

    {step === 'harness' ? <div className="config-form">
      <label className="config-json casilla"><input type="checkbox" checked={draft.withHarness} onChange={(event) => edit({ withHarness: event.target.checked })} /> Registrar el harness</label>
      <label>Harness id<input value={draft.harnessId} onChange={(event) => edit({ harnessId: event.target.value })} /></label>
      <label>Display name<input value={draft.harnessLabel} onChange={(event) => edit({ harnessLabel: event.target.value })} /></label>
      <label>Capabilities <span className="label-hint">separadas por coma</span><input value={draft.harnessCapabilities} onChange={(event) => edit({ harnessCapabilities: event.target.value })} /></label>
      {/* Dónde se fue «Command». Quitar un campo sin decirlo deja al operador buscándolo y creyendo
          que la pantalla se rompió; decir que no lo lee nadie contesta la pregunta de una vez. */}
      <p className="muted">
        «Command» ya no se pide: esa columna se guarda pero no la lee ningún camino de ejecución —el
        adaptador toma su orden de su propio paquete o de su fichero local—. Sigue admitida por el
        editor de mutaciones JSON de «Historial y JSON» para quien la necesite.
      </p>
    </div> : null}

    {step === 'review' ? <>
      {!plan.length ? <EmptyState>El plan quedó vacío: volvé a los pasos e incluí al menos un recurso.</EmptyState> : <ul className="config-records" aria-label="Plan del espacio">
        {progress.map((entry) => <li key={entry.step}>
          <Badge tone={entry.done ? 'done' : entry === pending ? 'info' : 'unknown'}>{entry.done ? 'aplicado' : entry === pending ? 'en curso' : 'en cola'}</Badge>{' '}
          <code>{JSON.stringify(entry.mutation)}</code>
        </li>)}
      </ul>}
      {/* El JSON del paso pendiente no se pierde: deja de estar abierto. Lo que hace falta leer
          para decidir es la lista de arriba —qué paso va y en qué estado—, no cómo se codifica. */}
      {pendingText !== undefined ? <details className="config-crudo">
        <summary><Braces size={13} aria-hidden="true" /> Ver la mutación del paso pendiente</summary>
        <pre className="config-preview" aria-label="Mutación pendiente del wizard">{pendingText}</pre>
      </details> : null}
      {plan.length > 0 && !pending ? <p className="notice success" role="status">Espacio completo: los {plan.length} pasos quedaron aplicados.</p> : null}
      <div className="config-actions">
        <button className="button secondary" type="button" disabled={!canWrite || busy || !pending || Boolean(invalid)} onClick={() => void run(true)}><SearchCheck size={16} aria-hidden="true" />Previsualizar paso</button>
        <button className="button primary" type="button" disabled={!canWrite || busy || !applicable} onClick={() => void run(false)}><Save size={16} aria-hidden="true" />Aplicar paso</button>
        <button className="button small" type="button" onClick={reset}><RotateCcw size={14} aria-hidden="true" />Reiniciar wizard</button>
      </div>
      {preview ? <pre className="config-preview" aria-label="Dry-run del wizard">{preview}</pre> : null}
    </> : null}

    {invalid ? <p className="notice error" role="alert">{invalid}</p> : null}
    {notice ? <p
      className={notice.tone === 'error' ? 'notice error' : notice.tone === 'parcial' ? 'notice parcial' : 'notice success'}
      role={notice.tone === 'success' ? 'status' : 'alert'}
    >{notice.text}</p> : null}

    {step === 'review' ? null : <div className="config-actions">
      <button className="button small" type="button" disabled={index === 0} onClick={() => setStep(wizardSteps[index - 1])}><ArrowLeft size={14} aria-hidden="true" />Atrás</button>
      <button className="button small" type="button" disabled={Boolean(invalid)} onClick={() => setStep(wizardSteps[index + 1])}>Siguiente<ArrowRight size={14} aria-hidden="true" /></button>
    </div>}
  </Panel>;
}
