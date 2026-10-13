import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { platform, arch } from 'node:os';
import { z } from 'zod';
import { FleetCapabilitySchema } from '@cauce/protocol';
import { SignedHostChannel, HostChannelFleetSource } from './signed-source.js';
import { FleetHostWorker } from './worker.js';
import { performHostCommand, performHostCompensation } from './host-command.js';
import { boundedProviderReceipt } from './provider-login.js';
import { HostChannelQuotaRepository, QuotaExecutor } from './quota-executor.js';
import { performQuotaHostCommand, verifyQuotaAuthenticationHostCommand } from './quota-host-command.js';
import { QuotaHostAuthentication } from './quota-auth-host.js';
import { HostCapabilitiesSchema } from './host-channel.capabilities.js';
import { SpaceBackupHost } from './space-backup.host.js';
import { AgentProviderAuthHost } from './agent-provider-auth-host.js';
import { AgentQuotaExecutor, HostChannelAgentQuotaRepository } from './agent-quota-executor.js';
import { performAgentQuotaHostCommand } from './agent-quota-host-command.js';
import type { FleetHostConfig } from './main.js';

const QuotaCapabilities = z.object({ providers: z.array(z.enum(['claude','codex','gemini','grok'])),
  actions: z.record(z.string(), z.array(z.enum(['create','authenticate','query','update_cli','delete']))) }).strict();

async function capabilityReport(config: FleetHostConfig, signal: AbortSignal) {
  const file = await open(config.command.policyFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let digest: string;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.geteuid?.() || info.nlink !== 1 || (info.mode & 0o022) !== 0 || info.size > 1_048_576) throw new Error('Host policy is unavailable');
    digest = createHash('sha256').update(await file.readFile()).digest('hex');
  } finally { await file.close(); }
  const raw = z.record(z.string(), z.unknown()).parse(await boundedProviderReceipt(config.command.python,
    [config.command.executable, '--policy', config.command.policyFile, '--capabilities'], '{}', signal, config.command.timeoutMs));
  const { quota_environments: quota, ...fleet } = raw;
  const capabilities = FleetCapabilitySchema.parse(fleet);
  if (capabilities.placements.some(placement => placement.host_id !== config.host)) throw new Error('Host policy identity differs from its enrolled computer');
  const quotaCapabilities = quota === undefined ? undefined : QuotaCapabilities.parse(quota);
  const templates = capabilities.placements.flatMap(placement => (placement.runtimes ?? []).map(runtime => ({ ...runtime,
    template_id: `tpl-${createHash('sha256').update(JSON.stringify(runtime)).digest('hex').slice(0, 24)}` })));
  return HostCapabilitiesSchema.parse({ resource: 'host', action: 'capabilities', schemaVersion: 1,
    executor_version: '4.0.0', policy_sha256: digest, fleet_executor: capabilities.available,
    templates, quota_executor: quotaCapabilities !== undefined,
    quota_providers: quotaCapabilities?.providers ?? [],quota_provider_actions:quotaCapabilities?.actions ?? {} });
}

export async function runEnrolledFleetHost(config: FleetHostConfig): Promise<void> {
  if (config.identityDirectory === undefined) throw new Error('Enrolled host identity is unavailable');
  const channel = await SignedHostChannel.load(config.identityDirectory);
  if (channel.identity.host_id !== config.host) throw new Error('Enrolled computer differs from its worker identity');
  const abort = new AbortController();
  const source = new HostChannelFleetSource(channel);
  const quotaSource = new HostChannelQuotaRepository(channel, config.host);
  const agentQuota = new AgentQuotaExecutor(new HostChannelAgentQuotaRepository(channel, config.host), {
    worker: `host-${config.host}`, host: config.host, signal: abort.signal, leaseMs: config.leaseMs,
    perform: (execution, signal) => performAgentQuotaHostCommand(config.command, execution, signal),
  });
  const agentAuthentication = config.enrolledAuthPolicyFile === undefined ? undefined : new AgentProviderAuthHost(channel, {
    hostConfig: { host: config.host, command: config.command }, authPolicyFile: config.enrolledAuthPolicyFile, projectRoot: config.projectRoot });
  const backups = new SpaceBackupHost(channel, { python: config.command.python, policyFile: config.command.policyFile,
    projectRoot: config.projectRoot, ...(config.command.timeoutMs === undefined ? {} : { timeoutMs: config.command.timeoutMs }) });
  const authentication = new QuotaHostAuthentication(channel, quotaSource, { host: config.host, command: config.command,
    projectRoot: config.projectRoot,
    verify: (execution, signal) => verifyQuotaAuthenticationHostCommand(config.command, execution, signal) });
  let quota: QuotaExecutor | undefined;
  const report = await capabilityReport(config, abort.signal);
  if (report.quota_executor) quota = new QuotaExecutor(quotaSource, {
    worker: `host-${config.host}`, host: config.host, signal: abort.signal, leaseMs: config.leaseMs,
    perform: (execution, signal) => performQuotaHostCommand(config.command, execution, signal),
    beginAuthentication: (execution, plan, claim, signal) => authentication.begin(execution, plan, claim, signal),
  });
  let auxiliaryTurn = 0;
  const worker = new FleetHostWorker(source, { worker: `host-${config.host}`, host: config.host,
    pollMs: config.pollMs, leaseMs: config.leaseMs,
    perform: (step, execution, signal) => performHostCommand(config.command, step, execution, signal),
    compensate: (execution, signal) => performHostCompensation(config.command, execution, signal),
    runQuotaOnce: async signal => {
      const tasks = [() => quota?.runOnce() ?? Promise.resolve(false),
        () => agentQuota.runOnce(), () => backups.runOnce(signal)];
      const start = auxiliaryTurn++ % tasks.length;
      for (let offset = 0; offset < tasks.length && !signal.aborted; offset++) {
        if (await tasks[(start + offset) % tasks.length]?.()) return true;
      }
      return false;
    },
    onError: () => { process.stderr.write('Enrolled host could not verify its typed work\n'); },
  });
  let activeReport: Promise<void> | undefined;
  const heartbeat = (): Promise<void> => {
    activeReport ??= (async () => {
      await channel.request('POST', `/v3/fleet/hosts/${config.host}/heartbeat`, {
        cli_version: '4.0.0', platform: `${platform()}/${arch()}`, docker_version: null, status: 'reachable',
      });
      await channel.request('POST', `/v3/fleet/hosts/${config.host}/channel`, await capabilityReport(config, abort.signal));
    })().finally(() => { activeReport = undefined; });
    return activeReport;
  };
  await heartbeat();
  agentAuthentication?.start();
  const timer = setInterval(() => { void heartbeat().catch(() => {
    process.stderr.write('Enrolled host capability report could not be verified\n');
  }); }, 30_000);
  timer.unref();
  let closing: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    abort.abort(); clearInterval(timer);
    closing ??= worker.shutdown().finally(async () => {
      await authentication.shutdown(); await agentAuthentication?.shutdown(); await activeReport?.catch(() => undefined);
    });
    return closing;
  };
  const stop = () => { void shutdown().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { await worker.start(); }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); await shutdown(); }
}
