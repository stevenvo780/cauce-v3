import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gatesRepository, releaseGateCommands, type TimelineEvent } from './deploy-gates-fixtures.js';

const directories: string[] = [];
const orphanSweep = 'python3 -m pytest ops/tests/test_fleet_orphan_sweep.py ops/tests/test_fleet_executor_container.py -q --tb=line';

function repository() {
  const directory = mkdtempSync(join(tmpdir(), 'cauce-release-lanes-'));
  directories.push(directory);
  return gatesRepository(directory);
}

function only<T>(items: T[]): T {
  expect(items).toHaveLength(1);
  return items[0] as T;
}

/** Highest number of gates whose [start, end] windows overlap, from the fake pnpm timeline. */
function peakOverlap(events: TimelineEvent[]): number {
  const gates = events.filter(event => event.gate !== 'install');
  let running = 0;
  let peak = 0;
  for (const event of [...gates].sort((a, b) => a.at - b.at || (a.event === 'end' ? -1 : 1))) {
    running += event.event === 'start' ? 1 : -1;
    peak = Math.max(peak, running);
  }
  return peak;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('release gates in parallel lanes', () => {
  it('resolves the concurrency from the environment and rejects nonsense', () => {
    const gates = repository();
    const fallback = Number(gates.run({}, ['--concurrencia']).stdout.trim());
    expect(fallback).toBeGreaterThanOrEqual(1);
    expect(fallback).toBeLessThanOrEqual(9);
    expect(gates.run({ CAUCE_RELEASE_GATES_JOBS: '3' }, ['--concurrencia']).stdout.trim()).toBe('3');
    expect(gates.run({ CAUCE_RELEASE_GATES_JOBS: '40' }, ['--concurrencia']).stdout.trim()).toBe('9');
    for (const wrong of ['0', 'abc', '-2', '3.5']) {
      const refused = gates.run({ CAUCE_RELEASE_GATES_JOBS: wrong }, ['--concurrencia']);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('CAUCE_RELEASE_GATES_JOBS debe ser un entero');
    }
  });

  it('runs the nine gates at most three at a time in disposable worktrees of HEAD and removes them', () => {
    const gates = repository();
    const pause = Object.fromEntries(releaseGateCommands().slice(1).map(cmd => [cmd.replace(/^pnpm /u, ''), 300]));
    const result = gates.run({ CAUCE_RELEASE_GATES_JOBS: '3', MOCK_GATE_PAUSE_MS: JSON.stringify(pause) });
    expect(result.status, result.stderr).toBe(0);
    const receipt = gates.receipt(only(gates.receipts()));
    expect(receipt.comandos.map(command => command.cmd)).toEqual(releaseGateCommands());
    expect(receipt.comandos.every(command => command.exit === 0)).toBe(true);
    expect(receipt.concurrencia).toBe(3);
    expect(receipt.carriles).toBe(3);
    expect(new Set(receipt.comandos.map(command => command.carril))).toEqual(new Set([0, 1, 2]));
    expect(receipt.comandos[0]?.carril).toBe(0);
    const peak = peakOverlap(gates.timeline());
    expect(peak).toBeGreaterThanOrEqual(2);
    expect(peak).toBeLessThanOrEqual(3);
    const outside = gates.timeline().filter(event => event.gate !== 'install' && event.cwd !== gates.repository);
    expect(outside.length).toBeGreaterThan(0);
    for (const event of outside) expect(event.cwd.startsWith(`${gates.lanes}/`), event.cwd).toBe(true);
    expect(gates.git('worktree', 'list', '--porcelain').match(/^worktree /gmu)).toHaveLength(1);
    expect(readdirSync(gates.directory)).not.toContain('lanes');
    expect(receipt.cobertura?.paquetes['console/src']).toEqual({ estado: 'SUBE', base: 94.69, medido: 95.41 });
    expect(receipt.cobertura?.lineas_fusionadas_pct).toBe(94.5);
  });

  it('after a red gate starts nothing new, lets the running gates finish and writes a red receipt', () => {
    const gates = repository();
    const result = gates.run({
      CAUCE_RELEASE_GATES_JOBS: '3', MOCK_RED_GATE: 'arch:validate',
      MOCK_GATE_PAUSE_MS: JSON.stringify({ test: 1500, 'coverage:ratchet': 1500 }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ROJO en pnpm arch:validate');
    expect(result.stderr).toContain('espero a los 2 en curso');
    const receipt = gates.receipt(only(gates.receipts()));
    expect(receipt.comandos.map(command => [command.cmd, command.exit])).toEqual([
      [orphanSweep, 0], ['pnpm test', 0], ['pnpm coverage:ratchet', 0], ['pnpm arch:validate', 3]]);
    const ran = gates.pnpmLog().trim().split('\n').filter(gate => gate !== 'install' && gate !== 'orphan');
    expect(ran.sort()).toEqual(['arch:validate', 'coverage:ratchet', 'test']);
    expect(gates.git('worktree', 'list', '--porcelain').match(/^worktree /gmu)).toHaveLength(1);
  });

  it('falls back to the lanes it could prepare and still certifies every gate', () => {
    const gates = repository();
    const result = gates.run({ CAUCE_RELEASE_GATES_JOBS: '3', MOCK_RED_GATE: 'install' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('AVISO: el carril 1 no quedo listo');
    const receipt = gates.receipt(only(gates.receipts()));
    expect(receipt.carriles).toBe(1);
    expect(receipt.comandos.map(command => [command.cmd, command.exit, command.carril]))
      .toEqual(releaseGateCommands().map(cmd => [cmd, 0, 0]));
    expect(gates.git('worktree', 'list', '--porcelain').match(/^worktree /gmu)).toHaveLength(1);
  });

  it('refuses the receipt when a gate dirties its worktree lane', () => {
    const gates = repository();
    const result = gates.run({ CAUCE_RELEASE_GATES_JOBS: '2', MOCK_DIRTY_GATE: 'coverage:ratchet' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('los gates modificaron el carril 1');
    expect(result.stderr).toContain('dirty-by-gate.txt');
    const run = only(gates.receipts());
    expect(readdirSync(join(gates.directory, 'receipts', run))).not.toContain('recibo.json');
  });

  it('keeps the lanes out of the tree it certifies', () => {
    const gates = repository();
    const result = gates.run({ CAUCE_RELEASE_GATES_LANES_DIR: join(gates.repository, 'lanes') });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no pueden vivir dentro del arbol');
    expect(gates.receipts()).toEqual([]);
  });

  it('on SIGTERM ends the running gates with their process groups and emits no receipt', async () => {
    const gates = repository();
    const child = gates.start({
      CAUCE_RELEASE_GATES_JOBS: '2', MOCK_GATE_PAUSE_MS: JSON.stringify({ test: 60_000, 'coverage:ratchet': 60_000 }),
    });
    const exited = new Promise<number | null>(settle => child.on('exit', code => { settle(code); }));
    const deadline = Date.now() + 15_000;
    while (gates.timeline().filter(event => event.event === 'start' && event.gate !== 'install').length < 2) {
      expect(Date.now()).toBeLessThan(deadline);
      await new Promise(settle => setTimeout(settle, 50));
    }
    child.kill('SIGTERM');
    expect(await exited).toBe(130);
    const started = gates.timeline().filter(event => event.event === 'start' && event.gate !== 'install');
    expect(started.map(event => event.gate).sort()).toEqual(['coverage:ratchet', 'test']);
    for (const event of started) expect(alive(event.pid), `${event.gate} sigue vivo`).toBe(false);
    expect(gates.timeline().some(event => event.event === 'end' && event.gate !== 'install')).toBe(false);
    const run = only(gates.receipts());
    expect(readdirSync(join(gates.directory, 'receipts', run))).not.toContain('recibo.json');
    expect(gates.git('worktree', 'list', '--porcelain').match(/^worktree /gmu)).toHaveLength(1);
  }, 30_000);
});
