import { describe, expect, it } from 'vitest';
import { configuredSignedFleetAuthority } from './gateway-config.js';

describe('signed fleet authority gateway configuration', () => {
  it('keeps the authority unconfigured without its socket', () => {
    expect(configuredSignedFleetAuthority({})).toBeUndefined();
  });
  it('rejects a partial configuration and an ambiguous path', () => {
    expect(() => configuredSignedFleetAuthority({ CAUCE_FLEET_AUTHORITY_PEER_UID: '1000' })).toThrow();
    expect(() => configuredSignedFleetAuthority({ CAUCE_FLEET_AUTHORITY_SOCKET: '/run/../tmp/authority.sock',
      CAUCE_FLEET_AUTHORITY_OWNER_UID: '0', CAUCE_FLEET_AUTHORITY_PEER_UID: '0' })).toThrow();
  });
  it('requires a group when the gateway and authority have different owners', () => {
    const env = { CAUCE_FLEET_AUTHORITY_SOCKET: '/run/cauce-authority/authority.sock',
      CAUCE_FLEET_AUTHORITY_OWNER_UID: '0', CAUCE_FLEET_AUTHORITY_PEER_UID: '1000' };
    expect(() => configuredSignedFleetAuthority(env)).toThrow();
    expect(configuredSignedFleetAuthority({ ...env, CAUCE_FLEET_AUTHORITY_GROUP_GID: '1000' })).toBeDefined();
  });
  it('accepts a private authority owned by the gateway user', () => {
    expect(configuredSignedFleetAuthority({ CAUCE_FLEET_AUTHORITY_SOCKET: '/run/cauce-authority/authority.sock',
      CAUCE_FLEET_AUTHORITY_OWNER_UID: '1000', CAUCE_FLEET_AUTHORITY_PEER_UID: '1000' })).toBeDefined();
  });
});
