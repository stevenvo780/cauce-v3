/** Whole multiples of the 24-unit grid keep every pixel square; below one grid unit scale there is nothing to snap to. */
export function crispIconSize(target: number): number {
  if (target < 24) return Math.max(10, Math.round(target));
  return Math.max(24, Math.round(target / 24) * 24);
}
