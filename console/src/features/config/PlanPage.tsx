import { CalendarClock, ShieldCheck, Undo2 } from 'lucide-react';
import { BillingSection } from './BillingSection';

const ASSURANCES = [
  { icon: ShieldCheck, text: 'Pago seguro con Mercado Pago' },
  { icon: CalendarClock, text: 'Un cobro al mes, siempre el mismo día' },
  { icon: Undo2, text: 'Cancelas cuando quieras' },
];

/** The plan as its own page in the main navigation, so paying never hides behind the settings. */
export function PlanPage() {
  return <div className="grid gap-8">
    <header className="grid gap-3">
      <h1 className="m-0 max-w-3xl text-3xl font-semibold tracking-tight text-balance">Un equipo de agentes de IA trabajando para tu empresa, por un precio fijo al mes</h1>
      <p className="m-0 max-w-2xl text-sm leading-relaxed text-fg-2">Elige si nosotros nos encargamos de todo o si tus agentes trabajan en tus propios ordenadores. Cambias o cancelas cuando quieras.</p>
      <ul className="m-0 flex list-none flex-wrap gap-x-6 gap-y-2 p-0 text-[13px] text-fg-2">
        {ASSURANCES.map(({ icon: Icon, text }) => <li key={text} className="flex items-center gap-2">
          <Icon size={16} aria-hidden={true} className="text-ok" />{text}
        </li>)}
      </ul>
    </header>
    <BillingSection bare />
  </div>;
}
