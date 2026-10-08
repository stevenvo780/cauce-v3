import { createHash } from 'node:crypto';
import { bloqueDePerfil, ficherosDelArnes, revisionDelPerfil, type ContextoDeAlias } from '@cauce/protocol';
import { BootstrapError, type BootstrapDocument } from './bootstrap-contracts.js';

export function bootstrapProfileDocuments(context: ContextoDeAlias, revision: number): BootstrapDocument[] {
  const generated = ficherosDelArnes(context.hechos.arnes.harness, context, new Map(), { revision });
  const documents = generated.filter(file => file.politica === 'bloque-gestionado').map(file => ({
    name: file.nombre as BootstrapDocument['name'],
    sha256: createHash('sha256').update(bloqueDePerfil(file.texto) ?? '').digest('hex'),
    native_revision: revisionDelPerfil(file.texto) ?? null,
  }));
  if (!documents.length || documents.every(file => file.sha256 === createHash('sha256').update('').digest('hex'))) {
    throw new BootstrapError('unverified');
  }
  return documents;
}
