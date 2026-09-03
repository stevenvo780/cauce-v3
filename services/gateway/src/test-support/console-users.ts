import {
  normalizeEmail, type ConsoleUser, type ConsoleUserStore,
} from '../console-users.js';

export class MemoryConsoleUserStore implements ConsoleUserStore {
  private readonly users = new Map<string, ConsoleUser>();

  constructor(users: readonly ConsoleUser[] = []) {
    for (const user of users) this.users.set(user.id, user);
  }

  ready(): Promise<void> { return Promise.resolve(); }

  async findByEmail(email: string): Promise<ConsoleUser | undefined> {
    const normalized = normalizeEmail(email);
    return [...this.users.values()].find((user) => normalizeEmail(user.email) === normalized);
  }

  async findById(id: string): Promise<ConsoleUser | undefined> {
    return this.users.get(id);
  }

  recordLogin(): Promise<void> { return Promise.resolve(); }

  put(user: ConsoleUser): void {
    this.users.set(user.id, user);
  }
}
