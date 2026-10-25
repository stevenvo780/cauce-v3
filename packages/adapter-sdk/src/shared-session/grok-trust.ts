import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, relative } from 'node:path';
import { promisify } from 'node:util';
import { assertCommandPins } from '../sdk/command-pins.js';
import { ProcessExecutionError } from '../sdk/errors.js';
import type { SharedSessionSpec } from './session.js';

const execute = promisify(execFile);
const MAX_TRUST_BYTES = 1024 * 1024;

function unavailable(detail: string): never {
  throw new ProcessExecutionError('SHARED_TUI_UNAVAILABLE',
    `No se pudo preparar la confianza de Grok: ${detail}. Revisa el workspace aprobado y su perfil antes de iniciar.`, false);
}

async function secureProfile(directory: string, requireStore = false): Promise<void> {
  const profile = await lstat(directory);
  if (!profile.isDirectory() || profile.isSymbolicLink() || profile.uid !== process.getuid?.()
    || (profile.mode & 0o022) !== 0) unavailable('el perfil no es un directorio seguro del agente');
  for (const name of ['trusted_folders.toml', 'trusted_folders.toml.lock']) {
    try {
      const entry = await lstat(join(directory, name));
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.uid !== profile.uid
        || (entry.mode & 0o022) !== 0 || entry.size > MAX_TRUST_BYTES) unavailable('el almacén de confianza no es seguro');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (requireStore && name === 'trusted_folders.toml') unavailable('la confianza no quedó persistida');
    }
  }
}

async function requireLocalTrustRoot(workspace: string, profile: string): Promise<void> {
  const managedWorktree = relative(join(profile, 'worktrees'), workspace);
  if (managedWorktree === '' || (!managedWorktree.startsWith('..') && !isAbsolute(managedWorktree))) {
    unavailable('el workspace es un worktree que comparte confianza con otro directorio');
  }
  try {
    const git = await lstat(join(workspace, '.git'));
    if (!git.isDirectory() || git.isSymbolicLink()) unavailable('el workspace comparte metadatos Git con otro directorio');
    try {
      await lstat(join(workspace, '.git', 'commondir'));
      unavailable('el workspace comparte metadatos Git con otro directorio');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

async function inspectWorkspace(spec: SharedSessionSpec, grant: boolean, signal?: AbortSignal, requireTrusted = grant): Promise<void> {
  await assertCommandPins(spec.command ?? spec.harness, spec.commandPins);
  const result = await execute(spec.command ?? 'grok', [
    ...(grant ? ['--trust'] : []), '--cwd', spec.workspace, 'inspect', '--json',
  ], { cwd: spec.workspace, env: { ...process.env, ...spec.environment }, timeout: 10_000,
    maxBuffer: MAX_TRUST_BYTES, ...(signal === undefined ? {} : { signal }) });
  if (grant && /Couldn't save folder trust|folder trust (?:was not saved|is not recorded)|--trust:.*not saved/iu.test(result.stderr)) {
    unavailable('Grok no pudo guardar la confianza');
  }
  const value: unknown = JSON.parse(result.stdout);
  if (typeof value !== 'object' || value === null || !('cwd' in value) || typeof value.cwd !== 'string'
    || !('projectRoot' in value) || (value.projectRoot !== null && typeof value.projectRoot !== 'string')
    || !('projectTrusted' in value) || typeof value.projectTrusted !== 'boolean') unavailable('la inspección nativa no acredita el binding');
  if (await realpath(value.cwd) !== spec.workspace
    || (value.projectRoot !== null && await realpath(value.projectRoot) !== spec.workspace)) {
    unavailable('la raíz nativa de confianza pertenece a otro directorio');
  }
  if (requireTrusted && !value.projectTrusted) unavailable('Grok no confirmó la confianza persistida');
  await assertCommandPins(spec.command ?? spec.harness, spec.commandPins);
}

export async function prepareGrokWorkspace(spec: SharedSessionSpec, signal?: AbortSignal): Promise<void> {
  if (spec.harness !== 'grok') return;
  try {
    const directory = spec.environment?.GROK_HOME;
    if (directory === undefined || !isAbsolute(directory) || !isAbsolute(spec.workspace)) unavailable('falta el perfil o workspace absoluto');
    const [profile, workspace] = await Promise.all([realpath(directory), realpath(spec.workspace)]);
    if (workspace === parse(workspace).root || workspace === await realpath(process.env.HOME ?? '/')) {
      unavailable('el workspace abarca una raíz demasiado amplia');
    }
    const canonical = { ...spec, workspace, environment: { ...spec.environment, GROK_HOME: profile } };
    await secureProfile(profile);
    await requireLocalTrustRoot(workspace, profile);
    // Native --trust uses the Git root; inspect it before granting anything outside the binding.
    await inspectWorkspace(canonical, false, signal);
    signal?.throwIfAborted();
    if (await realpath(spec.workspace) !== workspace || await realpath(directory) !== profile) unavailable('el binding cambió');
    await secureProfile(profile);
    await requireLocalTrustRoot(workspace, profile);
    await inspectWorkspace(canonical, true, signal);
    await secureProfile(profile, true);
    await inspectWorkspace(canonical, false, signal, true);
  } catch (error) {
    if (signal?.aborted === true) throw error;
    if (error instanceof ProcessExecutionError) throw error;
    unavailable('falló la inspección o escritura nativa del almacén de confianza');
  }
}
