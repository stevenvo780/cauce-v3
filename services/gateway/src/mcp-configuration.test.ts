import { describe, expect, it } from 'vitest';
import { configuredHumanMcp } from './mcp-configuration.js';

const names = ['CAUCE_MCP_PUBLIC_ORIGIN', 'CAUCE_MCP_OAUTH_ISSUER', 'CAUCE_MCP_OAUTH_JWKS_URI'] as const;
const valid = {
  CAUCE_MCP_PUBLIC_ORIGIN: 'https://mcp.example/',
  CAUCE_MCP_OAUTH_ISSUER: 'https://issuer.example',
  CAUCE_MCP_OAUTH_JWKS_URI: 'https://issuer.example/.well-known/jwks.json',
};
const errorMessage = 'Invalid human MCP OAuth configuration';

describe('human MCP environment configuration', () => {
  it('is disabled when all three settings are absent', () => {
    expect(configuredHumanMcp({})).toBeUndefined();
  });

  it('builds the canonical OAuth authorization without a fixed principal', () => {
    const configured = configuredHumanMcp(valid);
    expect(configured?.publicOrigin).toBe('https://mcp.example');
    expect(configured?.authorization.mode).toBe('oauth');
    expect(configured?.authorization.metadata).toEqual({
      resource: 'https://mcp.example/mcp',
      authorization_servers: ['https://issuer.example'],
      scopes_supported: ['cauce.read', 'cauce.publish'],
      bearer_methods_supported: ['header'],
      resource_name: 'Cauce MCP',
    });
    expect(configured?.authorization).toHaveProperty('authenticateIdentity');
    expect(configured?.authorization).not.toHaveProperty('authenticate');
  });

  it('rejects partial and empty configuration without echoing values', () => {
    for (const presentCount of [1, 2]) {
      for (const combination of combinations(presentCount)) {
        const environment: Record<string, string> = {};
        for (const name of combination) environment[name] = 'fixture-value-that-must-not-leak';
        expect(() => configuredHumanMcp(environment)).toThrow(errorMessage);
        expect(() => configuredHumanMcp(environment)).toThrowError(new RegExp(`^${errorMessage}$`));
      }
    }
    for (const name of names) {
      expect(() => configuredHumanMcp({ ...valid, [name]: '' })).toThrow(errorMessage);
      expect(() => configuredHumanMcp({ ...valid, [name]: '' })).toThrowError(new RegExp(`^${errorMessage}$`));
      expect(() => configuredHumanMcp({ ...valid, [name]: '   ' })).toThrowError(new RegExp(`^${errorMessage}$`));
    }
  });

  it.each([
    ['http origin', { ...valid, CAUCE_MCP_PUBLIC_ORIGIN: 'http://mcp.example' }],
    ['origin credentials', { ...valid, CAUCE_MCP_PUBLIC_ORIGIN: 'https://user:secret@mcp.example' }],
    ['origin path', { ...valid, CAUCE_MCP_PUBLIC_ORIGIN: 'https://mcp.example/path' }],
    ['origin query', { ...valid, CAUCE_MCP_PUBLIC_ORIGIN: 'https://mcp.example?token=private' }],
    ['origin fragment', { ...valid, CAUCE_MCP_PUBLIC_ORIGIN: 'https://mcp.example#private' }],
    ['issuer credentials', { ...valid, CAUCE_MCP_OAUTH_ISSUER: 'https://user:secret@issuer.example' }],
    ['issuer HTTP', { ...valid, CAUCE_MCP_OAUTH_ISSUER: 'http://issuer.example' }],
    ['issuer query', { ...valid, CAUCE_MCP_OAUTH_ISSUER: 'https://issuer.example?token=private' }],
    ['issuer fragment', { ...valid, CAUCE_MCP_OAUTH_ISSUER: 'https://issuer.example#private' }],
    ['JWKS credentials', { ...valid, CAUCE_MCP_OAUTH_JWKS_URI: 'https://user:secret@issuer.example/jwks' }],
    ['JWKS HTTP', { ...valid, CAUCE_MCP_OAUTH_JWKS_URI: 'http://issuer.example/jwks' }],
    ['JWKS query', { ...valid, CAUCE_MCP_OAUTH_JWKS_URI: 'https://issuer.example/jwks?token=private' }],
    ['JWKS fragment', { ...valid, CAUCE_MCP_OAUTH_JWKS_URI: 'https://issuer.example/jwks#private' }],
  ])('rejects invalid %s without reflecting its contents', (_case, environment) => {
    expect(() => configuredHumanMcp(environment)).toThrow(errorMessage);
    try {
      configuredHumanMcp(environment);
      throw new Error('Expected invalid configuration to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(errorMessage);
      expect((error as Error).message).not.toContain('private');
      expect((error as Error).message).not.toContain('secret');
    }
  });

  it('rejects disabled TLS verification only when human MCP is configured', () => {
    expect(configuredHumanMcp({ NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toBeUndefined();
    expect(() => configuredHumanMcp({ ...valid, NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toThrowError(errorMessage);
  });
});

function combinations(length: number): (typeof names[number])[][] {
  const result: (typeof names[number])[][] = [];
  for (let mask = 1; mask < 1 << names.length; mask += 1) {
    if (mask.toString(2).replaceAll('0', '').length === length) {
      result.push(names.filter((_, index) => (mask & (1 << index)) !== 0));
    }
  }
  return result;
}
