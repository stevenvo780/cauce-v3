const MAX_VISIBLE = 320;
const MAX_FIELDS = 8;
const MAX_DEPTH = 2;

function bounded(value: string, maximum: number): string {
  const printable = Array.from(value).map((character) => {
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
      ? `${primitives.slice(0, 3).map(scalar).join(', ')}${value.length > 3 ? ` (+${String(value.length - 3)})` : ''}`
      : `${String(value.length)} elementos`;
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
    output.push(prefix ? `${prefix}: ${String(entries.length)} campos` : `${String(entries.length)} campos`);
    return;
  }
  for (const [key, child] of entries) {
    if (output.length >= MAX_FIELDS) break;
    const childLabel = [prefix, label(key)].filter(Boolean).join(' · ');
    collect(child, childLabel, depth + 1, output);
  }
}

const AUDIT_VERBS: Record<string, string> = {
  create: 'Alta',
  update: 'Cambio',
  delete: 'Baja',
  retire: 'Retiro',
  reconcile: 'Conciliación',
  grant: 'Concesión',
  revoke: 'Revocación',
  ack: 'Confirmación',
  denied: 'Denegación',
  write: 'Escritura',
  read: 'Lectura',
  consume: 'Consumo',
  request: 'Solicitud',
  resume: 'Reanudación',
  close: 'Cierre',
  sync: 'Sincronización',
  publish: 'Publicación',
  archive: 'Archivo',
};

const AUDIT_NOUNS: Record<string, string> = {
  platform: 'plataforma',
  company: 'empresa',
  fleet: 'flota',
  event: 'evento',
  audit: 'auditoría',
  tenant: 'espacio',
  room: 'sala',
  agent: 'agente',
  membership: 'membresía',
  account: 'cuenta',
  session: 'sesión',
  terminal: 'terminal',
  delivery: 'entrega',
  context: 'contexto',
  document: 'documento',
  appearance: 'aspecto',
  admin: 'administración',
  state: 'estado',
  quota: 'cuota',
  config: 'configuración',
  configuration: 'configuración',
  acl: 'permiso',
  user: 'persona',
  host: 'máquina',
  profile: 'perfil',
};

function auditWord(token: string): string {
  const noun = AUDIT_NOUNS[token];
  if (noun) return noun;
  const verb = AUDIT_VERBS[token];
  if (verb) return verb.toLocaleLowerCase('es');
  const pieces = token.split(/[_-]+/u).filter(Boolean);
  if (pieces.length > 1) return pieces.map(auditWord).join(' ');
  return token.replace(/([a-z])([A-Z])/gu, '$1 $2').toLocaleLowerCase('es');
}

/** Operator sentence for an action id. The last segment is a verb only when it is in the dictionary. */
export function readableAuditAction(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parts = value.trim().split('.').filter(Boolean);
  if (parts.length === 0) return undefined;
  const last = parts[parts.length - 1] ?? '';
  const verb = AUDIT_VERBS[last];
  if (verb && parts.length > 1) {
    const rest = parts.slice(0, -1).map(auditWord);
    const object = rest[rest.length - 1] ?? 'registro';
    const scope = rest.slice(0, -1);
    return scope.length > 0 ? `${verb} de ${object}, en ${scope.join(', ')}` : `${verb} de ${object}`;
  }
  const sentence = parts.map(auditWord).join(' · ');
  return sentence.charAt(0).toLocaleUpperCase('es') + sentence.slice(1);
}

export const AUDIT_DECISION_LABEL = { allow: 'Permitido', deny: 'Denegado', info: 'Aviso' } as const;

/**
 * Turns the allowlisted JSON summary of the audit log into a sentence for the operator.
 * React preserves the HTML escape; this function only decides text and never returns markup.
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
