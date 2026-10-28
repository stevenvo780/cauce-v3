import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client/core';
import type { BillingOverview, BillingPlan, BillingSubscription } from '../../api/client/billing-client';
import { useApi } from '../../api/context';
import { Button, Notice, Pill } from '../../components/kit';
import { LoadingState } from '../../components/ui';
import { useRouteSearch } from '../../router';
import { ConfigSectionHeader } from './ConfigSectionHeader';
import {
  PLAN_ORDER, PLAN_SUMMARY, PLAN_TITLE, QUANTITY_RANGE, STATUS_LABEL,
  agentLimit, clampQuantity, formatLocal, formatUsd, holdsPlan, quantityOf, totalUsd,
} from './billing-model';

const RECOMMENDED_AT = 3;

function failure(cause: unknown, fallback: string): string {
  if (cause instanceof ApiError) {
    if (cause.code === 'billing_unconfigured') return 'Pagos sin configurar';
    if (cause.status === 409) return 'Esta empresa ya tiene una suscripción activa o pendiente. Cancélala antes de contratar otra.';
    if (cause.status === 403) return 'Tu autoridad de empresa no permite gestionar el plan.';
  }
  return fallback;
}

function isSecureUrl(value: string): boolean {
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}

function Price({ usd, overview }: { usd: number; overview: BillingOverview }) {
  const local = formatLocal(usd, overview.currency, overview.usd_rate, overview.fee);
  return <p className="m-0 grid">
    <strong className="text-xl font-semibold tabular-nums">{formatUsd(usd)}<span className="text-xs font-normal text-muted"> /mes</span></strong>
    {local ? <span className="text-xs text-muted tabular-nums">{overview.fee ? `${local} /mes con la comisión de Mercado Pago` : `≈ ${local} /mes`}</span> : null}
  </p>;
}

function PlanCard({ plan, overview, disabled, busy, onPay }: {
  plan: BillingPlan; overview: BillingOverview; disabled: boolean; busy: boolean; onPay: (quantity: number) => void;
}) {
  const range = QUANTITY_RANGE[plan.plan];
  const [typed, setTyped] = useState(String(range?.initial ?? 1));
  const quantity = clampQuantity(plan.plan, Number(typed));
  const title = PLAN_TITLE[plan.plan];
  const unitLabel = plan.plan === 'espacio' ? 'Espacios' : 'Agentes';
  const total = totalUsd(plan, quantity);
  const recommended = plan.plan === 'gestionado' && quantity === (plan.recommended_quantity ?? RECOMMENDED_AT);
  return <li>
    <article aria-label={title} className="grid h-full content-start gap-3 rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 text-sm font-semibold">{title}</h3>
        {recommended ? <Pill tone="ok">Recomendado</Pill> : null}
      </div>
      <p className="m-0 text-xs leading-relaxed text-muted">{PLAN_SUMMARY[plan.plan]}</p>
      {range ? <label className="grid gap-1 text-xs text-muted">
        {unitLabel}
        <input type="number" inputMode="numeric" min={range.min} max={range.max} value={typed} disabled={disabled}
          className="min-h-11 w-24 text-fg"
          onChange={(event) => { setTyped(event.target.value); }}
          onBlur={() => { setTyped(String(quantity)); }} />
      </label> : null}
      <Price usd={total} overview={overview} />
      <p className="m-0 text-xs text-muted">Hasta {agentLimit(plan, quantity)} agentes</p>
      <Button variant="primary" disabled={disabled || busy} onClick={() => { onPay(quantityOf(plan, quantity)); }}>
        Pagar con Mercado Pago
      </Button>
    </article>
  </li>;
}

function Current({ subscription, overview, busy, confirming, onAsk, onAbort, onCancel }: {
  subscription: BillingSubscription; overview: BillingOverview; busy: boolean; confirming: boolean;
  onAsk: () => void; onAbort: () => void; onCancel: () => void;
}) {
  const live = holdsPlan(subscription);
  return <section aria-label="Plan actual" className="grid gap-2 rounded-xl border border-line bg-surface p-4">
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="m-0 text-sm font-semibold">Plan actual: {PLAN_TITLE[subscription.plan]}</h3>
      <Pill tone={subscription.status === 'authorized' ? 'ok' : subscription.status === 'cancelled' ? 'neutral' : 'warn'}>{STATUS_LABEL[subscription.status]}</Pill>
    </div>
    <Price usd={subscription.amount_usd} overview={overview} />
    {subscription.status === 'pending' && subscription.checkout_url && isSecureUrl(subscription.checkout_url)
      ? <p className="m-0 text-xs"><a href={subscription.checkout_url}>Continuar el pago en Mercado Pago</a></p> : null}
    {live ? confirming ? <Notice tone="warn" role="alertdialog" aria-label="Confirmar cancelación">
      <p>¿Cancelar la suscripción? Dejarás de pagar, pero tampoco podrás crear agentes nuevos.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="danger" size="sm" disabled={busy} onClick={onCancel}>Sí, cancelar suscripción</Button>
        <Button size="sm" disabled={busy} onClick={onAbort}>No cancelar</Button>
      </div>
    </Notice> : <div><Button size="sm" disabled={busy} onClick={onAsk}>Cancelar suscripción</Button></div> : null}
  </section>;
}

export function BillingSection() {
  const api = useApi();
  const search = useRouteSearch();
  const [overview, setOverview] = useState<BillingOverview>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [payerEmail, setPayerEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const returned = useRef(false);

  const load = useCallback(async () => {
    try {
      setOverview(await api.getBilling());
      setError(undefined);
    } catch (cause) {
      setError(failure(cause, 'No se pudo leer el plan. Reintenta.'));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (returned.current) return;
    returned.current = true;
    const params = new URLSearchParams(search);
    if (params.get('seccion') === 'plan' && params.get('pago') === 'vuelta') {
      void (async () => {
        try {
          await api.refreshBilling();
          setNotice('Pago recibido: este es el estado de tu suscripción.');
        } catch (cause) {
          setError(failure(cause, 'No se pudo confirmar el pago con Mercado Pago. Reintenta en unos segundos.'));
        }
        await load();
      })();
    } else void load();
  }, [api, load, search]);

  async function act(operation: () => Promise<unknown>, fallback: string, done?: string) {
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      await operation();
      if (done) setNotice(done);
      await load();
    } catch (cause) {
      setError(failure(cause, fallback));
    } finally {
      setBusy(false);
    }
  }

  async function pay(plan: BillingPlan, quantity: number) {
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const payer = payerEmail.trim();
      const { checkout_url } = await api.startBillingCheckout(payer ? { plan: plan.plan, quantity, payer_email: payer } : { plan: plan.plan, quantity });
      if (!isSecureUrl(checkout_url)) throw new Error('insecure checkout url');
      window.location.assign(checkout_url);
    } catch (cause) {
      setError(failure(cause, 'No se pudo iniciar el pago. Reintenta.'));
      setBusy(false);
    }
  }

  const header = <ConfigSectionHeader seccion="plan" />;
  if (loading) return <div className="grid gap-4">{header}<LoadingState label="Leyendo tu plan…" /></div>;
  if (!overview) return <div className="grid gap-4">{header}
    {error === 'Pagos sin configurar' ? <Notice tone="info" role="note">Pagos sin configurar</Notice>
      : <Notice tone="danger" role="alert" className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1">{error}</span>
        <Button size="sm" onClick={() => { void load(); }}>Reintentar</Button>
      </Notice>}
  </div>;

  const { subscription, allowance } = overview;
  const blocked = holdsPlan(subscription);
  const plans = PLAN_ORDER.flatMap((id) => overview.plans.filter((plan) => plan.plan === id));
  return <div className="grid gap-4">
    {header}
    {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}
    {notice ? <Notice tone="ok" role="status">{notice}</Notice> : null}
    {!overview.configured ? <Notice tone="info" role="note">Pagos sin configurar</Notice> : null}
    {overview.exempt ? <Notice tone="info" role="note">Esta empresa no paga plan</Notice> : null}
    <p className="m-0 text-sm" aria-label="Agentes usados">
      Agentes: <strong className="tabular-nums">{allowance.used}</strong>
      {overview.exempt ? ' en uso, sin límite de plan' : <> de <strong className="tabular-nums">{allowance.limit ?? 0}</strong></>}
    </p>
    {subscription && !overview.exempt ? <Current subscription={subscription} overview={overview} busy={busy} confirming={confirming}
      onAsk={() => { setConfirming(true); }} onAbort={() => { setConfirming(false); }}
      onCancel={() => { setConfirming(false); void act(() => api.cancelBilling(), 'No se pudo cancelar la suscripción. Reintenta.', 'Suscripción cancelada.'); }} /> : null}
    {overview.configured && !overview.exempt ? <section aria-labelledby="planes-disponibles" className="grid gap-3">
      <h3 id="planes-disponibles" className="m-0 text-sm font-semibold">Planes</h3>
      {blocked ? <p className="m-0 text-xs text-muted">Para cambiar de plan, cancela primero la suscripción actual.</p> : null}
      {!blocked ? <label className="grid max-w-md gap-1 text-xs text-muted">
        Correo de tu cuenta de Mercado Pago
        <input type="email" autoComplete="email" value={payerEmail} disabled={busy} placeholder="el correo con el que entras a Mercado Pago"
          className="min-h-11 text-fg" onChange={(event) => { setPayerEmail(event.target.value); }} />
        <span>Mercado Pago solo acepta el pago desde la cuenta de este correo. Vacío, se usa el correo de tu sesión.</span>
      </label> : null}
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))] gap-3 p-0">
        {plans.map((plan) => <PlanCard key={plan.plan} plan={plan} overview={overview} disabled={blocked} busy={busy}
          onPay={(quantity) => { void pay(plan, quantity); }} />)}
      </ul>
    </section> : null}
  </div>;
}
