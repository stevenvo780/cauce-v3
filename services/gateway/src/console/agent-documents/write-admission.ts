/**
 * Admission of a governance write: which fields the browser may send and the hand-typed reason
 * that every mutation of an alias' HOME has to carry. Split out of `agent-documents.routes.ts`
 * so that file stays under the size gate.
 */

export type GovernanceWritePrecondition =
  | { readonly state: 'present'; readonly sha256: string }
  | { readonly state: 'absent' };

/**
 * The same bounds the PTY plane applies to its operator reason (`REASON_MIN`/`REASON_MAX`, still
 * private inside `services/gateway/src/terminal/plugin.ts`). Writing a file into the container and
 * opening a shell in it are the same act of authority, so they ask for the same explanation.
 * `agent-documents.routes.test.ts` reads that file and fails if the two ever diverge.
 */
export const DOCUMENT_REASON_MIN = 8;
export const DOCUMENT_REASON_MAX = 280;

export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface AdmittedWrite {
  readonly content: string;
  /** Prose the operator typed. Never defaulted, never generated, never derived from the content. */
  readonly reason: string;
  readonly precondition: GovernanceWritePrecondition;
}

export interface RejectedWrite {
  readonly error: 'invalid_input';
  readonly message: string;
}

const ALLOWED_FIELDS = new Set(['content', 'expected_sha', 'create_if_absent', 'reason']);

export function isRejectedWrite(value: AdmittedWrite | RejectedWrite): value is RejectedWrite {
  return 'error' in value;
}

export function admitGovernanceReason(value: unknown): string | RejectedWrite {
  const limits = `${String(DOCUMENT_REASON_MIN)} y ${String(DOCUMENT_REASON_MAX)}`;
  if (typeof value !== 'string'
    || value.trim().length < DOCUMENT_REASON_MIN || value.length > DOCUMENT_REASON_MAX) {
    return {
      error: 'invalid_input',
      message: `\`reason\` tiene que ser un motivo escrito a mano de entre ${limits} caracteres; `
        + 'la auditoría no inventa uno por nadie',
    };
  }
  return value.trim();
}

function admitPrecondition(
  expectedSha: unknown, createIfAbsent: unknown,
): GovernanceWritePrecondition | RejectedWrite {
  if (createIfAbsent === true && expectedSha === undefined) return { state: 'absent' };
  if ((createIfAbsent === undefined || createIfAbsent === false)
    && typeof expectedSha === 'string' && SHA256_PATTERN.test(expectedSha)) {
    return { state: 'present', sha256: expectedSha };
  }
  return {
    error: 'invalid_input',
    message: 'para reemplazar hace falta `expected_sha`; para crear, `create_if_absent: true` sin SHA',
  };
}

export function admitGovernanceWrite(body: unknown): AdmittedWrite | RejectedWrite {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'invalid_input', message: 'el cuerpo tiene que ser un objeto' };
  }
  const source = body as Record<string, unknown>;
  if (Object.keys(source).some((field) => !ALLOWED_FIELDS.has(field))) {
    return { error: 'invalid_input', message: 'el cuerpo trae campos desconocidos' };
  }
  const content = source.content;
  if (typeof content !== 'string') {
    return { error: 'invalid_input', message: '`content` tiene que ser texto' };
  }
  const reason = admitGovernanceReason(source.reason);
  if (typeof reason !== 'string') return reason;
  const precondition = admitPrecondition(source.expected_sha, source.create_if_absent);
  if ('error' in precondition) return precondition;
  return { content, reason, precondition };
}
