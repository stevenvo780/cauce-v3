import { BillingSection } from './BillingSection';

/** The plan as its own page in the main navigation, so paying never hides behind the settings. */
export function PlanPage() {
  return <div className="grid gap-6">
    <header>
      <h1 className="m-0 text-2xl font-semibold">Plan y pagos</h1>
      <p className="m-0 mt-1 max-w-2xl text-sm text-muted">Elige el plan de tu empresa y págalo cada mes con Mercado Pago.</p>
    </header>
    <BillingSection bare />
  </div>;
}
