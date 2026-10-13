import { isAbsolute, resolve } from 'node:path';
import { hasGovernanceSensitivePathSegment, hasUnsafeTextCodePoint } from '@cauce/protocol';
import { validateContextScope } from './model.js';

export interface ContextRepositoryBinding {
  readonly instance_id: string;
  readonly repositoryPath: string;
}

export function validateContextRepositoryBinding(binding: ContextRepositoryBinding): ContextRepositoryBinding {
  validateContextScope({ instance_id: binding.instance_id, tenant_id: 'binding', alias: 'binding' });
  const path = binding.repositoryPath;
  if (!isAbsolute(path) || path === '/' || resolve(path) !== path
    || path.includes('\\') || hasUnsafeTextCodePoint(path)
    || path.split('/').some(hasGovernanceSensitivePathSegment)) {
    throw new Error('Invalid server context repository binding');
  }
  return Object.freeze({ instance_id: binding.instance_id, repositoryPath: path });
}

export function configuredContextRepository(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ContextRepositoryBinding | undefined {
  const instance_id = env.CAUCE_CONTEXT_INSTANCE_ID;
  const repositoryPath = env.CAUCE_NATIVE_CONTEXT_REPOSITORY_ROOT;
  if (repositoryPath === undefined) return undefined;
  if (instance_id === undefined) {
    throw new Error('Context repository requires both server instance ID and root');
  }
  if (env.CAUCE_CONTEXT_REPOSITORY_ROOT !== undefined
    && resolve(repositoryPath) === resolve(env.CAUCE_CONTEXT_REPOSITORY_ROOT)) {
    throw new Error('Native context inspection requires a root independent of the versioned broker');
  }
  return validateContextRepositoryBinding({ instance_id, repositoryPath });
}
