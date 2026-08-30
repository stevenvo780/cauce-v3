export function requireValue<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what}, got undefined`);
  return value;
}