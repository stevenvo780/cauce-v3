import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { z } from 'zod';
import { LegacyAdoptionError, LegacyAdoptionFactsSchema, LegacyAdoptionTargetsSchema,
  type LegacyAdoptionProbe, type LegacyAdoptionTarget } from '../../../../packages/store/src/fleet-adoption-contracts.js';
import { fleetHostSpawn } from './host-transport.js';
import type { HostCommandConfig } from './host-command.js';

export interface LegacyAdoptionHostConfig extends HostCommandConfig {
  hostId: string;
  targets: readonly LegacyAdoptionTarget[];
}
const Reply = z.object({ id: z.number().int().nonnegative(), ok: z.boolean(), facts: z.unknown().optional(), code: z.string().optional() }).strict();
const key = (target: LegacyAdoptionTarget) => JSON.stringify([target.tenant_id, target.alias]);
const unavailable = () => new LegacyAdoptionError('unavailable');

class ProbeSession {
  private identifier = 0;
  private buffered = '';
  private failed = false;
  private pending: { id: number; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout } | undefined;
  private readonly child: ChildProcessWithoutNullStreams;

  constructor(specification: { executable: string; arguments: string[] }, private readonly timeoutMs: number) {
    this.child = spawn(specification.executable, specification.arguments, { stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', PYTHONDONTWRITEBYTECODE: '1' } });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => { this.receive(chunk); });
    this.child.stderr.resume();
    this.child.on('error', () => { this.fail(); });
    this.child.on('exit', () => { this.fail(); });
    this.child.stdin.on('error', () => { this.fail(); });
  }
  private fail(): void {
    this.failed = true;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(unavailable()); this.pending = undefined; }
  }
  private receive(chunk: string): void {
    this.buffered += chunk;
    if (Buffer.byteLength(this.buffered) > 8192) { this.fail(); return; }
    const end = this.buffered.indexOf('\n');
    if (end < 0) return;
    const raw = this.buffered.slice(0, end); this.buffered = this.buffered.slice(end + 1);
    try {
      const reply = Reply.parse(JSON.parse(raw));
      if (reply.id !== this.pending?.id || this.buffered.length !== 0) { this.fail(); return; }
      const pending = this.pending; this.pending = undefined; clearTimeout(pending.timer);
      if (reply.ok) pending.resolve(reply.facts); else pending.reject(unavailable());
    } catch { this.fail(); }
  }
  request(action: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    if (this.failed || this.pending) return Promise.reject(unavailable());
    const id = this.identifier++;
    return new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject, timer: setTimeout(() => { this.fail(); }, this.timeoutMs) };
      this.child.stdin.write(`${JSON.stringify({ id, action, ...payload })}\n`);
    });
  }
  async stop(): Promise<void> {
    this.child.stdin.end();
    if (this.child.pid !== undefined && this.child.exitCode === null && this.child.signalCode === null) {
      const exited = once(this.child, 'exit');
      this.child.kill('SIGTERM');
      await exited;
    }
  }
  async close(): Promise<boolean> {
    try {
      if (this.failed) return false;
      await this.request('release');
      return true;
    } catch { return false; }
    finally { await this.stop(); }
  }
}

export function createLegacyAdoptionProbe(configurations: readonly LegacyAdoptionHostConfig[]): LegacyAdoptionProbe {
  const indexed = new Map<string, LegacyAdoptionHostConfig>();
  for (const config of configurations) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(config.hostId)
      || ![config.python, config.executable, config.policyFile].every(value => value.startsWith('/') && !/[\p{Cc}]/u.test(value) && !value.split('/').includes('..'))
      || !Number.isSafeInteger(config.timeoutMs ?? 40_000) || (config.timeoutMs ?? 40_000) < 1 || (config.timeoutMs ?? 40_000) > 300_000) throw unavailable();
    for (const target of LegacyAdoptionTargetsSchema.parse(config.targets)) {
      if (indexed.has(key(target))) throw unavailable();
      indexed.set(key(target), config);
    }
  }
  return {
    async withSupervisorFence(targets, work) {
      const parsed = LegacyAdoptionTargetsSchema.safeParse(targets);
      if (!parsed.success) throw new LegacyAdoptionError('invalid_input');
      const grouped = new Map<LegacyAdoptionHostConfig, LegacyAdoptionTarget[]>();
      for (const target of parsed.data) {
        const config = indexed.get(key(target));
        if (!config) throw unavailable();
        grouped.set(config, [...(grouped.get(config) ?? []), target]);
      }
      const sessions = new Map<LegacyAdoptionHostConfig, ProbeSession>();
      const sessionNonce = randomBytes(32).toString('hex');
      let active = true;
      try {
        for (const [config, selected] of grouped) {
          const session = new ProbeSession(await fleetHostSpawn(config, 'probe'), config.timeoutMs ?? 40_000);
          sessions.set(config, session);
          await session.request('acquire', { targets: selected, session_nonce: sessionNonce });
        }
        const result = await work({
          async measure(target) {
            if (!active || !parsed.data.some(row => key(row) === key(target))) throw unavailable();
            const config = indexed.get(key(target));
            if (!config) throw unavailable();
            const session = sessions.get(config);
            if (!session) throw unavailable();
            const facts = LegacyAdoptionFactsSchema.parse(await session.request('measure', { target }));
            if (key(facts.target) !== key(target) || facts.placement.host_id !== config.hostId) throw unavailable();
            return facts;
          },
          async assertHeld() {
            if (!active) throw unavailable();
            for (const session of sessions.values()) await session.request('assert');
          },
        });
        return result;
      } finally {
        active = false;
        const cleanup = await Promise.allSettled([...sessions].map(async ([config, session]) => {
          if (await session.close()) return;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const recovery = new ProbeSession(await fleetHostSpawn(config, 'recover'), config.timeoutMs ?? 40_000);
            try {
              await recovery.request('recover', { targets: grouped.get(config), session_nonce: sessionNonce });
              return;
            } catch {
              if (attempt === 2) process.stderr.write(`Legacy adoption custody remains fenced on host ${config.hostId}; recovery required\n`);
            } finally { await recovery.stop(); }
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }));
        for (const [index, result] of cleanup.entries()) {
          if (result.status === 'rejected') process.stderr.write(`Legacy adoption custody recovery failed on host ${[...sessions.keys()][index]?.hostId ?? 'unknown'}\n`);
        }
      }
    },
  };
}
