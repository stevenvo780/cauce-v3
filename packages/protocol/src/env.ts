export interface IntegerEnvOptions {
  readonly fallback: number;
  readonly min?: number;
  readonly max?: number;
}

function integerBoundLabel(min: number): string {
  if (min === 0) return 'a non-negative integer';
  if (min === 1) return 'a positive integer';
  return `a safe integer of at least ${String(min)}`;
}

export function requiredEnv(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function integerEnv(
  environment: NodeJS.ProcessEnv,
  name: string,
  options: IntegerEnvOptions,
): number {
  const raw = environment[name];
  const value = raw === undefined ? options.fallback : Number(raw);
  const min = options.min ?? 1;
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`${name} must be ${integerBoundLabel(min)}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new Error(`${name} must be an integer between ${String(min)} and ${String(options.max)}`);
  }
  return value;
}

export function booleanEnv(environment: NodeJS.ProcessEnv, name: string, fallback = false): boolean {
  const raw = environment[name];
  return raw === undefined ? fallback : raw === '1';
}

export function portEnv(environment: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = integerEnv(environment, name, { fallback });
  if (value > 65_535) throw new Error(`${name} must be a valid TCP port`);
  return value;
}
