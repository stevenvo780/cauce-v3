import { mkdtempSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RECORDING_RETENTION_MS,
  sweepOldRecordings,
} from './recording-retention.js';

const DAY_MS = 24 * 3_600_1_000;
const NOW = new Date('2026-09-28T00:00:00Z').getTime();

function fixture(): string {
  return mkdtempSync(join(tmpdir(), 'cauce-recording-sweep-'));
}

function writeCast(dir: string, name: string, ageMs: number): string {
  const path = join(dir, name);
  writeFileSync(path, 'asciicast\n', { mode: 0o600 });
  const mtime = new Date(NOW - ageMs);
  utimesSync(path, mtime, mtime);
  return path;
}

describe('sweepOldRecordings (T014a/FR-012)', () => {
  it('borra los .cast con mtime>30d y conserva los recientes', async () => {
    const dir = fixture();
    const logs: string[] = [];
    const old1 = writeCast(dir, '11111111-1111-4111-8111-111111111111.cast', 31 * DAY_MS);
    const old2 = writeCast(dir, '22222222-2222-4222-8222-222222222222.cast', 90 * DAY_MS);
    const fresh = writeCast(dir, '33333333-3333-4333-8333-333333333333.cast', 1 * DAY_MS);

    const result = await sweepOldRecordings(dir, {
      now: () => NOW,
      log: (message) => { logs.push(message); },
    });

    expect(RECORDING_RETENTION_MS).toBe(30 * DAY_MS);
    expect(result.deleted).toHaveLength(2);
    expect([...result.deleted].sort()).toEqual([old1, old2].sort());
    expect(result.kept).toContain(fresh);
    const { existsSync } = await import('node:fs');
    expect(existsSync(old1)).toBe(false);
    expect(existsSync(old2)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('ignora ficheros que no son .cast y subdirectorios', async () => {
    const dir = fixture();
    const other = join(dir, 'notes.txt');
    writeFileSync(other, 'x');
    utimesSync(other, new Date(NOW - 60 * DAY_MS), new Date(NOW - 60 * DAY_MS));
    const sub = join(dir, 'sub');
    mkdirSync(sub);
    writeCast(sub, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.cast', 60 * DAY_MS);

    const result = await sweepOldRecordings(dir, { now: () => NOW });

    expect(result.deleted).toHaveLength(0);
    const { existsSync } = await import('node:fs');
    expect(existsSync(other)).toBe(true);
    expect(existsSync(join(sub, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.cast'))).toBe(true);
  });

  it('es idempotente: una segunda pasada no borra nada', async () => {
    const dir = fixture();
    writeCast(dir, '44444444-4444-4444-8444-444444444444.cast', 31 * DAY_MS);

    const first = await sweepOldRecordings(dir, { now: () => NOW });
    const second = await sweepOldRecordings(dir, { now: () => NOW });

    expect(first.deleted).toHaveLength(1);
    expect(second.deleted).toHaveLength(0);
    expect(second.kept).toHaveLength(0);
  });

  it('fail-closed: dir inexistente o ilegible no hace nada y lo registra', async () => {
    const logs: string[] = [];
    const missing = join(fixture(), 'no-existe');

    const result = await sweepOldRecordings(missing, {
      now: () => NOW,
      log: (message) => { logs.push(message); },
    });

    expect(result.deleted).toHaveLength(0);
    expect(result.kept).toHaveLength(0);
    expect(logs.length).toBeGreaterThan(0);
  });

  it('jamás borra fuera del dir: no sigue symlinks', async () => {
    const dir = fixture();
    const outside = fixture();
    const victim = writeCast(outside, 'victima.cast', 60 * DAY_MS);
    symlinkSync(victim, join(dir, 'enlace.cast'));

    const result = await sweepOldRecordings(dir, { now: () => NOW });

    expect(result.deleted).toHaveLength(0);
    const { existsSync } = await import('node:fs');
    expect(existsSync(victim)).toBe(true);
  });
});
