const ACTION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/u;

export interface AuditFilterDraft {
  trace: string;
  alias: string;
  action: string;
  from: string;
  to: string;
}

export interface AuditServerQuery {
  trace_id?: string;
  alias?: string;
  action?: string;
  from?: string;
  to?: string;
}

export const EMPTY_AUDIT_FILTER: AuditFilterDraft = {
  trace: '', alias: '', action: '', from: '', to: '',
};

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function isUtcInstant(value: string): boolean {
  if (value.length > 64 || !UTC_PATTERN.test(value) || Number.isNaN(Date.parse(value))) return false;
  const match = UTC_PATTERN.exec(value);
  if (match === null) return false;
  const date = new Date(value);
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() + 1 === Number(match[2])
    && date.getUTCDate() === Number(match[3])
    && date.getUTCHours() === Number(match[4])
    && date.getUTCMinutes() === Number(match[5])
    && date.getUTCSeconds() === Number(match[6]);
}

/** Operator-facing reason the gateway would reject this filter. Empty fields are "no filter". */
export function auditFilterProblem(input: AuditFilterDraft): string | undefined {
  if (input.trace !== '' && (input.trace.length > 256 || hasControlCharacter(input.trace))) {
    return 'La traza no es un identificador que el servidor acepte.';
  }
  if (input.alias !== '' && !ALIAS_PATTERN.test(input.alias)) {
    return 'El alias tiene que ser el del servidor: minúsculas, dígitos, guion o guion bajo.';
  }
  if (input.action !== '' && !ACTION_PATTERN.test(input.action)) {
    return 'La acción tiene que ser el identificador exacto, por ejemplo delivery.cancel.';
  }
  if (input.from !== '' && !isUtcInstant(input.from)) {
    return 'Desde tiene que ser una fecha UTC, por ejemplo 2020-01-01T00:00:00Z.';
  }
  if (input.to !== '' && !isUtcInstant(input.to)) {
    return 'Hasta tiene que ser una fecha UTC, por ejemplo 2020-01-01T23:59:59Z.';
  }
  if (input.from !== '' && input.to !== '' && Date.parse(input.from) > Date.parse(input.to)) {
    return 'Desde no puede ser posterior a hasta.';
  }
  return undefined;
}

export function auditServerQuery(input: AuditFilterDraft): AuditServerQuery {
  const problem = auditFilterProblem(input);
  if (problem !== undefined) throw new RangeError(problem);
  return {
    ...(input.trace === '' ? {} : { trace_id: input.trace }),
    ...(input.alias === '' ? {} : { alias: input.alias }),
    ...(input.action === '' ? {} : { action: input.action }),
    ...(input.from === '' ? {} : { from: input.from }),
    ...(input.to === '' ? {} : { to: input.to }),
  };
}

export function auditFilterKey(input: AuditFilterDraft): string {
  return JSON.stringify([input.trace, input.alias, input.action, input.from, input.to]);
}
