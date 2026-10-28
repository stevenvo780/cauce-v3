import { useEffect, useState } from 'react';
import { useApi } from '../api/context';
import type { BillingOverview, BillingPlan, BillingPlanId } from '../api/client/billing-client';
import { Button, Pill } from '../components/kit';
import { FormDialog } from '../components/dialogs';
import { formatLocal, formatUsd, needsPlan, PLAN_ORDER, PLAN_TITLE } from '../features/config/billing-model';
import { navigate } from '../router';

const PITCH: Record<BillingPlanId, { tagline: string; body: string; unit: string; highlight?: string }> = {
  gestionado: {
    tagline: 'Todo incluido',
    body: 'Nosotros ponemos los modelos de IA, probamos las cuotas y hospedamos tus agentes. Tú solo trabajas con ellos.',
    unit: 'por agente al mes',
    highlight: 'Recomendado: 3 agentes',
  },
  hotel_20: {
    tagline: 'Tus ordenadores, nuestra red',
    body: 'Conecta tus PC y tus cuentas de IA; Cauce pone la red que une a tus agentes, el chat, la oficina y la terminal.',
    unit: 'al mes, hasta 20 agentes',
  },
  hotel_50: {
    tagline: 'Para equipos grandes',
    body: 'Lo mismo que Hotel 20 con espacio para crecer: hasta 50 agentes en tus propios ordenadores.',
    unit: 'al mes, hasta 50 agentes',
  },
  espacio: {
    tagline: 'Para empezar pequeño',
    body: 'Pagas solo los espacios de trabajo que usas, con 5 agentes en cada uno, en tus ordenadores y con tus cuotas.',
    unit: 'por espacio al mes',
  },
};

function choose(plan: BillingPlanId): void {
  navigate(`/plan?plan=${plan}`);
}

function PlanPitch({ plan, overview, onChoose }: { plan: BillingPlan; overview: BillingOverview; onChoose: () => void }) {
  const pitch = PITCH[plan.plan];
  const featured = plan.plan === 'gestionado';
  const local = formatLocal(plan.price_usd, overview.currency, overview.usd_rate, overview.fee);
  return <li>
    <article aria-label={PLAN_TITLE[plan.plan]}
      className={featured
        ? 'grid h-full content-start gap-2 rounded-xl border-2 border-brand bg-brand-soft p-4'
        : 'grid h-full content-start gap-2 rounded-xl border border-line bg-surface p-4'}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 text-sm font-semibold">{PLAN_TITLE[plan.plan]}</h3>
        {pitch.highlight ? <Pill tone="ok">{pitch.highlight}</Pill> : null}
      </div>
      <p className="m-0 text-xs font-semibold text-brand-ink">{pitch.tagline}</p>
      <p className="m-0 text-xs leading-relaxed text-muted">{pitch.body}</p>
      <p className="m-0 grid">
        <strong className="text-lg font-semibold tabular-nums">{formatUsd(plan.price_usd)}</strong>
        <span className="text-xs text-muted">{pitch.unit}{local ? ` · ${local}` : ''}</span>
      </p>
      <Button variant={featured ? 'primary' : 'secondary'} onClick={onChoose}>Elegir {PLAN_TITLE[plan.plan]}</Button>
    </article>
  </li>;
}

/** Banner on every page while the company has no active plan, with a showcase of the plans. */
export function PlanNotice() {
  const api = useApi();
  const [overview, setOverview] = useState<BillingOverview>();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    api.getBilling().then((value) => { if (alive) setOverview(value); }, () => undefined);
    return () => { alive = false; };
  }, [api]);
  if (!overview || !needsPlan(overview)) return null;
  const pending = overview.subscription?.status === 'pending';
  const plans = PLAN_ORDER.flatMap((id) => overview.plans.filter((plan) => plan.plan === id));
  return <>
    <div role="status" className="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-brand bg-brand-soft px-3 py-2 text-[13px] leading-snug">
      <span className="min-w-0 flex-1 font-medium text-brand-ink">
        {pending
          ? 'Tu pago en Mercado Pago está pendiente. En cuanto se apruebe, tu plan queda activo.'
          : 'Tu empresa aún no tiene un plan activo. Elige uno para seguir creando agentes.'}
      </span>
      <Button size="sm" variant="primary" onClick={() => { if (pending) navigate('/plan'); else setOpen(true); }}>
        {pending ? 'Ver mi plan' : 'Ver planes'}
      </Button>
    </div>
    <FormDialog open={open} wide onClose={() => { setOpen(false); }}
      title="Elige cómo trabaja tu equipo de agentes"
      description="Todos los planes incluyen la red Cauce: chat, oficina, terminal y coordinación entre agentes. Pagas mes a mes con Mercado Pago y cancelas cuando quieras.">
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,15rem),1fr))] gap-3 p-0">
        {plans.map((plan) => <PlanPitch key={plan.plan} plan={plan} overview={overview}
          onChoose={() => { setOpen(false); choose(plan.plan); }} />)}
      </ul>
      {overview.fee ? <p className="m-0 text-xs text-muted">El precio en pesos ya incluye la comisión de Mercado Pago.</p> : null}
    </FormDialog>
  </>;
}
