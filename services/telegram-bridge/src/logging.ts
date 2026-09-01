/** Same shape the dispatcher uses: one JSON object per line on stderr. */
export function logJsonLine(record: Record<string, unknown>): void {
  console.error(JSON.stringify(record));
}
