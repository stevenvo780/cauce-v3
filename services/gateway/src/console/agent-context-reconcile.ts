import { createHash } from 'node:crypto';
import {
  bloqueDePerfil, esFicheroDelAgente, sinBloqueDePerfil, validaTopologiaDeBloquesGestionados,
} from '@cauce/protocol';
import type { ProfileRuntimePreflight, PreparedProfileRuntime } from './agent-profile.routes.js';
import { DOCUMENT_REASON_MAX, DOCUMENT_REASON_MIN, SHA256_PATTERN } from './agent-documents/write-admission.js';

export interface ContextReconcileDocumentSnapshot {
  readonly name: string;
  readonly observed_sha: string;
  readonly exterior_sha: string;
}

export interface ContextReconcileExpectation {
  readonly revision: number;
  readonly generation: string;
  readonly documents: readonly {
    readonly name: string;
    readonly path: string;
    readonly sha: string;
  }[];
}

export interface ContextReconcileSnapshot {
  readonly revision: number;
  readonly generation: string;
  readonly documents: readonly ContextReconcileDocumentSnapshot[];
  readonly expectation: ContextReconcileExpectation;
  readonly prepared: PreparedProfileRuntime;
}

export interface ContextReconcilePreviewBody {
  readonly reason: string;
}

export interface ContextReconcileApplyBody extends ContextReconcilePreviewBody {
  readonly expected_revision: number;
  readonly expected_runtime_generation: string;
  readonly preserve_external: true;
  readonly documents: readonly ContextReconcileDocumentSnapshot[];
}

export class ContextReconcileError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ContextReconcileError';
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function admittedReason(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const reason = value.trim();
  return reason.length >= DOCUMENT_REASON_MIN && value.length <= DOCUMENT_REASON_MAX
    ? reason
    : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function parseContextReconcilePreviewBody(value: unknown): ContextReconcilePreviewBody {
  const body = record(value);
  const reason = body === undefined ? undefined : admittedReason(body.reason);
  if (body === undefined || !exactKeys(body, ['reason']) || reason === undefined) {
    throw new ContextReconcileError(
      'invalid_input',
      `reason must contain between ${String(DOCUMENT_REASON_MIN)} and ${String(DOCUMENT_REASON_MAX)} characters`,
    );
  }
  return { reason };
}

function parseDocument(value: unknown): ContextReconcileDocumentSnapshot | undefined {
  const document = record(value);
  if (document === undefined
    || !exactKeys(document, ['name', 'observed_sha', 'exterior_sha'])
    || typeof document.name !== 'string' || document.name.length === 0 || document.name.length > 255
    || typeof document.observed_sha !== 'string' || !SHA256_PATTERN.test(document.observed_sha)
    || typeof document.exterior_sha !== 'string' || !SHA256_PATTERN.test(document.exterior_sha)) {
    return undefined;
  }
  return {
    name: document.name,
    observed_sha: document.observed_sha,
    exterior_sha: document.exterior_sha,
  };
}

export function parseContextReconcileApplyBody(value: unknown): ContextReconcileApplyBody {
  const body = record(value);
  const reason = body === undefined ? undefined : admittedReason(body.reason);
  const documents = Array.isArray(body?.documents) ? body.documents.map(parseDocument) : [];
  const names = documents.map((document) => document?.name);
  const valid = body !== undefined
    && exactKeys(body, [
      'reason', 'expected_revision', 'expected_runtime_generation', 'preserve_external', 'documents',
    ])
    && reason !== undefined
    && Number.isSafeInteger(body.expected_revision) && Number(body.expected_revision) > 0
    && typeof body.expected_runtime_generation === 'string'
    && body.expected_runtime_generation.length > 0 && body.expected_runtime_generation.length <= 128
    && body.preserve_external === true
    && Array.isArray(body.documents) && body.documents.length > 0
    && documents.every((document) => document !== undefined)
    && new Set(names).size === names.length;
  if (!valid) {
    throw new ContextReconcileError(
      'invalid_input', 'the reconcile apply contract is incomplete or contains unknown fields',
    );
  }
  return {
    reason,
    expected_revision: Number(body.expected_revision),
    expected_runtime_generation: String(body.expected_runtime_generation),
    preserve_external: true,
    documents,
  };
}

function ownerOfProfileBlock(block: string): string | undefined {
  return /^\s*<!--\s*alias:\s*([^\s>]+)\s*-->/u.exec(block)?.[1];
}

function exactDocumentSet(
  prepared: PreparedProfileRuntime,
  preflight: ProfileRuntimePreflight,
  expectation: ContextReconcileExpectation,
): boolean {
  const names = prepared.documents;
  const authoredNames = names.filter((name) => !esFicheroDelAgente(name));
  const evidence = prepared.verification.documents;
  const preview = prepared.preview;
  const existingNames = [...(preflight.existentes?.keys() ?? [])];
  if (names.length === 0 || evidence.length !== names.length || preview.length !== names.length
    || authoredNames.length === 0 || expectation.documents.length !== authoredNames.length
    || existingNames.length !== names.length
    || new Set(names).size !== names.length
    || new Set(evidence.map((document) => document.name)).size !== evidence.length
    || new Set(preview.map((document) => document.nombre)).size !== preview.length
    || new Set(expectation.documents.map((document) => document.name)).size
      !== expectation.documents.length) return false;
  const evidenceByName = new Map(evidence.map((document) => [document.name, document]));
  const previewNames = new Set(preview.map((document) => document.nombre));
  const existingNameSet = new Set(existingNames);
  const expectedByName = new Map(expectation.documents.map((document) => [document.name, document]));
  return names.every((name) => {
    const observed = evidenceByName.get(name);
    const expected = expectedByName.get(name);
    return previewNames.has(name) && existingNameSet.has(name)
      && observed?.path.split('/').at(-1) === name
      && (esFicheroDelAgente(name) ? expected === undefined
        : observed.path === expected?.path && SHA256_PATTERN.test(expected.sha));
  });
}

export function prepareContextReconcileSnapshot(input: {
  readonly tenantId: string;
  readonly alias: string;
  readonly revision: number;
  readonly expectation: ContextReconcileExpectation | undefined;
  readonly preflight: ProfileRuntimePreflight;
}): ContextReconcileSnapshot {
  const prepared = input.preflight.materialize(input.revision);
  const expectation = input.expectation;
  const generation = prepared.verification.generation;
  if (generation === null) {
    throw new ContextReconcileError('runtime_unverified', 'runtime generation is not measured');
  }
  if (expectation === undefined) {
    throw new ContextReconcileError('runtime_expectation_absent', 'runtime expectation is absent');
  }
  if (expectation.revision !== input.revision) {
    throw new ContextReconcileError('profile_revision_conflict', 'runtime expectation is not the desired revision');
  }
  if (expectation.generation !== generation) {
    throw new ContextReconcileError('runtime_generation_conflict', 'runtime generation differs from the expectation');
  }
  if (prepared.revision !== input.revision
    || !['claude', 'codex', 'openclaw'].includes(prepared.harness)
    || !exactDocumentSet(prepared, input.preflight, expectation)) {
    throw new ContextReconcileError('document_set_conflict', 'runtime documents are not the exact managed set');
  }

  const expectedByName = new Map(expectation.documents.map((document) => [document.name, document]));
  const evidenceByName = new Map(
    prepared.verification.documents.map((document) => [document.name, document]),
  );
  const previewByName = new Map(prepared.preview.map((document) => [document.nombre, document]));
  const owner = `${input.tenantId}/${input.alias}`;
  const documents = prepared.documents.filter((name) => !esFicheroDelAgente(name))
    .map((name): ContextReconcileDocumentSnapshot => {
    const current = input.preflight.existentes?.get(name);
    const evidence = evidenceByName.get(name);
    const projected = previewByName.get(name);
    if (current === undefined || evidence?.observed_sha === undefined || evidence.observed_sha === null
      || projected?.politica !== 'bloque-gestionado') {
      throw new ContextReconcileError(
        'context_not_reconcilable', 'a managed profile document is absent or unreadable',
      );
    }
    try {
      validaTopologiaDeBloquesGestionados(current);
      validaTopologiaDeBloquesGestionados(projected.texto);
    } catch {
      throw new ContextReconcileError('context_contaminated', 'managed block topology is invalid');
    }
    const block = bloqueDePerfil(current);
    const projectedBlock = bloqueDePerfil(projected.texto);
    const preservedUnmanaged = prepared.harness === 'openclaw'
      && block === undefined && projectedBlock === undefined && current === projected.texto;
    if (!preservedUnmanaged && (block === undefined || ownerOfProfileBlock(block) !== owner)) {
      throw new ContextReconcileError('context_contaminated', 'managed profile block is absent or foreign');
    }
    if (!preservedUnmanaged
      && (projectedBlock === undefined || ownerOfProfileBlock(projectedBlock) !== owner)) {
      throw new ContextReconcileError('runtime_measurement_conflict', 'durable projection has no owned block');
    }
    if (!SHA256_PATTERN.test(evidence.observed_sha)
      || sha256(current) !== evidence.observed_sha
      || evidence.observed_bytes !== Buffer.byteLength(current, 'utf8')
      || sha256(projected.texto) !== evidence.expected_sha
      || Buffer.byteLength(projected.texto, 'utf8') !== evidence.expected_bytes) {
      throw new ContextReconcileError('runtime_measurement_conflict', 'runtime measurement is internally inconsistent');
    }
    const exteriorSha = sha256(sinBloqueDePerfil(current));
    if (sha256(sinBloqueDePerfil(projected.texto)) !== exteriorSha) {
      throw new ContextReconcileError('external_context_changed', 'durable projection would alter external context');
    }
    return { name, observed_sha: evidence.observed_sha, exterior_sha: exteriorSha };
  });
  if (!documents.some((document) => expectedByName.get(document.name)?.sha !== document.observed_sha)) {
    throw new ContextReconcileError('context_not_drifted', 'runtime matches its recorded expectation');
  }
  return { revision: input.revision, generation, documents, expectation, prepared };
}

export function contextReconcileSnapshotMatches(
  body: ContextReconcileApplyBody, snapshot: ContextReconcileSnapshot,
): boolean {
  if (body.expected_revision !== snapshot.revision
    || body.expected_runtime_generation !== snapshot.generation
    || body.documents.length !== snapshot.documents.length) return false;
  return body.documents.every((document, index) => {
    const expected = snapshot.documents[index];
    return document.name === expected?.name
      && document.observed_sha === expected.observed_sha
      && document.exterior_sha === expected.exterior_sha;
  });
}
