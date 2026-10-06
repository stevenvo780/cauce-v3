/** Test-only narrowing: fails with a readable message instead of a TypeError on `undefined`. */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what} to exist`);
  return value;
}
