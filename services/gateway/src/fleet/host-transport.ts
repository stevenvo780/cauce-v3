import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, normalize } from 'node:path';
import { z } from 'zod';

const Path = z.string().regex(/^\//u).refine(value => normalize(value) === value && !/[\p{Cc}]/u.test(value));
const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const FleetSshTransportSchema = z.object({
  executable: z.literal('/usr/bin/ssh'), executable_sha256: Hash,
  destination: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}@[a-z0-9][a-z0-9.-]{0,252}$/u),
  known_hosts_file: Path, known_hosts_sha256: Hash, port: z.number().int().min(1).max(65535).optional(),
  identity_file: Path.optional(), identity_sha256: Hash.optional(),
}).strict().refine(value => (value.identity_file === undefined) === (value.identity_sha256 === undefined));
export type FleetSshTransport = z.infer<typeof FleetSshTransportSchema>;

async function pin(filename: string, expected: string, privateFile: boolean): Promise<void> {
  let parent = dirname(filename);
  for (;;) {
    const stat = await lstat(parent);
    const temporary = ['/tmp', '/var/tmp'].includes(parent) && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (!stat.isDirectory() || ![0, process.geteuid?.()].includes(stat.uid) || ((stat.mode & 0o022) !== 0 && !temporary)) {
      throw new Error('Fleet transport parent is invalid');
    }
    if (parent === '/') break;
    parent = dirname(parent);
  }
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || ![0, process.geteuid?.()].includes(stat.uid)
      || (stat.mode & (privateFile ? 0o077 : 0o022)) !== 0 || stat.size > 8_388_608) throw new Error('Fleet transport pin is invalid');
    const body = await file.readFile();
    if (body.byteLength > 8_388_608 || createHash('sha256').update(body).digest('hex') !== expected) throw new Error('Fleet transport pin changed');
  } finally { await file.close(); }
}
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
export async function fleetSshArguments(input: FleetSshTransport, options: { clearForwardings?: boolean } = {}): Promise<string[]> {
  const transport = FleetSshTransportSchema.parse(input);
  await pin(transport.executable, transport.executable_sha256, false);
  await pin(transport.known_hosts_file, transport.known_hosts_sha256, false);
  if (transport.identity_file && transport.identity_sha256) await pin(transport.identity_file, transport.identity_sha256, true);
  const arguments_ = ['-F', '/dev/null', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${transport.known_hosts_file}`, '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=10', '-o', 'LogLevel=ERROR',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'IdentitiesOnly=yes'];
  if (options.clearForwardings !== false) arguments_.push('-o', 'ClearAllForwardings=yes');
  if (transport.port) arguments_.push('-p', String(transport.port));
  if (transport.identity_file) arguments_.push('-i', transport.identity_file);
  return arguments_;
}
export async function fleetHostSpawn(config: { python: string; executable: string; policyFile: string; transport?: FleetSshTransport }, step: string) {
  const arguments_ = [config.executable, '--policy', config.policyFile, '--step', step];
  if (!config.transport) return { executable: config.python, arguments: arguments_ };
  const options = await fleetSshArguments(config.transport);
  return { executable: config.transport.executable, arguments: [...options, config.transport.destination,
    [config.python, ...arguments_].map(quote).join(' ')] };
}
