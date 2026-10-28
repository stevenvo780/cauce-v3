import { Building2, Check, MessageSquareText, Minus, Network, Plus, TerminalSquare } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../../api/client/core';
import type { BillingCoupon, BillingOverview, BillingPlan, BillingPlanId, BillingSubscription } from '../../api/client/billing-client';
import { useApi } from '../../api/context';
import { cn } from '../../cn';
import { FormDialog } from '../../components/dialogs';
import { Button, LinkButton, Notice, Pill } from '../../components/kit';
import { LoadingState } from '../../components/ui';
import { useRouteSearch } from '../../router';
import { ConfigSectionHeader } from './ConfigSectionHeader';
import {
  PLAN_ORDER, PLAN_TITLE, QUANTITY_RANGE, STATUS_LABEL,
  agentLimit, clampQuantity, discounted, formatLocal, formatUsd, holdsPlan, quantityOf, totalUsd,
} from './billing-model';
import { BILLING_FAQ, EVERY_PLAN, PLAN_PROMISE } from './plan-copy';

const RECOMMENDED_AT = 3;
const EVERY_PLAN_ICON = [MessageSquareText, Building2, TerminalSquare, Network];

function failure(cause: unknown, fallback: string): string {
  if (cause instanceof ApiError) {
    if (cause.code === 'billing_unconfigured') return 'Pagos sin configurar';
    if (cause.code === 'invalid_coupon') return 'Ese cupón no existe, venció o ya se usó.';
    if (cause.status === 409) return 'Esta empresa ya tiene una suscripción activa o pendiente. Cancélala antes de contratar otra.';
    if (cause.status === 403) return 'Tu autoridad de empresa no permite gestionar el plan.';
  }
  return fallback;
}

function isSecureUrl(value: string): boolean {
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}

/** Pesos carry their code: «$» alone reads as dollars next to a dollar price. */
function localOf(usd: number, overview: BillingOverview): string | undefined {
  const local = formatLocal(usd, overview.currency, overview.usd_rate, overview.fee);
  return local ? `${local} ${overview.currency}` : undefined;
}

/** What the buyer is about to pay for: a plan and how many seats or spaces. */
interface Choice { plan: BillingPlan; quantity: number }

function Includes({ items }: { items: readonly string[] }) {
  return <ul className="m-0 grid list-none gap-2 p-0 text-[13px]">
    {items.map((item) => <li key={item} className="flex items-start gap-2">
      <Check size={15} aria-hidden={true} className="mt-0.5 shrink-0 text-ok" />
      <span>{item}</span>
    </li>)}
  </ul>;
}

/** A number field with − and + beside it: the field stays typeable, the buttons save a trip to the keyboard. */
function Stepper({ plan, label, typed, disabled, onType }: {
  plan: BillingPlanId; label: string; typed: string; disabled: boolean; onType: (value: string) => void;
}) {
  const range = QUANTITY_RANGE[plan];
  if (!range) return null;
  const value = clampQuantity(plan, Number(typed));
  const step = 'grid size-11 cursor-pointer place-items-center border-0 bg-transparent text-fg-2 enabled:hover:bg-subtle enabled:hover:text-fg disabled:cursor-not-allowed disabled:opacity-40';
  return <label className="grid gap-1.5 text-xs font-medium text-fg-2">
    {label}
    <span className="flex w-fit items-center overflow-hidden rounded-lg border border-line-strong bg-surface">
      <button type="button" aria-label={`Menos ${label.toLowerCase()}`} disabled={disabled || value <= range.min} className={step}
        onClick={() => { onType(String(value - 1)); }}><Minus size={16} aria-hidden="true" /></button>
      <input type="number" inputMode="numeric" min={range.min} max={range.max} value={typed} disabled={disabled}
        className="min-h-11 w-14 border-x border-y-0 border-line bg-transparent text-center text-base font-semibold text-fg tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
        onChange={(event) => { onType(event.target.value); }}
        onBlur={() => { onType(String(value)); }} />
      <button type="button" aria-label={`Más ${label.toLowerCase()}`} disabled={disabled || value >= range.max} className={step}
        onClick={() => { onType(String(value + 1)); }}><Plus size={16} aria-hidden="true" /></button>
    </span>
  </label>;
}

function useChosenScroll(chosen: boolean) {
  const card = useRef<HTMLElement>(null);
  useEffect(() => { if (chosen && typeof card.current?.scrollIntoView === 'function') card.current.scrollIntoView({ block: 'center' }); }, [chosen]);
  return card;
}

const CHOSEN_RING = 'ring-2 ring-brand ring-offset-2 ring-offset-canvas';

/** The managed plan carries the page: the price is the headline and the total follows the seats as they change. */
function FeaturedPlan({ plan, overview, disabled, chosen, onChoose }: {
  plan: BillingPlan; overview: BillingOverview; disabled: boolean; chosen: boolean; onChoose: (choice: Choice) => void;
}) {
  const card = useChosenScroll(chosen);
  const [typed, setTyped] = useState(String(QUANTITY_RANGE[plan.plan]?.initial ?? RECOMMENDED_AT));
  const quantity = clampQuantity(plan.plan, Number(typed));
  const total = totalUsd(plan, quantity);
  const local = localOf(total, overview);
  const recommended = quantity === (plan.recommended_quantity ?? RECOMMENDED_AT);
  const promise = PLAN_PROMISE[plan.plan];
  return <article ref={card} aria-label={PLAN_TITLE[plan.plan]} aria-current={chosen ? 'true' : undefined}
    className={cn('flex flex-col gap-5 rounded-2xl border-2 border-brand bg-surface p-6 shadow-pop max-[760px]:p-4', chosen && CHOSEN_RING)}>
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 text-xl font-semibold tracking-tight">{PLAN_TITLE[plan.plan]}</h3>
        {recommended ? <Pill tone="ok">Recomendado</Pill> : null}
      </div>
      <p className="m-0 text-sm text-fg-2">{promise.lead}</p>
    </div>
    <p className="m-0 flex flex-wrap items-baseline gap-x-2">
      <strong className="text-5xl font-semibold tracking-tight tabular-nums">{formatUsd(plan.price_usd)}</strong>
      <span className="text-sm text-muted">por agente al mes</span>
    </p>
    <div className="flex flex-wrap items-end gap-4">
      <Stepper plan={plan.plan} label="Agentes" typed={typed} disabled={disabled} onType={setTyped} />
      <p className="m-0 pb-3 text-xs text-muted">Recomendamos empezar con {plan.recommended_quantity ?? RECOMMENDED_AT}.</p>
    </div>
    <div className="grid gap-1 rounded-xl bg-brand-soft p-4" aria-live="polite">
      <p className="m-0 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-sm font-medium text-brand-ink">Hasta {agentLimit(plan, quantity)} agentes</span>
        <strong className="text-2xl font-semibold tabular-nums">{formatUsd(total)}<span className="text-sm font-normal text-muted"> al mes</span></strong>
      </p>
      {local ? <p className="m-0 text-right text-xs text-muted tabular-nums">
        {overview.fee ? `${local} al mes, con la comisión de Mercado Pago` : `≈ ${local} al mes`}
      </p> : null}
    </div>
    <Button variant="primary" disabled={disabled} className="min-h-11 text-sm"
      onClick={() => { onChoose({ plan, quantity: quantityOf(plan, quantity) }); }}>
      Contratar {PLAN_TITLE[plan.plan]}
    </Button>
    <Includes items={promise.includes} />
  </article>;
}

function CompactPlan({ plan, overview, disabled, chosen, onChoose }: {
  plan: BillingPlan; overview: BillingOverview; disabled: boolean; chosen: boolean; onChoose: (choice: Choice) => void;
}) {
  const card = useChosenScroll(chosen);
  const range = QUANTITY_RANGE[plan.plan];
  const [typed, setTyped] = useState(String(range?.initial ?? 1));
  const quantity = clampQuantity(plan.plan, Number(typed));
  const total = totalUsd(plan, quantity);
  const local = localOf(total, overview);
  const promise = PLAN_PROMISE[plan.plan];
  return <li className="flex">
    <article ref={card} aria-label={PLAN_TITLE[plan.plan]} aria-current={chosen ? 'true' : undefined}
      className={cn('flex flex-1 flex-col gap-4 rounded-xl border border-line bg-surface p-5', chosen && CHOSEN_RING)}>
      <div className="grid gap-1">
        <h4 className="m-0 text-base font-semibold">{PLAN_TITLE[plan.plan]}</h4>
        <p className="m-0 text-xs leading-relaxed text-muted">{promise.lead}</p>
      </div>
      <p className="m-0 grid gap-0.5">
        <strong className="text-3xl font-semibold tracking-tight tabular-nums">{formatUsd(total)}</strong>
        <span className="text-xs text-muted">{range ? `al mes por ${String(quantity)} ${quantity === 1 ? 'espacio' : 'espacios'}` : 'al mes por empresa'}</span>
        {local ? <span className="text-xs text-muted tabular-nums">{overview.fee ? `${local} con la comisión de Mercado Pago` : `≈ ${local}`}</span> : null}
      </p>
      {range ? <Stepper plan={plan.plan} label="Espacios" typed={typed} disabled={disabled} onType={setTyped} /> : null}
      {range ? <p className="m-0 text-xs font-medium text-fg-2">Hasta {agentLimit(plan, quantity)} agentes</p> : null}
      <Includes items={promise.includes} />
      <Button variant="secondary" disabled={disabled} className="mt-auto min-h-10"
        onClick={() => { onChoose({ plan, quantity: quantityOf(plan, quantity) }); }}>
        Contratar {PLAN_TITLE[plan.plan]}
      </Button>
    </article>
  </li>;
}

function Usage({ overview }: { overview: BillingOverview }) {
  const { allowance, subscription } = overview;
  const limited = !overview.exempt && subscription?.status === 'authorized';
  return <p className="m-0 text-sm" aria-label="Agentes usados">
    Agentes: <strong className="tabular-nums">{allowance.used}</strong>
    {overview.exempt ? ' en uso, sin límite de plan'
      : limited ? <> de <strong className="tabular-nums">{allowance.limit ?? 0}</strong></>
        : ' en uso, sin plan activo'}
  </p>;
}

function Current({ subscription, overview, busy, confirming, onAsk, onAbort, onCancel }: {
  subscription: BillingSubscription; overview: BillingOverview; busy: boolean; confirming: boolean;
  onAsk: () => void; onAbort: () => void; onCancel: () => void;
}) {
  const live = holdsPlan(subscription);
  const local = localOf(subscription.amount_usd, overview);
  const unit = subscription.plan === 'espacio' ? `${String(subscription.quantity)} ${subscription.quantity === 1 ? 'espacio' : 'espacios'}`
    : `hasta ${String(subscription.agent_limit)} agentes`;
  return <section aria-label="Plan actual" className="grid gap-3 rounded-2xl border border-line bg-surface p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="m-0 text-base font-semibold">Tu plan: {PLAN_TITLE[subscription.plan]}</h3>
          <Pill tone={subscription.status === 'authorized' ? 'ok' : subscription.status === 'cancelled' ? 'neutral' : 'warn'}>{STATUS_LABEL[subscription.status]}</Pill>
        </div>
        <p className="m-0 text-xs text-muted">{unit}</p>
        {subscription.coupon_code && subscription.percent_off ? <p className="m-0 text-xs text-muted">
          Cupón {subscription.coupon_code}: {String(subscription.percent_off)}% menos cada mes</p> : null}
        <Usage overview={overview} />
      </div>
      <p className="m-0 grid text-right">
        <strong className="text-2xl font-semibold tabular-nums">{formatUsd(subscription.amount_usd)}<span className="text-sm font-normal text-muted"> al mes</span></strong>
        {local ? <span className="text-xs text-muted tabular-nums">{overview.fee ? `${local} con la comisión de Mercado Pago` : `≈ ${local}`}</span> : null}
      </p>
    </div>
    {subscription.status === 'pending' && subscription.checkout_url && isSecureUrl(subscription.checkout_url)
      ? <div className="flex flex-wrap items-center gap-3">
        <LinkButton variant="primary" href={subscription.checkout_url} className="min-h-10">Continuar el pago en Mercado Pago</LinkButton>
        <span className="text-xs text-muted">Tu plan se activa en cuanto Mercado Pago aprueba el pago.</span>
      </div> : null}
    {live ? confirming ? <Notice tone="warn" role="alertdialog" aria-label="Confirmar cancelación">
      <p>¿Cancelar la suscripción? Dejarás de pagar, pero tampoco podrás crear agentes nuevos.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="danger" size="sm" disabled={busy} onClick={onCancel}>Sí, cancelar suscripción</Button>
        <Button size="sm" disabled={busy} onClick={onAbort}>No cancelar</Button>
      </div>
    </Notice> : <div><Button variant="ghost" size="sm" disabled={busy} onClick={onAsk}>Cancelar suscripción</Button></div> : null}
  </section>;
}

function CouponField({ coupon, busy, onCheck, onClear }: {
  coupon: BillingCoupon | undefined; busy: boolean; onCheck: (code: string) => Promise<BillingCoupon>; onClear: () => void;
}) {
  const [code, setCode] = useState('');
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string>();
  if (coupon) return <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-sm">
    <span>Cupón <strong>{coupon.code}</strong>: {String(coupon.percent_off)}% menos cada mes</span>
    <Button size="sm" disabled={busy} onClick={onClear}>Quitar</Button>
  </div>;
  async function apply() {
    if (!code.trim()) return;
    setChecking(true); setProblem(undefined);
    try {
      await onCheck(code.trim());
      setCode('');
    } catch (cause) {
      setProblem(cause instanceof ApiError && cause.status === 404 ? 'Ese cupón no existe, venció o ya se usó.' : 'No se pudo revisar el cupón. Reintenta.');
    } finally {
      setChecking(false);
    }
  }
  return <div className="grid gap-1 text-xs font-medium text-fg-2">
    <label htmlFor="cupon-plan">¿Tienes un cupón?</label>
    <div className="flex gap-2">
      <input id="cupon-plan" value={code} disabled={busy || checking} autoComplete="off" spellCheck={false}
        className="min-h-10 min-w-0 flex-1 uppercase text-fg" onChange={(event) => { setCode(event.target.value); }}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void apply(); } }} />
      <Button disabled={busy || checking || !code.trim()} onClick={() => { void apply(); }}>{checking ? 'Revisando…' : 'Aplicar'}</Button>
    </div>
    {problem ? <span role="alert" className="font-normal text-danger">{problem}</span> : null}
  </div>;
}

function CheckoutDialog({ choice, overview, busy, error, onClose, onPay, onCheckCoupon }: {
  choice: Choice | undefined; overview: BillingOverview; busy: boolean; error?: string;
  onClose: () => void; onPay: (payerEmail: string, coupon?: string) => void; onCheckCoupon: (code: string) => Promise<BillingCoupon>;
}) {
  const [payerEmail, setPayerEmail] = useState('');
  const [coupon, setCoupon] = useState<BillingCoupon>();
  if (!choice) return null;
  const { plan, quantity } = choice;
  const list = totalUsd(plan, quantity);
  const total = discounted(list, coupon?.percent_off);
  const local = localOf(total, overview);
  const size = plan.plan === 'gestionado' ? `${String(quantity)} ${quantity === 1 ? 'agente' : 'agentes'}`
    : plan.plan === 'espacio' ? `${String(quantity)} ${quantity === 1 ? 'espacio' : 'espacios'}, hasta ${String(agentLimit(plan, quantity))} agentes`
      : `Hasta ${String(agentLimit(plan, quantity))} agentes`;
  const row = (term: string, value: ReactNode) => <div className="flex items-baseline justify-between gap-3 py-2">
    <span className="text-xs text-muted">{term}</span><span className="text-right text-sm font-medium">{value}</span>
  </div>;
  return <FormDialog open busy={busy} onClose={onClose} title="Confirma tu plan"
    description="Te llevamos a Mercado Pago para pagar de forma segura."
    footer={<div className="flex flex-wrap justify-end gap-2">
      <Button disabled={busy} onClick={onClose}>Volver</Button>
      <Button variant="primary" disabled={busy} onClick={() => { onPay(payerEmail.trim(), coupon?.code); }}>
        {busy ? 'Abriendo Mercado Pago…' : 'Pagar con Mercado Pago'}
      </Button>
    </div>}>
    <div className="grid divide-y divide-line">
      {row('Plan', PLAN_TITLE[plan.plan])}
      {row('Incluye', size)}
      {row('Precio', coupon ? <><s className="font-normal text-muted">{formatUsd(list)}</s> {formatUsd(total)} al mes</> : `${formatUsd(total)} al mes`)}
    </div>
    <CouponField coupon={coupon} busy={busy} onClear={() => { setCoupon(undefined); }}
      onCheck={async (code) => { const found = await onCheckCoupon(code); setCoupon(found); return found; }} />
    {local ? <div className="grid gap-0.5 rounded-xl bg-brand-soft p-4">
      <span className="text-xs font-medium text-brand-ink">Pagas hoy</span>
      <strong className="text-3xl font-semibold tracking-tight tabular-nums">{local}</strong>
      <span className="text-xs text-muted">{overview.fee ? 'Incluye la comisión de Mercado Pago. ' : ''}Después, el mismo valor cada mes, el mismo día.</span>
    </div> : null}
    <label className="grid gap-1 text-xs font-medium text-fg-2">
      Correo de tu cuenta de Mercado Pago
      <input type="email" autoComplete="email" value={payerEmail} disabled={busy} placeholder="el correo con el que entras a Mercado Pago"
        className="min-h-11 text-fg" onChange={(event) => { setPayerEmail(event.target.value); }} />
      <span className="font-normal text-muted">Mercado Pago solo acepta el pago desde la cuenta de este correo. Si lo dejas vacío, usamos el correo con el que entras a Cauce.</span>
    </label>
    {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}
  </FormDialog>;
}

function EveryPlan() {
  return <section aria-labelledby="todos-incluyen" className="grid gap-4">
    <h3 id="todos-incluyen" className="m-0 text-base font-semibold">Todos los planes incluyen la red Cauce</h3>
    <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,13rem),1fr))] gap-x-6 gap-y-4 p-0">
      {EVERY_PLAN.map((item, index) => {
        const Icon = EVERY_PLAN_ICON[index] ?? Check;
        return <li key={item.title} className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <span className="row-span-2 grid size-9 place-items-center rounded-lg bg-brand-soft text-brand-ink"><Icon size={17} aria-hidden={true} /></span>
          <strong className="text-sm font-semibold">{item.title}</strong>
          <span className="text-xs leading-relaxed text-muted">{item.body}</span>
        </li>;
      })}
    </ul>
  </section>;
}

function Faq() {
  return <section aria-labelledby="preguntas-pago" className="grid max-w-3xl gap-2">
    <h3 id="preguntas-pago" className="m-0 text-base font-semibold">Preguntas frecuentes</h3>
    <div className="grid divide-y divide-line border-y border-line">
      {BILLING_FAQ.map((item) => <details key={item.question} className="group py-3">
        <summary className="cursor-pointer text-sm font-medium">{item.question}</summary>
        <p className="m-0 mt-2 max-w-prose text-[13px] leading-relaxed text-fg-2">{item.answer}</p>
      </details>)}
    </div>
  </section>;
}

/** `bare` drops the section header when the plan is its own page. */
export function BillingSection({ bare = false }: { bare?: boolean } = {}) {
  const api = useApi();
  const search = useRouteSearch();
  const [overview, setOverview] = useState<BillingOverview>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [choice, setChoice] = useState<Choice>();
  const [checkoutError, setCheckoutError] = useState<string>();
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
    if (params.get('pago') === 'vuelta') {
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

  async function pay(payer: string, coupon?: string) {
    if (!choice) return;
    setBusy(true); setCheckoutError(undefined);
    try {
      const { plan, quantity } = choice;
      const { checkout_url } = await api.startBillingCheckout({ plan: plan.plan, quantity, ...(payer ? { payer_email: payer } : {}), ...(coupon ? { coupon } : {}) });
      if (!isSecureUrl(checkout_url)) throw new Error('insecure checkout url');
      window.location.assign(checkout_url);
    } catch (cause) {
      setCheckoutError(failure(cause, 'No se pudo iniciar el pago. Reintenta.'));
      setBusy(false);
    }
  }

  const header = bare ? null : <ConfigSectionHeader seccion="plan" />;
  if (loading) return <div className="grid gap-4">{header}<LoadingState label="Leyendo tu plan…" /></div>;
  if (!overview) return <div className="grid gap-4">{header}
    {error === 'Pagos sin configurar' ? <Notice tone="info" role="note">Pagos sin configurar</Notice>
      : <Notice tone="danger" role="alert" className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1">{error}</span>
        <Button size="sm" onClick={() => { void load(); }}>Reintentar</Button>
      </Notice>}
  </div>;

  const { subscription } = overview;
  const blocked = holdsPlan(subscription);
  const disabled = blocked || overview.exempt || busy;
  const requested = new URLSearchParams(search).get('plan');
  const plans = PLAN_ORDER.flatMap((id) => overview.plans.filter((plan) => plan.plan === id));
  const featured = plans.find((plan) => plan.plan === 'gestionado');
  const own = plans.filter((plan) => plan.plan !== 'gestionado');
  const choose = (next: Choice) => { setCheckoutError(undefined); setChoice(next); };
  return <div className="grid gap-8">
    {header}
    {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}
    {notice ? <Notice tone="ok" role="status">{notice}</Notice> : null}
    {!overview.configured ? <Notice tone="info" role="note">Pagos sin configurar</Notice> : null}
    {overview.exempt ? <Notice tone="info" role="note">Esta empresa no paga plan</Notice> : null}
    {subscription && !overview.exempt ? <Current subscription={subscription} overview={overview} busy={busy} confirming={confirming}
      onAsk={() => { setConfirming(true); }} onAbort={() => { setConfirming(false); }}
      onCancel={() => { setConfirming(false); void act(() => api.cancelBilling(), 'No se pudo cancelar la suscripción. Reintenta.', 'Suscripción cancelada.'); }} />
      : <Usage overview={overview} />}
    {overview.configured ? <section aria-labelledby="planes-disponibles" className="grid gap-4">
      <div className="grid gap-1">
        <h3 id="planes-disponibles" className="m-0 text-base font-semibold">Planes</h3>
        {overview.exempt ? <p className="m-0 text-xs text-muted">Se muestran como referencia: esta empresa no paga.</p> : null}
        {blocked && !overview.exempt ? <p className="m-0 text-xs text-muted">Para cambiar de plan, cancela primero la suscripción actual.</p> : null}
      </div>
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,4fr)_minmax(0,7fr)]">
        {featured ? <FeaturedPlan plan={featured} overview={overview} disabled={disabled} chosen={requested === featured.plan} onChoose={choose} /> : null}
        {own.length > 0 ? <section aria-labelledby="planes-propios" className="grid gap-3">
          <div className="grid gap-1">
            <h4 id="planes-propios" className="m-0 text-base font-semibold">Con tus ordenadores y tus cuentas de IA</h4>
            <p className="m-0 max-w-prose text-xs leading-relaxed text-muted">Tú pones las máquinas y las suscripciones de IA; Cauce pone la red que une a tus agentes.</p>
          </div>
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-3 p-0">
            {own.map((plan) => <CompactPlan key={plan.plan} plan={plan} overview={overview} disabled={disabled}
              chosen={requested === plan.plan} onChoose={choose} />)}
          </ul>
        </section> : null}
      </div>
    </section> : null}
    {overview.configured ? <EveryPlan /> : null}
    {overview.configured ? <Faq /> : null}
    <CheckoutDialog key={choice ? `${choice.plan.plan}:${String(choice.quantity)}` : 'cerrado'} choice={choice} overview={overview}
      busy={busy} error={checkoutError} onClose={() => { setChoice(undefined); }} onPay={(payer, coupon) => { void pay(payer, coupon); }}
      onCheckCoupon={(code) => api.checkBillingCoupon(code)} />
  </div>;
}
