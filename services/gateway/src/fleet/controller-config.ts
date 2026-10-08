import { normalize } from 'node:path';
import { z } from 'zod';
import { readPrivateJson } from './provider-login.js';
import { FleetSshTransportSchema } from './host-transport.js';
import { performHostCommand, performHostCompensation, type HostCommandConfig } from './host-command.js';
import type { FleetCoordinatorTransport } from './coordinator.js';
import { LegacyAdoptionTargetsSchema } from '@cauce/store';

const Path = z.string().refine(value => value.startsWith('/') && normalize(value) === value && !/[\p{Cc}]/u.test(value));
const Host = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const Command = z.object({ python: Path, executable: Path, policyFile: Path,
  timeoutMs: z.number().int().min(1).max(300_000).optional(), transport: FleetSshTransportSchema.optional() }).strict();
const Authority = z.object({ python: Path, executable: Path, sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  policy_file: Path, policy_sha256: z.string().regex(/^[a-f0-9]{64}$/u), timeout_ms: z.number().int().min(1).max(120_000).optional() }).strict();
export const FleetControllerConfigSchema = z.object({ version: z.literal(1), controller_host: Host,
  hosts: z.array(z.object({ host_id: Host, command: Command,
    authority_socket: Path.optional(), auth_socket: Path.optional(),
    authority_remote_socket: Path.optional(), auth_remote_socket: Path.optional(),
    adoption: z.object({ executable: Path, policyFile: Path, targets: LegacyAdoptionTargetsSchema }).strict().optional(),
  }).strict()).min(1).max(100),
  authority_command: Authority.optional(),
  adoption_socket: Path.optional(), adoption_group_gid: z.number().int().min(1).max(2_147_483_647).optional(),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>(); const sockets = new Set<string>();
  for (const host of value.hosts) {
    if (seen.has(host.host_id)) context.addIssue({ code: 'custom', message: 'Repeated host' }); seen.add(host.host_id);
    if (host.host_id !== value.controller_host && !host.command.transport) context.addIssue({ code: 'custom', message: 'Remote host requires an explicit transport' });
    if (host.host_id === value.controller_host && host.command.transport) context.addIssue({ code: 'custom', message: 'Controller requires local transport' });
    if ((host.authority_socket === undefined) !== (value.authority_command === undefined)) context.addIssue({ code: 'custom', message: 'Authority configuration is incomplete' });
    for (const socket of [host.authority_socket, host.auth_socket]) {
      if (socket === undefined) continue;
      if (socket.includes(':')) context.addIssue({ code: 'custom', message: 'Socket path cannot contain a forwarding separator' });
      if (sockets.has(socket)) context.addIssue({ code: 'custom', message: 'Private sockets must be distinct' }); sockets.add(socket);
    }
    const remoteSockets = [host.authority_remote_socket, host.auth_remote_socket].filter(socket => socket !== undefined);
    if (remoteSockets.some(socket => socket.includes(':')) || new Set(remoteSockets).size !== remoteSockets.length) {
      context.addIssue({ code: 'custom', message: 'Remote private sockets must be distinct within their host' });
    }
    if (host.host_id === value.controller_host && (host.authority_remote_socket !== undefined || host.auth_remote_socket !== undefined)) {
      context.addIssue({ code: 'custom', message: 'Controller sockets do not require forwarding' });
    }
    if (host.host_id !== value.controller_host && ((host.authority_socket === undefined) !== (host.authority_remote_socket === undefined)
        || (host.auth_socket === undefined) !== (host.auth_remote_socket === undefined))) {
      context.addIssue({ code: 'custom', message: 'Remote forwarding pair is incomplete' });
    }
  }
  if (!seen.has(value.controller_host)) context.addIssue({ code: 'custom', message: 'Controller host is absent' });
  const adoptionHosts = value.hosts.filter(host => host.adoption !== undefined);
  const adoptionTargets = adoptionHosts.flatMap(host => host.adoption?.targets ?? []).map(target => JSON.stringify(target));
  if ((adoptionHosts.length > 0) !== (value.adoption_socket !== undefined)
      || (value.adoption_group_gid !== undefined && value.adoption_socket === undefined)
      || new Set(adoptionTargets).size !== adoptionTargets.length
      || (value.adoption_socket !== undefined && sockets.has(value.adoption_socket))) {
    context.addIssue({ code: 'custom', message: 'Legacy adoption configuration is incomplete or ambiguous' });
  }
});
export type FleetControllerConfig = z.infer<typeof FleetControllerConfigSchema>;
export async function readFleetControllerConfig(filename: string, controller: string): Promise<FleetControllerConfig> {
  const config = FleetControllerConfigSchema.parse(await readPrivateJson(filename));
  if (config.controller_host !== controller) throw new Error('Fleet controller identity differs');
  return config;
}
export function createFleetControllerTransport(config: FleetControllerConfig): FleetCoordinatorTransport {
  const hosts = new Map(config.hosts.map(host => [host.host_id, host.command]));
  const command = (host: string): HostCommandConfig => {
    const value = hosts.get(host); if (!value) throw new Error('Fleet host transport is unavailable');
    return { python: value.python, executable: value.executable, policyFile: value.policyFile,
      ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
      ...(value.transport === undefined ? {} : { transport: value.transport }) };
  };
  return { perform: async (host, step, execution, signal) => performHostCommand(command(host), step, execution, signal),
    compensate: async (host, execution, signal) => performHostCompensation(command(host), execution, signal) };
}
