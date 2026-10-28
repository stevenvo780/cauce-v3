import type { BillingPlanId } from '../../api/client/billing-client';

/** What each plan promises, in the buyer's words: one line of who it is for and the concrete things it includes. */
export const PLAN_PROMISE: Record<BillingPlanId, { lead: string; includes: readonly string[] }> = {
  gestionado: {
    lead: 'Nosotros ponemos todo. Tú solo trabajas con tus agentes.',
    includes: [
      'Cuentas de IA incluidas y probadas',
      'Tus agentes viven en nuestros servidores',
      'Los mantenemos, actualizamos y vigilamos',
      'Un agente por cada plaza que pagas',
    ],
  },
  hotel_20: {
    lead: 'Para equipos que ya tienen ordenadores y cuentas de IA.',
    includes: ['Hasta 20 agentes', 'En tus ordenadores, con tus cuentas', 'Precio fijo por empresa'],
  },
  hotel_50: {
    lead: 'Lo mismo que Hotel 20, con espacio para crecer.',
    includes: ['Hasta 50 agentes', 'En tus ordenadores, con tus cuentas', 'Precio fijo por empresa'],
  },
  espacio: {
    lead: 'Para empezar pequeño y crecer de espacio en espacio.',
    includes: ['5 agentes por espacio', 'Hasta 10 espacios', 'En tus ordenadores, con tus cuentas'],
  },
};

/** Everything every plan carries: the Cauce network itself. */
export const EVERY_PLAN: readonly { title: string; body: string }[] = [
  { title: 'Chat con tus agentes', body: 'Habla con cada agente o con el equipo entero desde el navegador.' },
  { title: 'Oficina en vivo', body: 'Ve quién trabaja, quién espera y quién necesita ayuda.' },
  { title: 'Terminal en el navegador', body: 'Entra a la consola de cualquier agente sin instalar nada.' },
  { title: 'Coordinación entre agentes', body: 'Se pasan tareas, se responden y no pierden mensajes.' },
];

/** The questions a buyer asks before paying, answered plainly. */
export const BILLING_FAQ: readonly { question: string; answer: string }[] = [
  {
    question: '¿Cuándo se cobra?',
    answer: 'El primer cobro se hace al pagar. Después Mercado Pago cobra solo, cada mes, el mismo día.',
  },
  {
    question: '¿Por qué el precio en pesos es mayor que el precio en dólares?',
    answer: 'El precio en pesos ya incluye la comisión de Mercado Pago, para que no tengas cargos sorpresa.',
  },
  {
    question: '¿Qué correo pongo al pagar?',
    answer: 'El de tu cuenta de Mercado Pago. Mercado Pago solo deja pagar desde la cuenta de ese correo.',
  },
  {
    question: '¿Puedo cancelar?',
    answer: 'Sí, cuando quieras, desde esta misma página. Mercado Pago deja de cobrarte y, desde ese momento, no podrás crear agentes nuevos.',
  },
  {
    question: '¿Puedo cambiar de plan?',
    answer: 'Sí. Cancela el plan actual y contrata el nuevo; los agentes que ya tienes se quedan.',
  },
];
