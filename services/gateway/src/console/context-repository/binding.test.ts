import { describe, expect, it } from 'vitest';
import { configuredContextRepository, validateContextRepositoryBinding } from './binding.js';

describe('server-only context repository binding', () => {
  it('is disabled without an explicit instance and root', () => {
    expect(configuredContextRepository({})).toBeUndefined();
  });

  it('freezes one exact instance/root pair without reading or creating it', () => {
    const result = configuredContextRepository({
      CAUCE_CONTEXT_INSTANCE_ID: 'fixture', CAUCE_CONTEXT_REPOSITORY_ROOT: '/synthetic/context',
    });
    expect(result).toEqual({ instance_id: 'fixture', repositoryPath: '/synthetic/context' });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    { CAUCE_CONTEXT_INSTANCE_ID: 'fixture' }, { CAUCE_CONTEXT_REPOSITORY_ROOT: '/synthetic/context' },
  ])('rejects a partial binding %#', (env) => {
    expect(() => configuredContextRepository(env)).toThrow();
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
