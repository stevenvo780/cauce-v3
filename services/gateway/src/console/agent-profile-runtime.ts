import { createHash } from 'node:crypto';
import {
  ErrorDeTopeDelArnes, bloqueDePerfil, ficherosDelArnes, measureStrictestUnits, nombresDelArnes,
  presupuestoDeContextoMedido, type ContextoDeAlias, type PresupuestoDeContexto,
} from '@cauce/protocol';
import type {
  AgentFactsProbe, GovernanceBatchWrite, GovernanceBatchWriteAck, GovernanceReadError,
  GovernanceWritePrecondition,
} from './agent-documents.routes.js';
import { measuredCodexProjectDocumentConfig, profileDocumentPaths } from './agent-documents.js';
import type {
  FicheroDeLaVistaPrevia, PreparedProfileRuntime, ProfileRuntimeAck, ProfileRuntimePreflight,
  ProfileRuntimeDocumentEvidence,
} from './agent-profile.routes.js';

type ProfileRuntimeErrorCode =
  | GovernanceReadError['error'] | 'conflict' | 'truncated' | 'unsupported_harness' | 'invalid_ack';

class ProfileRuntimeError extends Error {
  constructor(readonly code: ProfileRuntimeErrorCode, message: string) {
    super(message);
    this.name = 'ProfileRuntimeError';
  }
}

function hash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isFailure(
  value: readonly GovernanceBatchWriteAck[] | GovernanceReadError | { error: 'conflict'; reason: string },
): value is GovernanceReadError | { error: 'conflict'; reason: string } {
  return !Array.isArray(value);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function isAgentOwnedDocument(harness: string, name: string): boolean {
  return harness === 'openclaw' && (name === 'MEMORY.md' || name === 'HEARTBEAT.md');
}

function projectionError(error: unknown): ProfileRuntimeError {
  if (error instanceof ErrorDeTopeDelArnes) {
    const traducido = new ProfileRuntimeError('too_large', error.message);
    traducido.cause = error;
    return traducido;
  }
  return new ProfileRuntimeError(
    'conflict', error instanceof Error ? error.message : 'la topología nativa no es válida',
  );
}

function project(
  harness: string, contexto: ContextoDeAlias, existing: ReadonlyMap<string, string>, revision: number,
  topes: PresupuestoDeContexto | undefined,
): ReturnType<typeof ficherosDelArnes> {
  try {
    return ficherosDelArnes(harness, contexto, existing, {
      revision, ...(topes === undefined ? {} : { topes }),
    });
  } catch (error) {
    throw projectionError(error);
  }
}

const RENGLON_DE_DUENO = /^\s*<!--\s*alias:\s*([^\s>]+)\s*-->/u;

function ownerOf(block: string): string | undefined {
  return RENGLON_DE_DUENO.exec(block)?.[1];
}

/** Mirrors the generator: only a block it declined to rewrite can belong to another alias. */
function assertOwnedBlocks(
  generated: ReturnType<typeof ficherosDelArnes>,
  existing: ReadonlyMap<string, string>,
  perfil: ContextoDeAlias['perfil'],
): void {
  const owner = `${perfil.tenant_id}/${perfil.alias}`;
  for (const file of generated) {
    if (file.politica !== 'bloque-gestionado' || file.escribir) continue;
    const before = existing.get(file.nombre);
    const previousBlock = before === undefined ? undefined : bloqueDePerfil(before);
    if (previousBlock === undefined || ownerOf(previousBlock) === owner) continue;
    throw new ProfileRuntimeError(
      'conflict', `${file.nombre} contiene un bloque gestionado de otro alias`,
    );
  }
}

function assertProjectable(
  harness: string, contexto: ContextoDeAlias, existing: ReadonlyMap<string, string>,
  topes: PresupuestoDeContexto | undefined,
): void {
  assertOwnedBlocks(
    project(harness, contexto, existing, Number.MAX_SAFE_INTEGER, topes), existing, contexto.perfil,
  );
}

function sameRuntimeIdentity(
  left: Awaited<ReturnType<AgentFactsProbe['factsFor']>>,
  right: Awaited<ReturnType<AgentFactsProbe['factsFor']>>,
): boolean {
  if (left === undefined || right === undefined || left.source !== 'measured' || right.source !== 'measured') {
    return false;
  }
  const a = left.facts;
  const b = right.facts;
  return typeof a.generation === 'string' && a.generation.length > 0
    && a.generation === b.generation
    && a.containerId === b.containerId
    && a.harness === b.harness
    && a.home === b.home
    && a.codexHome === b.codexHome
    && a.claudeConfigDir === b.claudeConfigDir
    && a.openclawWorkspace === b.openclawWorkspace
    && profileDocumentPaths(a).join('\0') === profileDocumentPaths(b).join('\0');
}

/**
 * Captures native files and write preconditions without mutating PostgreSQL or disk.
 * The returned snapshot renders the CAS-returned revision in memory before one atomic batch.
 */
export async function prepareAgentProfileRuntime(
  probe: AgentFactsProbe,
  tenantId: string,
  alias: string,
  contexto: ContextoDeAlias,
): Promise<ProfileRuntimePreflight> {
  const measured = await probe.factsFor(tenantId, alias);
  if (measured?.source !== 'measured') {
    throw new ProfileRuntimeError('unavailable', 'el runtime no publicó hechos medidos del alias');
  }
  const harness = measured.facts.harness;
  const names = nombresDelArnes(harness);
  const paths = profileDocumentPaths(measured.facts);
  if (names.length === 0 || paths.length !== names.length) {
    throw new ProfileRuntimeError(
      'unsupported_harness', `el arnés medido «${harness}» no expone sus ficheros de perfil`,
    );
  }
  const pathByName = new Map(paths.map((path) => [basename(path), path]));
  if (pathByName.size !== names.length || names.some((name) => !pathByName.has(name))) {
    throw new ProfileRuntimeError('invalid_path', 'los hechos medidos no resolvieron el juego exacto del perfil');
  }
  const pathForName = (name: string): string => {
    const path = pathByName.get(name);
    if (path === undefined) {
      throw new ProfileRuntimeError('invalid_path', 'los hechos medidos no resolvieron el juego exacto del perfil');
    }
    return path;
  };

  const existing = new Map<string, string>();
  const observed = new Map<string, { sha: string; bytes: number }>();
  const preconditions = new Map<string, GovernanceWritePrecondition>();
  for (const name of names) {
    const path = pathForName(name);
    const read = await probe.readGovernanceDocument(path, measured.facts, tenantId, alias);
    if ('error' in read) {
      if (read.error === 'not_found') {
        preconditions.set(name, { state: 'absent' });
        continue;
      }
      throw new ProfileRuntimeError(read.error, read.reason);
    }
    if (read.truncated && !isAgentOwnedDocument(harness, name)) {
      throw new ProfileRuntimeError(
        'truncated', `${name} llegó truncado; un prefijo nunca se usa para reemplazar el fichero`,
      );
    }
    /*
     * MEMORY/HEARTBEAT belong to the agent and may grow beyond the transport cap: attesting
     * presence, SHA and size is enough to preserve them. The name enters `existing` with an empty
     * marker so the generator emits `only-if-missing`; that prefix is never composed nor written.
     */
    existing.set(name, read.truncated ? '' : read.text);
    observed.set(name, { sha: read.sha, bytes: read.bytes });
    preconditions.set(name, { state: 'present', sha256: read.sha });
  }

  const runtimeContext: ContextoDeAlias = {
    perfil: contexto.perfil,
    hechos: {
      ...contexto.hechos,
      arnes: {
        ...contexto.hechos.arnes,
        harness,
        home: measured.facts.home,
      },
    },
  };
  const topes = presupuestoDeContextoMedido(harness, {
    codexProjectDocMaxBytes: measuredCodexProjectDocumentConfig(measured.facts)?.maxBytes,
  });
  const generation = typeof measured.facts.generation === 'string'
    && measured.facts.generation.length > 0
    ? measured.facts.generation
    : null;
  let consumed = false;
  const materialize = (revision: number): PreparedProfileRuntime => {
    const generated = project(harness, runtimeContext, existing, revision, topes);
    assertOwnedBlocks(generated, existing, runtimeContext.perfil);

    const writes: GovernanceBatchWrite[] = [];
    const stateByName = new Map<string, ProfileRuntimeAck['state']>();
    const evidence: ProfileRuntimeDocumentEvidence[] = [];
    const preview: FicheroDeLaVistaPrevia[] = [];
    for (const file of generated) {
      const path = pathForName(file.nombre);
      const precondition = preconditions.get(file.nombre) ?? { state: 'absent' as const };
      const preservedFile = file.politica === 'solo-si-falta' && existing.has(file.nombre);
      const expectedSha = preservedFile && precondition.state === 'present'
        ? precondition.sha256
        : hash(file.texto);
      const expectedBytes = preservedFile
        ? (observed.get(file.nombre)?.bytes ?? Buffer.byteLength(file.texto, 'utf8'))
        : Buffer.byteLength(file.texto, 'utf8');
      const before = observed.get(file.nombre);
      evidence.push({
        name: file.nombre,
        path,
        expected_sha: expectedSha,
        observed_sha: before?.sha ?? null,
        expected_bytes: expectedBytes,
        observed_bytes: before?.bytes ?? null,
        current: before?.sha === expectedSha && before.bytes === expectedBytes,
      });
      preview.push({
        nombre: file.nombre,
        politica: file.politica,
        texto: file.texto,
        unidades: measureStrictestUnits(file.texto),
      });
      if (preservedFile) {
        writes.push({ mode: 'verify', path, precondition });
        stateByName.set(file.nombre, 'preserved');
        continue;
      }
      writes.push({ mode: 'write', path, content: file.texto, precondition });
      stateByName.set(
        file.nombre,
        file.escribir || precondition.state === 'absent' ? 'written' : 'already_current',
      );
    }

    const verification: PreparedProfileRuntime['verification'] = generation === null
      ? {
          state: 'unverified', generation: null,
          container_id: measured.facts.containerId ?? null,
          observed_at: null, documents: evidence,
          reason: 'la presencia medida no publica una generación de runtime acreditable',
        }
      : {
          state: evidence.every((document) => document.current) ? 'current' : 'drifted',
          generation,
          container_id: measured.facts.containerId ?? null,
          observed_at: new Date().toISOString(),
          documents: evidence,
        };
    return {
      revision,
      documents: [...names],
      harness,
      preview,
      verification,
      async apply(): Promise<readonly ProfileRuntimeAck[]> {
        if (consumed) {
          throw new ProfileRuntimeError('conflict', 'la foto de runtime sólo se puede aplicar una vez');
        }
        consumed = true;
        if (probe.writeGovernanceBatch === undefined) {
          throw new ProfileRuntimeError('unavailable', 'la sonda no anuncia escritura gobernada por lote');
        }
        if (generation === null) {
          throw new ProfileRuntimeError(
            'unavailable', 'el lote no se escribe sin una generación medida que pueda cercar su ACK',
          );
        }
        const batch = await probe.writeGovernanceBatch(writes, measured.facts, tenantId, alias);
        if (isFailure(batch)) throw new ProfileRuntimeError(batch.error, batch.reason);
        if (batch.length !== writes.length) {
          throw new ProfileRuntimeError('invalid_ack', 'el lote no acreditó todas sus escrituras');
        }
        const byPath = new Map(batch.map((ack) => [ack.path, ack]));
        if (byPath.size !== batch.length) {
          throw new ProfileRuntimeError('invalid_ack', 'el lote repitió una ruta en sus ACK');
        }
        const ackByName = new Map<string, GovernanceBatchWriteAck>();
        for (const file of generated) {
          const path = pathForName(file.nombre);
          const ack = byPath.get(path);
          const preservedFile = file.politica === 'solo-si-falta' && existing.has(file.nombre);
          const precondition = preconditions.get(file.nombre);
          const expectedSha = preservedFile && precondition?.state === 'present'
            ? precondition.sha256
            : hash(file.texto);
          const expectedBytes = preservedFile ? undefined : Buffer.byteLength(file.texto, 'utf8');
          if (typeof ack?.sha !== 'string' || ack.sha !== expectedSha
            || (expectedBytes !== undefined && ack.bytes !== expectedBytes)
            || (preservedFile && ack.operation !== 'unchanged')) {
            throw new ProfileRuntimeError('invalid_ack', `${file.nombre} no trajo SHA/bytes acreditables`);
          }
          ackByName.set(file.nombre, ack);
        }

        const after = await probe.factsFor(tenantId, alias);
        if (after === undefined || !sameRuntimeIdentity(measured, after)) {
          throw new ProfileRuntimeError(
            'conflict', 'la generación o las rutas medidas cambiaron durante la aplicación del perfil',
          );
        }

        const acknowledgements: ProfileRuntimeAck[] = [];
        for (const document of evidence) {
          const readBack = await probe.readGovernanceDocument(
            document.path, after.facts, tenantId, alias,
          );
          const mayBeTruncated = stateByName.get(document.name) === 'preserved';
          if ('error' in readBack || (readBack.truncated && !mayBeTruncated)
            || readBack.sha !== document.expected_sha
            || readBack.bytes !== document.expected_bytes) {
            throw new ProfileRuntimeError(
              'invalid_ack', `${document.name} no coincide al releer ruta+SHA en la generación aplicada`,
            );
          }
          const ack = ackByName.get(document.name);
          if (typeof ack?.sha !== 'string') {
            throw new ProfileRuntimeError('invalid_ack', `${document.name} perdió su ACK correlacionado`);
          }
          acknowledgements.push({
            name: document.name,
            path: document.path,
            state: stateByName.get(document.name) ?? 'written',
            sha: readBack.sha,
            bytes: readBack.bytes,
            generation,
            container_id: after.facts.containerId ?? null,
          });
        }
        return acknowledgements;
      },
    };
  };

  assertProjectable(harness, runtimeContext, existing, topes);
  return {
    harness, ...(topes === undefined ? {} : { topes }), existentes: existing, materialize,
  };
}
