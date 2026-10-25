import { describe, expect, test } from 'vitest';
import { deviceNumbersAreComparable, mountedSocketMatches, type PrivateSocketView } from '../e2e/browser-socket-identity.js';

const identity = { uid: 1000, ino: 3757023, dev: 69 };
const forwarded = 'unix:///run/user/1000/docker-lab.sock';

function view(overrides: Partial<PrivateSocketView> = {}): PrivateSocketView {
  return { socket: true, mode: 0o600, uid: identity.uid, ino: identity.ino, dev: 36, ...overrides };
}

describe('mounted private browser socket', () => {
  test('skips the device number only when the daemon is the forwarded docker-lab socket', () => {
    expect(deviceNumbersAreComparable(forwarded)).toBe(false);
    expect(deviceNumbersAreComparable('unix:///var/run/docker.sock')).toBe(true);
    expect(deviceNumbersAreComparable(undefined)).toBe(true);
    expect(mountedSocketMatches(view(), identity, forwarded)).toBe(true);
    expect(mountedSocketMatches(view(), identity, 'unix:///var/run/docker.sock')).toBe(false);
    expect(mountedSocketMatches(view(), identity, undefined)).toBe(false);
  });

  test('still requires a private socket, mode 0600, uid and inode when devices are not comparable', () => {
    expect(mountedSocketMatches(view({ socket: false }), identity, forwarded)).toBe(false);
    expect(mountedSocketMatches(view({ mode: 0o666 }), identity, forwarded)).toBe(false);
    expect(mountedSocketMatches(view({ uid: 0 }), identity, forwarded)).toBe(false);
    expect(mountedSocketMatches(view({ ino: identity.ino + 1 }), identity, forwarded)).toBe(false);
  });

  test('rejects an inode collision across devices when the daemon is local', () => {
    expect(mountedSocketMatches(view({ dev: identity.dev }), identity, undefined)).toBe(true);
    expect(mountedSocketMatches(view({ dev: identity.dev + 1 }), identity, 'unix:///var/run/docker.sock')).toBe(false);
  });
});
