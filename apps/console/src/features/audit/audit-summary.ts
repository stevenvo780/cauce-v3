const MAX_VISIBLE = 320;
const MAX_FIELDS = 8;
const MAX_DEPTH = 2;

function bounded(value: string, maximum: number): string {
  const printable = [...value].map((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127 ? ' ' : character;
  }).join('');
  const clean = printable.replace(/\s+/gu, ' ').trim();
  return clean.length <= maximum ? clean : `${clean.slice(0, maximum - 1).trimEnd()}…`;
}

function label(value: string): string {
  return bounded(value.replace(/[_-]+/gu, ' ').replace(/([a-z])([A-Z])/gu, '$1 $2'), 48);
}

function scalar(value: string | number | boolean | null): string {
  if (value === null) return 'sin dato';
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  return bounded(String(value), 96);
}

function collect(
  value: unknown,
  prefix: string,
  depth: number,
  output: string[],
): void {
  if (output.length >= MAX_FIELDS) return;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    output.push(prefix ? `${prefix}: ${scalar(value)}` : scalar(value));
    return;
  }
  if (Array.isArray(value)) {
    const primitives = value.filter((item): item is string | number | boolean | null => (
      item === null || ['string', 'number', 'boolean'].includes(typeof item)
    ));
    const detail = primitives.length === value.length
      ? `${primitives.slice(0, 3).map(scalar).join(', ')}${value.length > 3 ? ` (+${value.length - 3})` : ''}`
      : `${value.length} elementos`;
    output.push(prefix ? `${prefix}: ${detail || 'sin elementos'}` : detail || 'sin elementos');
    return;
  }
  if (typeof value !== 'object') {
    output.push(prefix ? `${prefix}: no legible` : 'Resumen no legible');
    return;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    output.push(prefix ? `${prefix}: sin campos` : 'Sin campos');
    return;
  }
  if (depth >= MAX_DEPTH) {
    output.push(prefix ? `${prefix}: ${entries.length} campos` : `${entries.length} campos`);
    return;
  }
  for (const [key, child] of entries) {
    if (output.length >= MAX_FIELDS) break;
    const childLabel = [prefix, label(key)].filter(Boolean).join(' · ');
    collect(child, childLabel, depth + 1, output);
  }
}

/**
 * Convierte el resumen JSON allowlisted del audit log en una frase para el operador.
 * React conserva el escape HTML; esta función sólo decide texto y nunca devuelve markup.
 */
export function readableAuditSummary(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const plain = bounded(value, MAX_VISIBLE);
  const structured = plain.startsWith('{') || plain.startsWith('[');
  if (!structured) return plain;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return 'Resumen estructurado incompleto o no legible';
  }
  const fields: string[] = [];
  collect(parsed, '', 0, fields);
  const rendered = fields.join(' · ');
  return bounded(rendered || 'Resumen estructurado sin campos', MAX_VISIBLE);
}
