import { nombresDelArnes } from '@cauce/protocol';
import { isAbsolute, join, resolve } from 'node:path';
import { directorioDelArnes } from './siembra-del-perfil.js';

export interface NativeContextFileBinding {
  readonly path: string;
  readonly nativePath: string;
}

export function nativeContextFileBindings(root: string, harness: string,
  files: readonly { readonly path: string }[], environment: NodeJS.ProcessEnv = process.env): NativeContextFileBinding[] {
  const configured = harness === 'openclaw' && environment.CAUCE_OPENCLAW_WORKSPACE === undefined
    ? { ...environment, CAUCE_OPENCLAW_WORKSPACE: join(root, 'workspace') } : environment;
  if (harness === 'openclaw' && configured.CAUCE_OPENCLAW_WORKSPACE !== undefined
    && resolve(configured.CAUCE_OPENCLAW_WORKSPACE) !== configured.CAUCE_OPENCLAW_WORKSPACE) {
    throw new Error('native context directory must be canonical and absolute');
  }
  const directory = directorioDelArnes(harness, configured);
  const workspace = configured.CAUCE_AGENT_WORKSPACE;
  const names = nombresDelArnes(harness);
  const result: NativeContextFileBinding[] = [];
  for (const file of files) {
    for (const name of names) {
      const nativeDirectory = file.path === `directives/workspace-${name}` ? workspace
        : file.path === `directives/global-${name}` || harness === 'openclaw'
          && (file.path === `directives/${name}` || file.path === `context/${name}`) ? directory : undefined;
      if (nativeDirectory === undefined) continue;
      if (!isAbsolute(nativeDirectory) || resolve(nativeDirectory) !== nativeDirectory || nativeDirectory === '/') {
        throw new Error('native context directory must be canonical and absolute');
      }
      result.push({ path: file.path, nativePath: join(nativeDirectory, name) });
    }
  }
  if (new Set(result.map(file => file.nativePath)).size !== result.length) throw new Error('native context paths overlap');
  return result;
}
