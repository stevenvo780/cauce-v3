import { describe, expect, it } from 'vitest';
import { configuredContextRepository, validateContextRepositoryBinding } from './binding.js';

describe('server-only context repository binding', () => {
  it('is disabled without an explicit instance and root', () => {
    expect(configuredContextRepository({})).toBeUndefined();
  });

  it('freezes one exact instance/root pair without reading or creating it', () => {
    const result = configuredContextRepository({
      CAUCE_CONTEXT_INSTANCE_ID: 'fixture', CAUCE_NATIVE_CONTEXT_REPOSITORY_ROOT: '/synthetic/context',
    });
    expect(result).toEqual({ instance_id: 'fixture', repositoryPath: '/synthetic/context' });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('does not bind the native reader to the V4 broker configuration', () => {
    expect(configuredContextRepository({
      CAUCE_CONTEXT_INSTANCE_ID: 'fixture', CAUCE_CONTEXT_REPOSITORY_ROOT: '/synthetic/broker',
    })).toBeUndefined();
    expect(configuredContextRepository({ CAUCE_CONTEXT_INSTANCE_ID: 'fixture' })).toBeUndefined();
  });

  it('requires an instance for an explicitly configured native root', () => {
    expect(() => configuredContextRepository({ CAUCE_NATIVE_CONTEXT_REPOSITORY_ROOT: '/synthetic/native' }))
      .toThrow('Context repository requires both server instance ID and root');
  });

  it('binds the native reader independently while the broker is configured', () => {
    expect(configuredContextRepository({ CAUCE_CONTEXT_INSTANCE_ID: 'fixture',
      CAUCE_CONTEXT_REPOSITORY_ROOT: '/synthetic/broker', CAUCE_NATIVE_CONTEXT_REPOSITORY_ROOT: '/synthetic/native',
    })).toEqual({ instance_id: 'fixture', repositoryPath: '/synthetic/native' });
  });

  it('rejects selecting the broker root as the native source', () => {
    expect(() => configuredContextRepository({ CAUCE_CONTEXT_INSTANCE_ID: 'fixture',
      CAUCE_CONTEXT_REPOSITORY_ROOT: '/synthetic/broker', CAUCE_NATIVE_CONTEXT_REPOSITORY_ROOT: '/synthetic/broker',
    })).toThrow('Native context inspection requires a root independent of the versioned broker');
  });

  it.each(['', '/', 'relative', '/synthetic/../context', '/synthetic//context', '/synthetic/context/',
    '/synthetic/id_rsa/context', '/synthetic/context\0', '/synthetic/context\n', '/synthetic\\context'])(
    'rejects noncanonical or sensitive root %j without echoing it', (repositoryPath) => {
      expect(() => validateContextRepositoryBinding({ instance_id: 'fixture', repositoryPath }))
        .toThrow('Invalid server context repository binding');
    },
  );

  it.each(['', '../outside', 'UPPER', 'id_rsa'])('rejects invalid instance %j', (instance_id) => {
    expect(() => validateContextRepositoryBinding({ instance_id, repositoryPath: '/synthetic/context' })).toThrow();
  });
});
