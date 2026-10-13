// What every test PostgreSQL container carries, wherever it is started: the per-file server of
// postgres.ts and the fixtures that mount their own template server.

export const COMANDO_POSTGRES_DE_PRUEBA: readonly string[] = [ // non-durable: docs/entorno-de-desarrollo-con-base-real.md
  'postgres', '-c', 'fsync=off', '-c', 'full_page_writes=off',
];

export function etiquetasDelPasoDelGate(entorno: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const paso = entorno.CAUCE_RELEASE_GATES_PASO; // el gate retira por esta etiqueta lo que un paso cortado deja
  return paso ? { 'io.cauce.gate.paso': paso } : {};
}
