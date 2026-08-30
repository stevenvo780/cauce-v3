export function requireValue<T>(value: T, what: string): NonNullable<T> {
  if (value === undefined || value === null) throw new Error(`expected ${what}, got ${value === undefined ? 'undefined' : 'null'}`);
  return value;
}