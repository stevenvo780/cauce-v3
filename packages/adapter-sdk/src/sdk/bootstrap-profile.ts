import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  bloqueDePerfil, ficherosDelArnes, nombresDelArnes, presupuestoDeContextoMedido, revisionDelPerfil, topeDeCodexEnConfigToml,
} from '@cauce/protocol';
import { directorioDelArnes, discoReal, type DiscoDelArnes } from '../context/siembra-del-perfil.js';
import type { BootstrapDocument, BootstrapProfile } from './bootstrap-client.js';

function document(name: string, text: string): BootstrapDocument {
  return { name, sha256: createHash('sha256').update(bloqueDePerfil(text) ?? '').digest('hex'), native_revision: revisionDelPerfil(text) ?? null };
}
export function measureBootstrapProfile(profile: BootstrapProfile, options: {
  apply: boolean; expected: readonly BootstrapDocument[]; disk?: DiscoDelArnes; environment?: NodeJS.ProcessEnv;
}): BootstrapDocument[] {
  const environment = options.environment ?? process.env; const disk = options.disk ?? discoReal;
  const directory = directorioDelArnes(profile.harness_id, environment);
  if (directory === undefined || environment.HOME !== profile.contexto.hechos.arnes.home) throw new Error('bootstrap profile directory is unavailable');
  const names = nombresDelArnes(profile.harness_id); const existing = new Map<string, string>();
  for (const name of names) {
    const text = disk.leer(join(directory, name), 262_144); if (text !== undefined) existing.set(name, text);
  }
  const config = profile.harness_id === 'codex' ? disk.leer(join(directory, 'config.toml'), 1_048_576) : undefined;
  const topes = presupuestoDeContextoMedido(profile.harness_id, { codexProjectDocMaxBytes: config === undefined ? undefined : topeDeCodexEnConfigToml(config) });
  const generated = ficherosDelArnes(profile.harness_id, profile.contexto, existing, { revision: profile.profile_revision,
    ...(topes === undefined ? {} : { topes }) });
  const managed = generated.filter(file => file.politica === 'bloque-gestionado');
  if (!isDeepStrictEqual(managed.map(file => document(file.nombre, file.texto)), options.expected)) throw new Error('bootstrap profile ownership changed');
  if (options.apply) {
    disk.escribirLote(generated.filter(file => file.escribir).map(file => ({ ruta: join(directory, file.nombre), contenido: file.texto,
      ...(existing.has(file.nombre) ? { contenidoPrevio: existing.get(file.nombre) ?? '' } : {}) })));
  }
  const measured = managed.map(file => document(file.nombre, disk.leer(join(directory, file.nombre), 262_144) ?? ''));
  if (!isDeepStrictEqual(measured, options.expected)) throw new Error('bootstrap profile has not converged');
  return measured;
}
