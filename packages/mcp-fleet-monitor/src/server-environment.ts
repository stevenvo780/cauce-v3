const SERVER_ENVIRONMENT = [
  'DATABASE_URL',
  'CAUCE_TENANT_ID',
  'NODE_ENV',
  'PGSSLMODE',
  'PGSSLROOTCERT',
] as const;

type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export function serverEnvironment(source: EnvironmentSource = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of SERVER_ENVIRONMENT) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}
