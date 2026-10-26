import type { ConsoleSessionRevocations } from '../console-session-revocations.js';

export class MemoryConsoleSessionRevocations implements ConsoleSessionRevocations {
  private readonly revoked = new Set<string>();

  revoke(sid: string): Promise<void> {
    this.revoked.add(sid);
    return Promise.resolve();
  }

  isRevoked(sid: string): Promise<boolean> {
    return Promise.resolve(this.revoked.has(sid));
  }
}
