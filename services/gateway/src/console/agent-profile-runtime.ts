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
  PreparedProfileRuntime, ProfileRuntimeAck,
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
  if (probe.writeGovernanceBatch === undefined) {
    throw new ProfileRuntimeError('unavailable', 'la sonda no anuncia escritura gobernada por lote');
  }

  const pathByName = new Map(paths.map((path) => [basename(path), path]));
  if (pathByName.size !== names.length || names.some((name) => !pathByName.has(name))) {
    throw new ProfileRuntimeError('invalid_path', 'los hechos medidos no resolvieron el juego exacto del perfil');
  }

  const existing = new Map<string, string>();
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
    if (read.truncated) {
      throw new ProfileRuntimeError(
        'truncated', `${name} llegó truncado; un prefijo nunca se usa para reemplazar el fichero`,
      );
    }
    existing.set(name, read.text);
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
  for (const file of generated) {
    const path = pathByName.get(file.nombre)!;
    const precondition = preconditions.get(file.nombre) ?? { state: 'absent' as const };
    if (file.politica === 'solo-si-falta' && existing.has(file.nombre)) {
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

  return {
    documents: [...names],
    async apply(): Promise<readonly ProfileRuntimeAck[]> {
      const batch = await probe.writeGovernanceBatch!(writes, measured.facts, tenantId, alias);
      if (isFailure(batch)) throw new ProfileRuntimeError(batch.error, batch.reason);
      if (batch.length !== writes.length) {
        throw new ProfileRuntimeError('invalid_ack', 'el lote no acreditó todas sus escrituras');
      }
      const byPath = new Map(batch.map((ack) => [ack.path, ack]));
      if (byPath.size !== batch.length) {
        throw new ProfileRuntimeError('invalid_ack', 'el lote repitió una ruta en sus ACK');
      }
      const acknowledgements: ProfileRuntimeAck[] = [];
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
        acknowledgements.push({
          name: file.nombre,
          path,
          state: stateByName.get(file.nombre) ?? 'written',
          sha: ack.sha,
          bytes: ack.bytes,
        });
      }
      return acknowledgements;
    },
  };
}
