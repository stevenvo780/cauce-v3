import { colaNecesitaAtencion, type SaludDeCola } from './queue-health';

/** `detallada` = one chip per figure, known zeros included; `breve` = a single line with only what is above zero. */
type FormaDeLaCola = 'detallada' | 'breve';

interface CifraViva {
  kind: 'pending' | 'running';
  texto: string;
}

/** An incomplete reading is NEVER brief: a missing figure is UNKNOWN, and abbreviating it away hides it as a 0 would. */
export function formaDeLaCola(salud: SaludDeCola | undefined): FormaDeLaCola {
  if (colaNecesitaAtencion(salud)) return 'detallada';
  const cifras = [salud?.pendientes, salud?.enCurso, salud?.reintentos, salud?.muertas];
  return cifras.every((cifra) => cifra !== undefined) ? 'breve' : 'detallada';
}

/** A brief row has retries and dead deliveries at a known zero, so only these two can carry news. */
export function cifrasVivas(salud: SaludDeCola | undefined): CifraViva[] {
  const vivas: CifraViva[] = [];
  if (salud?.pendientes) vivas.push({ kind: 'pending', texto: `${String(salud.pendientes)} en cola` });
  if (salud?.enCurso) vivas.push({ kind: 'running', texto: `${String(salud.enCurso)} en curso` });
  return vivas;
}
