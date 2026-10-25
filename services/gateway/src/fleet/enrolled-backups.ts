import { setTimeout as pause } from 'node:timers/promises';
import { arch, platform } from 'node:os';
import type { FleetHostConfig } from './main.js';
import type { HostCapabilities } from './host-channel.capabilities.js';
import type { SignedHostChannel } from './signed-source.js';
import { SpaceBackupHost } from './space-backup.host.js';

export async function runBackupOnlyHost(config: FleetHostConfig, channel: SignedHostChannel,
  capabilities: (signal: AbortSignal) => Promise<HostCapabilities>): Promise<void> {
  const abort = new AbortController();
  const stopped = () => abort.signal.aborted;
  const backups = new SpaceBackupHost(channel, { python: config.command.python, policyFile: config.command.policyFile,
    projectRoot: config.projectRoot });
  let activeReport: Promise<void> | undefined;
  const heartbeat = (): Promise<void> => {
    activeReport ??= (async () => {
      const report = await capabilities(abort.signal);
      if (report.execution_scope !== 'backups' || !report.space_backup || report.fleet_executor) {
        abort.abort(); throw new Error('Backup-only host policy changed; restart its executor');
      }
      await channel.request('POST', `/v3/fleet/hosts/${config.host}/heartbeat`, {
        cli_version: '4.0.0', platform: `${platform()}/${arch()}`, docker_version: null, status: 'reachable',
      });
      await channel.request('POST', `/v3/fleet/hosts/${config.host}/channel`, report);
    })().finally(() => { activeReport = undefined; });
    return activeReport;
  };
  const stop = () => { abort.abort(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let timer: NodeJS.Timeout | undefined;
  try {
    await heartbeat();
    timer = setInterval(() => { void heartbeat().catch(() => {
      process.stderr.write('Backup-only host capability report could not be verified\n');
    }); }, 30_000);
    timer.unref();
    while (!stopped()) {
      try { if (await backups.runOnce(abort.signal)) continue; }
      catch { if (!stopped()) process.stderr.write('Backup-only host could not verify its copy work\n'); }
      if (!stopped()) await pause(config.pollMs, undefined, { signal: abort.signal }).catch((error: unknown) => {
        if (!stopped()) throw error;
      });
    }
  } finally {
    abort.abort(); if (timer) clearInterval(timer);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    await activeReport?.catch(() => undefined);
  }
}
