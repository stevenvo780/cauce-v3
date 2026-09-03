import { AgentProfileError, normalizeAgentProfile, type AgentProfile } from '@cauce/protocol';
import type { DocumentOperator } from '../agent-documents.routes.js';
import type { PreparedProfileRuntime, ProfileRuntimeAck } from '../agent-profile.routes.js';
import { admitGovernanceReason } from '../agent-documents/write-admission.js';
import {
  evaluarContaminacion,
  type ContextContaminationVerdict, type MeasuredContext, type RecordedContextExpectation,
} from '../contaminacion-de-contexto.js';
import { UNATTRIBUTED_OPERATOR } from '../../terminal/types.js';

/**
 * Everything the profile PUT has to pass before it may write: the named person, the hand-typed
 * reason, the shape of the body and the contamination verdict. It lives beside the document write
 * so both admit a reason with the SAME code instead of two copies of the same bounds, and out of
 * `agent-profile.routes.ts` so that file stays under the size gate.
 */

export type ProfileContextMeasure =
  (tenantId: string, alias: string) => Promise<MeasuredContext | undefined>;
export type ProfileExpectationReader =
  (tenantId: string, alias: string) => Promise<RecordedContextExpectation | undefined>;

export const SIN_PERSONA: DocumentOperator = {
  operator_id: UNATTRIBUTED_OPERATOR, attributed: false,
};

/** Same shape the document PUT refuses with, so the console reuses one handler for both. */
export const PERFIL_SIN_PERSONA = {
  error: 'forbidden',
  reason: 'writable_requires_attribution',
  message: 'guardar el perfil de un alias reescribe sus ficheros de gobierno: exige una persona '
    + 'con nombre, y esta sesión no la tiene, así que su fila de auditoría no acusaría a nadie',
} as const;

export interface AdmittedProfileWrite {
  readonly expected_revision: number | null;
  readonly profile: AgentProfile;
  /** Prose the operator typed. Never defaulted, never generated, never derived from the profile. */
  readonly reason: string;
}

export interface RejectedProfileWrite {
  readonly status: 400 | 422;
  readonly body: {
    readonly error: 'invalid_input';
    readonly field?: string;
    readonly message: string;
  };
}

export interface ProfileWriteContext {
  readonly actor: { readonly tenant_id: string; readonly alias: string };
  readonly target: { readonly tenant_id: string; readonly alias: string };
  readonly operador: DocumentOperator;
  reason: string | null;
}

const PROFILE_FIELDS = new Set([
  'purpose', 'role_summary', 'human_brief', 'responsibilities', 'restrictions', 'tools',
  'operating_rules',
]);
const BODY_FIELDS = new Set(['expected_revision', 'profile', 'reason']);

export function isRejectedProfileWrite(
  value: AdmittedProfileWrite | RejectedProfileWrite,
): value is RejectedProfileWrite {
  return 'status' in value;
}

function mal(message: string): RejectedProfileWrite {
  return { status: 400, body: { error: 'invalid_input', message } };
}

export function admitProfileWrite(
  body: unknown, tenantId: string, alias: string,
): AdmittedProfileWrite | RejectedProfileWrite {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return mal('el cuerpo tiene que ser un objeto');
  }
  const source = body as Record<string, unknown>;
  if (Object.keys(source).some((key) => !BODY_FIELDS.has(key))
    || !Object.prototype.hasOwnProperty.call(source, 'expected_revision')) {
    return mal('el cuerpo tiene campos desconocidos o incompletos');
  }
  const expectedRaw = source.expected_revision;
  const expectedRevision = expectedRaw === null
    ? null
    : typeof expectedRaw === 'number' && Number.isSafeInteger(expectedRaw) && expectedRaw > 0
      ? expectedRaw
      : undefined;
  if (expectedRevision === undefined) {
    return mal('expected_revision tiene que ser null o un entero positivo');
  }
  const reason = admitGovernanceReason(source.reason);
  if (typeof reason !== 'string') {
    return { status: 400, body: { ...reason, field: 'reason' } };
  }
  const rawProfile = source.profile;
  if (rawProfile === null || typeof rawProfile !== 'object' || Array.isArray(rawProfile)
    || Object.keys(rawProfile).some((key) => !PROFILE_FIELDS.has(key))) {
    return mal('profile no tiene la forma esperada');
  }
  try {
    const profile = normalizeAgentProfile({
      ...(rawProfile as Record<string, unknown>), tenant_id: tenantId, alias,
    });
    return { expected_revision: expectedRevision, profile, reason };
  } catch (error) {
    if (error instanceof AgentProfileError) {
      return { status: 422, body: { error: 'invalid_input', field: error.field, message: error.message } };
    }
    throw error;
  }
}

/**
 * Columns shared by the accepted row and by every denial, so `/audit` renders both the same. It
 * carries who, over whom and why, and never a byte of what any profile field says.
 */
export function perfilAuditMetadata(
  contexto: ProfileWriteContext, extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    operator_id: contexto.operador.operator_id,
    attributed: contexto.operador.attributed,
    operator_reason: contexto.reason,
    actor: `${contexto.actor.tenant_id}:${contexto.actor.alias}`,
    target_tenant: contexto.target.tenant_id,
    target_alias: contexto.target.alias,
    operation: 'profile_write',
    ...extra,
  };
}

/**
 * Live bytes judged against the recorded expectation. A gateway with no probe, or an alias whose
 * container nobody measured, yields no findings: the guard never claims ownership of a file it
 * could not read, and the response says elsewhere that the measurement is missing.
 */
export async function veredictoDeContaminacion(
  medir: ProfileContextMeasure | undefined,
  esperar: ProfileExpectationReader | undefined,
  tenantId: string,
  alias: string,
): Promise<ContextContaminationVerdict> {
  const medido = await medir?.(tenantId, alias);
  if (medido === undefined) return { contaminated: false, findings: [] };
  return evaluarContaminacion(medido, await esperar?.(tenantId, alias));
}

/**
 * Why the PUT refuses before the durable CAS: writing a person halfway is worse than not writing
 * them, and the operator needs to know WHICH file to trim and by how much, which a 500 with
 * "internal error" does not say. The GET keeps answering so it can be trimmed from that screen.
 */
export interface TopeSuperado {
  readonly error: 'tope_del_arnes';
  readonly fichero: string;
  readonly medido: number;
  readonly tope: number;
  readonly message: string;
}

type ErrorDeTope = Error & { fichero: string; medido: number; tope: number };

function esTopeSuperado(error: unknown): error is ErrorDeTope {
  return error instanceof Error && error.name === 'ErrorDeTopeDelArnes'
    && 'fichero' in error && 'medido' in error && 'tope' in error;
}

export function topeSuperadoDe(error: unknown): ErrorDeTope | undefined {
  if (esTopeSuperado(error)) return error;
  const causa = error instanceof Error ? error.cause : undefined;
  return esTopeSuperado(causa) ? causa : undefined;
}

const SHA256 = /^[0-9a-f]{64}$/;

/** Partial or extra ACKs are not a written profile: the batch is accredited whole or not at all. */
export function acksCompletos(
  prepared: PreparedProfileRuntime, acknowledgements: readonly ProfileRuntimeAck[],
): boolean {
  if (prepared.documents.length !== acknowledgements.length) return false;
  const expected = new Map(prepared.verification.documents.map((document) => [document.name, document]));
  if (expected.size !== prepared.documents.length) return false;
  const generation = prepared.verification.generation;
  if (generation === null) return false;
  for (const ack of acknowledgements) {
    const document = expected.get(ack.name);
    if (document?.path !== ack.path || !expected.delete(ack.name)
      || !ack.path.startsWith('/') || !SHA256.test(ack.sha)
      || ack.sha !== document.expected_sha || ack.bytes !== document.expected_bytes
      || !Number.isSafeInteger(ack.bytes) || ack.bytes < 0
      || ack.generation !== generation
      || (ack.container_id !== null && (typeof ack.container_id !== 'string' || ack.container_id.length === 0))
      || !['written', 'already_current', 'preserved'].includes(ack.state)) return false;
  }
  return expected.size === 0;
}
