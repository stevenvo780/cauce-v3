// Fixture budgets are sized on an idle host. The release gate's shards share one Docker daemon, so the gate
// exports CAUCE_PLAZOS_FACTOR and every budget stretches by it; a budget only bounds a hang, the checks stay.
export function factorDePlazos(entorno: NodeJS.ProcessEnv = process.env): number {
  const crudo = entorno.CAUCE_PLAZOS_FACTOR;
  if (crudo === undefined || crudo === '') return 1;
  const factor = Number(crudo);
  if (!Number.isFinite(factor) || factor < 1 || factor > 20) throw new Error(`CAUCE_PLAZOS_FACTOR inválido: ${crudo}`);
  return factor;
}

export function plazo(ms: number, entorno: NodeJS.ProcessEnv = process.env): number {
  return Math.ceil(ms * factorDePlazos(entorno));
}
