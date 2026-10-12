import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export const releaseGatesScript = resolve(import.meta.dirname, '../../scripts/release-gates.sh');

export interface GateCommand {
  cmd: string;
  exit: unknown;
  log_sha256: string;
  duracion: number;
  log: string;
}

export interface GatesReceipt {
  commit: string;
  tree: string;
  comandos: GateCommand[];
  inicio: string;
  fin: string;
}

export function releaseGateCommands(): string[] {
  const listed = spawnSync('bash', [releaseGatesScript, '--list'], { encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`release-gates --list failed: ${listed.stderr}`);
  return listed.stdout.trim().split('\n');
}

export function greenGatesReceipt(commit: string, tree: string): GatesReceipt {
  return {
    commit,
    tree,
    comandos: releaseGateCommands().map((cmd, index) => ({
      cmd, exit: 0, log_sha256: 'a'.repeat(64), duracion: index, log: `${String(index + 1)}.log`,
    })),
    inicio: '2026-10-12T00:00:00Z',
    fin: '2026-10-12T01:00:00Z',
  };
}
