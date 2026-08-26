import { createHash } from 'node:crypto';
import {
  ErrorDeTopeDelArnes, bloqueDePerfil, ficherosDelArnes, nombresDelArnes,
  type ContextoDeAlias,
} from '@cauce/protocol';
import type {
  AgentFactsProbe, GovernanceBatchWrite, GovernanceBatchWriteAck, GovernanceReadError,
  GovernanceWritePrecondition,
} from './agent-documents.routes.js';
import { profileDocumentPaths } from './agent-documents.js';
import type {
  FicheroDeLaVistaPrevia, PreparedProfileRuntime, ProfileRuntimeAck,
  ProfileRuntimeDocumentEvidence,
} from './agent-profile.routes.js';

export type ProfileRuntimeErrorCode =
  | GovernanceReadError['error'] | 'conflict' | 'truncated' | 'unsupported_harness' | 'invalid_ack';

export class ProfileRuntimeError extends Error {
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

function units(text: string): number {
  return Math.max([...text].length, text.length);
}

function isAgentOwnedDocument(harness: string, name: string): boolean {
  return harness === 'openclaw' && (name === 'MEMORY.md' || name === 'HEARTBEAT.md');
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
 * Prepara el lote SIN mutar ni Postgres ni disco.
 *
 * Lee cada documento completo con SHA, compone contra esos bytes y captura precondiciones. El
 * `apply()` posterior manda todos los documentos gestionados en un único lote del agente; un
 * conflicto o fallo revierte el lote entero. MEMORY/HEARTBEAT existentes sólo se acreditan como
 * preservados: su contenido es del agente y nunca se reescribe.
 */
export async function prepareAgentProfileRuntime(
  probe: AgentFactsProbe,
  tenantId: string,
  alias: string,
  contexto: ContextoDeAlias,
): Promise<PreparedProfileRuntime> {
  const measured = await probe.factsFor(tenantId, alias);
  if (measured === undefined || measured.source !== 'measured') {
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

  const existing = new Map<string, string>();
  const observed = new Map<string, { sha: string; bytes: number }>();
  const preconditions = new Map<string, GovernanceWritePrecondition>();
  for (const name of names) {
    const path = pathByName.get(name)!;
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
     * MEMORY/HEARTBEAT son del agente y pueden crecer por encima del tope de transporte. Para
     * preservarlos no necesitamos traer sus bytes: basta acreditar presencia, SHA y tamaño. El
     * nombre entra en `existing` con un marcador vacío para que el generador puro sepa que existe
     * y emita `solo-si-falta`; ese prefijo truncado nunca se compone ni se vuelve a escribir.
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
  let generated: ReturnType<typeof ficherosDelArnes>;
  try {
    generated = ficherosDelArnes(harness, runtimeContext, existing);
  } catch (error) {
    if (error instanceof ErrorDeTopeDelArnes) {
      throw new ProfileRuntimeError('too_large', error.message);
    }
    throw error;
  }

  const owner = `<!-- alias: ${tenantId}/${alias} -->`;
  for (const file of generated) {
    const before = existing.get(file.nombre);
    const previousBlock = before === undefined ? undefined : bloqueDePerfil(before);
    if (file.politica === 'bloque-gestionado' && !file.escribir && before !== undefined
      && previousBlock !== undefined && !previousBlock.includes(owner)) {
      throw new ProfileRuntimeError(
        'conflict', `${file.nombre} contiene un bloque gestionado de otro alias`,
      );
    }
  }

  const writes: GovernanceBatchWrite[] = [];
  const stateByName = new Map<string, ProfileRuntimeAck['state']>();
  const evidence: ProfileRuntimeDocumentEvidence[] = [];
  const preview: FicheroDeLaVistaPrevia[] = [];
  for (const file of generated) {
    const path = pathByName.get(file.nombre)!;
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
      unidades: units(file.texto),
    });
    if (preservedFile) {
      writes.push({ mode: 'verify', path, precondition });
      stateByName.set(file.nombre, 'preserved');
      continue;
    }
    /*
     * También entra el documento gestionado que ya coincide. El agente compara SHA y lo trata
     * como no-op; incluirlo en el lote cierra la carrera preflight→ACK sin tocar sus bytes.
     */
    writes.push({ mode: 'write', path, content: file.texto, precondition });
    stateByName.set(
      file.nombre,
      file.escribir || precondition.state === 'absent' ? 'written' : 'already_current',
    );
  }

  const generation = typeof measured.facts.generation === 'string'
    && measured.facts.generation.length > 0
    ? measured.facts.generation
    : null;
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
    documents: [...names],
    harness,
    preview,
    verification,
    async apply(): Promise<readonly ProfileRuntimeAck[]> {
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
        const path = pathByName.get(file.nombre)!;
        const ack = byPath.get(path);
        const preservedFile = file.politica === 'solo-si-falta' && existing.has(file.nombre);
        const precondition = preconditions.get(file.nombre);
        const expectedSha = preservedFile && precondition?.state === 'present'
          ? precondition.sha256
          : hash(file.texto);
        const expectedBytes = preservedFile ? undefined : Buffer.byteLength(file.texto, 'utf8');
        if (ack === undefined || ack.sha === null || ack.sha !== expectedSha
          || (expectedBytes !== undefined && ack.bytes !== expectedBytes)
          || (preservedFile && ack.operation !== 'unchanged')) {
          throw new ProfileRuntimeError('invalid_ack', `${file.nombre} no trajo SHA/bytes acreditables`);
        }
        ackByName.set(file.nombre, ack);
      }

      /*
       * El ACK del write no demuestra que sigamos mirando el mismo contenedor. Se vuelve a medir
       * la identidad y se relee cada ruta: sólo la terna generación+ruta+SHA permite marcar la
       * revisión como aplicada. Un recreate o una edición concurrente queda pending, nunca verde.
       */
      const after = await probe.factsFor(tenantId, alias);
      if (!sameRuntimeIdentity(measured, after)) {
        throw new ProfileRuntimeError(
          'conflict', 'la generación o las rutas medidas cambiaron durante la aplicación del perfil',
        );
      }

      const acknowledgements: ProfileRuntimeAck[] = [];
      for (const document of evidence) {
        const readBack = await probe.readGovernanceDocument(
          document.path, after!.facts, tenantId, alias,
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
        if (ack === undefined || ack.sha === null) {
          throw new ProfileRuntimeError('invalid_ack', `${document.name} perdió su ACK correlacionado`);
        }
        acknowledgements.push({
          name: document.name,
          path: document.path,
          state: stateByName.get(document.name) ?? 'written',
          sha: readBack.sha,
          bytes: readBack.bytes,
          generation,
          container_id: after!.facts.containerId ?? null,
        });
      }
      return acknowledgements;
    },
  };
}
