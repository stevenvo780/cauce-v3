import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gatesRepository, releaseGateCommands, type GateCommand, type TimelineEvent } from './deploy-gates-fixtures.js';

const directories: string[] = [];
const orphanSweep = 'python3 -m pytest ops/tests/test_fleet_orphan_sweep.py ops/tests/test_fleet_executor_container.py -q --tb=line';
const unsharded = { CAUCE_RELEASE_GATES_SHARDS: '1' };

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

function command(commands: GateCommand[], cmd: string): GateCommand {
  return only(commands.filter(entry => entry.cmd === cmd));
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('release gates in parallel lanes', () => {
  it('resolves the concurrency and the shards from the environment and rejects nonsense', () => {
    const gates = repository();
    const fallback = Number(gates.run({}, ['--concurrencia']).stdout.trim());
    expect(fallback).toBeGreaterThanOrEqual(1);
    expect(fallback).toBeLessThanOrEqual(15);
    expect(gates.run({ CAUCE_RELEASE_GATES_JOBS: '3' }, ['--concurrencia']).stdout.trim()).toBe('3');
    expect(gates.run({ CAUCE_RELEASE_GATES_JOBS: '40' }, ['--concurrencia']).stdout.trim()).toBe('15');
    expect(gates.run({ CAUCE_RELEASE_GATES_JOBS: '40', ...unsharded }, ['--concurrencia']).stdout.trim()).toBe('9');
    expect(gates.run({ CAUCE_RELEASE_GATES_JOBS: '40', CAUCE_RELEASE_GATES_SHARDS: '6' }, ['--concurrencia']).stdout.trim()).toBe('19');
    expect(gates.run({ CAUCE_RELEASE_GATES_JOBS: '3' }, ['--trozos']).stdout.trim()).toBe('4');
    expect(gates.run({ CAUCE_RELEASE_GATES_JOBS: '1' }, ['--trozos']).stdout.trim()).toBe('1');
    expect(gates.run({ CAUCE_RELEASE_GATES_JOBS: '1', CAUCE_RELEASE_GATES_SHARDS: '3' }, ['--trozos']).stdout.trim()).toBe('3');
    for (const wrong of ['0', 'abc', '-2', '3.5']) {
      const refused = gates.run({ CAUCE_RELEASE_GATES_JOBS: wrong }, ['--concurrencia']);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('CAUCE_RELEASE_GATES_JOBS debe ser un entero');
      const shards = gates.run({ CAUCE_RELEASE_GATES_SHARDS: wrong }, ['--trozos']);
      expect(shards.status).toBe(1);
      expect(shards.stderr).toContain('CAUCE_RELEASE_GATES_SHARDS debe ser un entero');
    }
    for (const [variable, wrong] of [['CAUCE_RELEASE_GATES_FAIL_FAST', '2'], ['CAUCE_RELEASE_GATES_GRACE_SECONDS', 'x']] as const) {
      const refused = gates.run({ [variable]: wrong });
      expect(refused.status, refused.stderr).toBe(1);
      expect(refused.stderr).toContain(`${variable} debe ser`);
      expect(gates.receipts()).toEqual([]);
    }
  });

  it('runs the nine gates at most three at a time in disposable worktrees of HEAD and removes them', () => {
    const gates = repository();
    const pause = Object.fromEntries(releaseGateCommands().slice(1).map(cmd => [cmd.replace(/^pnpm /u, ''), 300]));
    const result = gates.run({ ...unsharded, CAUCE_RELEASE_GATES_JOBS: '3', MOCK_GATE_PAUSE_MS: JSON.stringify(pause) });
    expect(result.status, result.stderr).toBe(0);
    const receipt = gates.receipt(only(gates.receipts()));
    expect(receipt.comandos.map(command => command.cmd)).toEqual(releaseGateCommands());
    expect(receipt.comandos.every(command => command.exit === 0)).toBe(true);
    expect(receipt.concurrencia).toBe(3);
    expect(receipt.carriles).toBe(3);
    expect(receipt.trozos).toBe(1);
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
    const kept = [1, 2].flatMap(lane => readdirSync(join(gates.directory, 'receipts', only(gates.receipts()), `carril-${String(lane)}-ops-artifacts`)));
    const inLanes = receipt.comandos.filter(command => command.carril !== 0 && command.cmd.startsWith('pnpm '));
    expect(kept.sort()).toEqual(inLanes.map(command => `${command.cmd.slice(5).replace(':', '-')}.txt`).sort());
    const steps = gates.timeline().filter(event => event.event === 'start' && event.gate !== 'install');
    expect(new Set(steps.map(event => event.paso)).size).toBe(steps.length);
    for (const event of steps) expect(event.paso).toMatch(/^[0-9a-f]{16}-\d+$/u);
  });

  it('splits test and coverage into shards across lanes, fuses each after its last shard and keeps one row per gate', () => {
    const gates = repository();
    const result = gates.run({
      CAUCE_RELEASE_GATES_JOBS: '4', CAUCE_RELEASE_GATES_SHARDS: '3',
      MOCK_GATE_PAUSE_MS: JSON.stringify({ test: 300, 'coverage:ratchet': 300 }),
    });
    expect(result.status, result.stderr).toBe(0);
    const receipt = gates.receipt(only(gates.receipts()));
    expect(receipt.comandos.map(entry => entry.cmd)).toEqual(releaseGateCommands());
    expect(receipt.comandos.every(entry => entry.exit === 0)).toBe(true);
    expect(receipt.trozos).toBe(3);
    expect(receipt.fallo_rapido).toBe(true);
    const events = gates.timeline().filter(event => event.gate !== 'install');
    for (const gate of ['test', 'coverage:ratchet']) {
      const units = events.filter(event => event.gate === gate && event.event === 'start');
      expect(units.map(event => event.unit).sort()).toEqual([`${gate}#1`, `${gate}#2`, `${gate}#3`, `${gate}#fusion`]);
      expect(units.filter(event => event.trozo !== null).map(event => event.trozo).sort()).toEqual(['1/3', '2/3', '3/3']);
      const dirs = new Set(units.map(event => event.dir));
      expect(dirs.size).toBe(1);
      expect([...dirs][0]).toBe(join(gates.directory, 'receipts', only(gates.receipts()), `trozos-${gate.replace(':', '-')}`));
      const fusion = only(units.filter(event => event.unit === `${gate}#fusion`));
      const lastShardEnd = Math.max(...events.filter(event => event.gate === gate && event.event === 'end' && event.trozo !== null).map(event => event.at));
      expect(fusion.at).toBeGreaterThanOrEqual(lastShardEnd);
      const row = command(receipt.comandos, `pnpm ${gate}`);
      const slug = gate.replace(':', '-');
      const number = gate === 'test' ? '03' : '04';
      expect(row.log).toBe(`${number}-${slug}.log`);
      expect(row.fusion?.log).toBe(`${number}-${slug}.log`);
      expect(row.trozos?.map(part => [part.trozo, part.exit, part.log])).toEqual(
        [1, 2, 3].map(index => [`${String(index)}/3`, 0, `${number}-${slug}-trozo-${String(index)}.log`]));
      expect(row.sin_fusion).toBeUndefined();
    }
    expect(peakOverlap(gates.timeline())).toBe(4);
    expect(receipt.cobertura?.lineas_fusionadas_pct).toBe(94.5);
    expect(gates.git('worktree', 'list', '--porcelain').match(/^worktree /gmu)).toHaveLength(1);
  });

  it('fails fast: the first red ends the steps in flight, their escaped processes and containers, and writes a red receipt', () => {
    const gates = repository();
    const started = Date.now();
    const result = gates.run({
      CAUCE_RELEASE_GATES_JOBS: '6', CAUCE_RELEASE_GATES_SHARDS: '2', CAUCE_RELEASE_GATES_GRACE_SECONDS: '1',
      MOCK_RED_GATE: 'arch:validate',
      MOCK_GATE_PAUSE_MS: JSON.stringify({ test: 20_000, 'coverage:ratchet': 20_000, 'qa:testcontainers': 20_000, 'arch:validate': 500 }),
      MOCK_ESCAPE_GATES: 'test#1', MOCK_CONTAINER_GATES: 'coverage:ratchet#2',
    });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ROJO en pnpm arch:validate; fallo rapido; termino 5 paso(s) en curso');
    const receipt = gates.receipt(only(gates.receipts()));
    expect(receipt.fallo_rapido).toBe(true);
    expect(receipt.comandos.map(entry => [entry.cmd, entry.exit !== 0, entry.interrumpido ?? false])).toEqual([
      [orphanSweep, false, false], ['pnpm test', true, true], ['pnpm coverage:ratchet', true, true],
      ['pnpm qa:testcontainers', true, true], ['pnpm arch:validate', true, false]]);
    expect(command(receipt.comandos, 'pnpm arch:validate').exit).toBe(3);
    const test = command(receipt.comandos, 'pnpm test');
    expect(test.sin_fusion).toBe(true);
    expect(test.trozos?.map(part => [part.trozo, part.interrumpido])).toEqual([['1/2', true], ['2/2', true]]);
    expect(command(receipt.comandos, 'pnpm coverage:ratchet').trozos?.map(part => part.trozo)).toEqual(['1/2', '2/2']);
    const steps = gates.timeline().filter(event => event.event === 'start' && event.gate !== 'install');
    expect(steps.map(event => event.unit).sort()).toEqual(
      ['arch:validate', 'coverage:ratchet#1', 'coverage:ratchet#2', 'qa:testcontainers', 'test#1', 'test#2']);
    for (const event of steps) expect(alive(event.pid), `${event.unit} sigue vivo`).toBe(false);
    const escaped = only(gates.escaped());
    expect(escaped.unit).toBe('test#1');
    expect(alive(escaped.pid), 'el proceso que salio del grupo sigue vivo').toBe(false);
    expect(gates.containers()).toEqual([]);
    expect(gates.git('worktree', 'list', '--porcelain').match(/^worktree /gmu)).toHaveLength(1);
  }, 30_000);

  it('removes the labelled containers of a step that ended green and leaves the others alone', () => {
    const gates = repository();
    const result = gates.run({ ...unsharded, CAUCE_RELEASE_GATES_JOBS: '2', MOCK_CONTAINER_GATES: 'lint' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('retiro los contenedores de prueba de pnpm lint: cid-');
    expect(gates.containers()).toEqual([]);
    const lint = only(gates.timeline().filter(event => event.unit === 'lint' && event.event === 'start'));
    expect(gates.dockerCalls()).toContainEqual(['rm', '-f', `cid-${lint.paso}`]);
    expect(gates.dockerCalls().filter(call => call[0] === 'rm')).toHaveLength(1);
  });

  it('red shard: its gate is red with no fusion, and the fast fail stops the sibling shards', () => {
    const gates = repository();
    const result = gates.run({
      CAUCE_RELEASE_GATES_JOBS: '3', CAUCE_RELEASE_GATES_SHARDS: '3', CAUCE_RELEASE_GATES_GRACE_SECONDS: '1',
      MOCK_RED_GATE: 'test#2', MOCK_GATE_PAUSE_MS: JSON.stringify({ 'test#1': 20_000, 'test#3': 20_000 }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ROJO en pnpm test [2/3]');
    const receipt = gates.receipt(only(gates.receipts()));
    const test = only(receipt.comandos.filter(entry => entry.cmd !== orphanSweep));
    expect(test.cmd).toBe('pnpm test');
    expect(test.exit).toBe(3);
    expect(test.log).toBe('03-test-trozo-2.log');
    expect(test.sin_fusion).toBe(true);
    expect(test.trozos?.map(part => [part.trozo, part.exit !== 0, part.interrumpido ?? false]))
      .toEqual([['1/3', true, true], ['2/3', true, false], ['3/3', true, true]]);
    expect(gates.pnpmLog()).not.toContain('test#fusion');
  }, 30_000);

  it('without fail-fast, after a red gate starts nothing new, lets the running gates finish and writes a red receipt', () => {
    const gates = repository();
    const result = gates.run({
      ...unsharded, CAUCE_RELEASE_GATES_FAIL_FAST: '0', CAUCE_RELEASE_GATES_JOBS: '3', MOCK_RED_GATE: 'arch:validate',
      MOCK_GATE_PAUSE_MS: JSON.stringify({ test: 1500, 'coverage:ratchet': 1500 }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ROJO en pnpm arch:validate');
    expect(result.stderr).toContain('espero a los 2 en curso');
    const receipt = gates.receipt(only(gates.receipts()));
    expect(receipt.fallo_rapido).toBe(false);
    expect(receipt.comandos.map(command => [command.cmd, command.exit])).toEqual([
      [orphanSweep, 0], ['pnpm test', 0], ['pnpm coverage:ratchet', 0], ['pnpm qa:testcontainers', 0], ['pnpm arch:validate', 3]]);
    const ran = gates.pnpmLog().trim().split('\n').filter(gate => gate !== 'install' && gate !== 'orphan');
    expect(ran.sort()).toEqual(['arch:validate', 'coverage:ratchet', 'qa:testcontainers', 'test']);
    expect(gates.git('worktree', 'list', '--porcelain').match(/^worktree /gmu)).toHaveLength(1);
  });

  it('falls back to the lanes it could prepare and still certifies every gate', () => {
    const gates = repository();
    const result = gates.run({ ...unsharded, CAUCE_RELEASE_GATES_JOBS: '3', MOCK_RED_GATE: 'install' });
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
    const result = gates.run({ ...unsharded, CAUCE_RELEASE_GATES_JOBS: '2', MOCK_DIRTY_GATE: 'coverage:ratchet' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('los gates modificaron el carril 1');
    expect(result.stderr).toContain('dirty-by-gate.txt');
    const run = only(gates.receipts());
    expect(readdirSync(join(gates.directory, 'receipts', run))).not.toContain('recibo.json');
  });

  it('keeps the red receipt when a gate ended by the fast fail leaves its lane dirty', () => {
    const gates = repository();
    const result = gates.run({
      ...unsharded, CAUCE_RELEASE_GATES_JOBS: '2', MOCK_DIRTY_GATE: 'coverage:ratchet', MOCK_RED_GATE: 'test',
      MOCK_GATE_PAUSE_MS: JSON.stringify({ test: 300, 'coverage:ratchet': 20_000 }), CAUCE_RELEASE_GATES_GRACE_SECONDS: '1',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ROJO en pnpm test');
    const receipt = gates.receipt(only(gates.receipts()));
    expect(receipt.carriles_sucios?.join('\n')).toContain('dirty-by-gate.txt');
    expect(command(receipt.comandos, 'pnpm coverage:ratchet').interrumpido).toBe(true);
  }, 30_000);

  it('keeps the lanes out of the tree it certifies', () => {
    const gates = repository();
    const result = gates.run({ CAUCE_RELEASE_GATES_LANES_DIR: join(gates.repository, 'lanes') });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no pueden vivir dentro del arbol');
    expect(gates.receipts()).toEqual([]);
  });

  it('rejects a lanes root whose physical path is inside the tree', () => {
    const gates = repository();
    const outside = mkdtempSync(join(tmpdir(), 'cauce-lanes-outside-'));
    directories.push(outside);
    const ignored = join(gates.repository, 'ops', 'artifacts', 'inside');
    mkdirSync(ignored, { recursive: true });
    const link = join(outside, 'lanes');
    symlinkSync(ignored, link);
    const viaLink = gates.run({ CAUCE_RELEASE_GATES_JOBS: '2', CAUCE_RELEASE_GATES_LANES_DIR: link });
    expect(viaLink.status, viaLink.stderr).toBe(1);
    expect(viaLink.stderr).toContain('no pueden vivir dentro del arbol');
    const lexical = `${gates.repository}/../${basename(gates.repository)}/ops/artifacts/inside`;
    const viaDots = gates.run({ CAUCE_RELEASE_GATES_JOBS: '2', CAUCE_RELEASE_GATES_LANES_DIR: lexical });
    expect(viaDots.status, viaDots.stderr).toBe(1);
    expect(viaDots.stderr).toContain('no pueden vivir dentro del arbol');
    const rootLink = join(outside, 'root');
    symlinkSync(gates.repository, rootLink);
    const viaRoot = gates.run({ CAUCE_RELEASE_GATES_LANES_DIR: rootLink });
    expect(viaRoot.status, viaRoot.stderr).toBe(1);
    expect(viaRoot.stderr).toContain('no pueden vivir dentro del arbol');
    expect(gates.receipts()).toEqual([]);
  });

  it('follows a symlink to a lanes root outside the tree', () => {
    const gates = repository();
    const outside = mkdtempSync(join(tmpdir(), 'cauce-lanes-outside-'));
    directories.push(outside);
    const real = join(outside, 'real');
    mkdirSync(real);
    const link = join(outside, 'lanes');
    symlinkSync(real, link);
    const result = gates.run({ CAUCE_RELEASE_GATES_JOBS: '2', CAUCE_RELEASE_GATES_LANES_DIR: link });
    expect(result.status, result.stderr).toBe(0);
    const receipt = gates.receipt(only(gates.receipts()));
    expect(receipt.carriles).toBe(2);
    expect(receipt.comandos.every(command => command.exit === 0)).toBe(true);
    expect(gates.git('worktree', 'list', '--porcelain').match(/^worktree /gmu)).toHaveLength(1);
  });

  it('on SIGTERM ends the running gates with their process groups and escaped processes, and emits no receipt', async () => {
    const gates = repository();
    const child = gates.start({
      ...unsharded, CAUCE_RELEASE_GATES_JOBS: '2', CAUCE_RELEASE_GATES_GRACE_SECONDS: '1', MOCK_ESCAPE_GATES: 'test',
      MOCK_GATE_PAUSE_MS: JSON.stringify({ test: 60_000, 'coverage:ratchet': 60_000 }),
    });
    const exited = new Promise<number | null>(settle => child.on('exit', code => { settle(code); }));
    const deadline = Date.now() + 15_000;
    while (gates.timeline().filter(event => event.event === 'start' && event.gate !== 'install').length < 2 || gates.escaped().length < 1) {
      expect(Date.now()).toBeLessThan(deadline);
      await new Promise(settle => setTimeout(settle, 50));
    }
    child.kill('SIGTERM');
    expect(await exited).toBe(130);
    const started = gates.timeline().filter(event => event.event === 'start' && event.gate !== 'install');
    expect(started.map(event => event.gate).sort()).toEqual(['coverage:ratchet', 'test']);
    for (const event of started) expect(alive(event.pid), `${event.gate} sigue vivo`).toBe(false);
    expect(alive(only(gates.escaped()).pid), 'el proceso que salio del grupo sigue vivo').toBe(false);
    expect(gates.timeline().some(event => event.event === 'end' && event.gate !== 'install')).toBe(false);
    const run = only(gates.receipts());
    expect(readdirSync(join(gates.directory, 'receipts', run))).not.toContain('recibo.json');
    expect(gates.git('worktree', 'list', '--porcelain').match(/^worktree /gmu)).toHaveLength(1);
  }, 30_000);
});
