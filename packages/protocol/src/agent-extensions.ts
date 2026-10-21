import { z } from 'zod';
import { AliasSchema, Sha256HexSchema } from './schemas/core.js';

export const EXTENSION_TYPES = ['mount', 'network', 'resources', 'gpu', 'ssh', 'docker', 'browser', 'mcp', 'tools', 'full_control', 'model_fallback'] as const;
export const ExtensionTypeSchema = z.enum(EXTENSION_TYPES);
export type ExtensionType = z.infer<typeof ExtensionTypeSchema>;

const AbsolutePathSchema = z.string().min(1).max(4096).regex(/^\/[^\p{Cc}:,]*$/u)
  .refine(value => value === '/' || value.slice(1).split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'),
    'Use an absolute path without empty, dot or parent segments');
const ExtensionNameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u);
const NetworkNameSchema = ExtensionNameSchema
  .refine(value => value !== 'host' && value !== 'none', 'Use an isolated Docker network');
const EnvironmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u);
const HostSchema = z.union([z.hostname().max(253), z.ipv4(), z.ipv6()]);
const PortSchema = z.number().int().min(1).max(65_535);
const SshHostSchema = z.string().max(512).refine(value => {
  const match = /^([a-z_][a-z0-9_-]{0,31})@(\[[a-fA-F0-9:]+\]|[^:\s]+)(?::([0-9]{1,5}))?$/u.exec(value);
  if (match === null) return false;
  const host = match[2];
  if (host === undefined || !HostSchema.safeParse(host.replace(/^\[|\]$/gu, '')).success) return false;
  return match[3] === undefined || PortSchema.safeParse(Number(match[3])).success;
}, 'Use user@host[:port], with IPv6 hosts enclosed in brackets');
const FixedToolPackageSchema = z.string().max(512).regex(
  /^(?:npm:(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?|pip:[A-Za-z0-9][A-Za-z0-9._-]*==[0-9][A-Za-z0-9.!+_-]*)$/u,
  'Use npm:package@exact.version or pip:package==exact-version',
);
const RESOURCE_LIMIT = 2n ** 63n;
function supportedMemoryLimit(value: string): boolean {
  const match = /^([1-9][0-9]*)([bkmg]?)$/iu.exec(value);
  if (match?.[1] === undefined) return false;
  const suffix = match[2]?.toLowerCase();
  const exponent = suffix ? 'bkmg'.indexOf(suffix) : 0;
  return BigInt(match[1]) * 1024n ** BigInt(exponent) < RESOURCE_LIMIT;
}
function supportedCpuLimit(value: number): boolean {
  const match = /^([0-9]+)(?:\.([0-9]+))?(?:e([+-]?[0-9]+))?$/iu.exec(String(value));
  if (match?.[1] === undefined) return false;
  const fraction = match[2] ?? '';
  const digits = BigInt(match[1] + fraction);
  const exponent = 9 + Number(match[3] ?? 0) - fraction.length;
  const scale = 10n ** BigInt(Math.abs(exponent));
  if (exponent < 0 && digits % scale !== 0n) return false;
  const amount = exponent < 0 ? digits / scale : digits * scale;
  return amount > 0n && amount < RESOURCE_LIMIT;
}
const ResourcesExtensionSchema = z.object({
  type: z.literal('resources'),
  memory: z.string().max(32).regex(/^[1-9][0-9]*(?:[bkmg])?$/iu)
    .refine(supportedMemoryLimit, 'Memory bytes must be a positive integer below 2^63').optional(),
  cpus: z.number().positive().refine(supportedCpuLimit, 'NanoCPUs must be a positive integer below 2^63').optional(),
  pids: z.number().int().min(1).max(4096).optional(),
}).strict().refine(value => value.memory !== undefined || value.cpus !== undefined || value.pids !== undefined,
  'Declare at least one resource limit');
/** The Muse model id OpenClaw names as `muse-cli/<model>`: no provider prefix. */
const FallbackModelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,111}$/u);
const BrowserExtensionSchema = z.discriminatedUnion('mode', [
  z.object({ type: z.literal('browser'), mode: z.literal('sidecar') }).strict(),
  z.object({ type: z.literal('browser'), mode: z.literal('ssh_tunnel'), host: HostSchema, port: PortSchema }).strict(),
]);

export const ExtensionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mount'), source: AbsolutePathSchema, target: AbsolutePathSchema, mode: z.enum(['ro', 'rw']) }).strict(),
  z.object({ type: z.literal('network'), name: NetworkNameSchema }).strict(),
  ResourcesExtensionSchema,
  z.object({ type: z.literal('gpu') }).strict(),
  z.object({ type: z.literal('ssh'), hosts: z.array(SshHostSchema).min(1).max(100) }).strict(),
  z.object({ type: z.literal('docker'), access: z.enum(['read', 'control']) }).strict(),
  BrowserExtensionSchema,
  z.object({
    type: z.literal('mcp'), name: ExtensionNameSchema,
    command: z.string().min(1).max(512).regex(/^[^\p{Cc}\s]+$/u),
    args: z.array(z.string().max(4096).regex(/^[^\p{Cc}]*$/u)).max(100),
    env: z.array(EnvironmentNameSchema).max(100),
  }).strict(),
  z.object({ type: z.literal('tools'), packages: z.array(FixedToolPackageSchema).min(1).max(100) }).strict(),
  z.object({ type: z.literal('full_control') }).strict(),
  z.object({ type: z.literal('model_fallback'), agent: AliasSchema, model: FallbackModelSchema }).strict(),
]);
export type Extension = z.infer<typeof ExtensionSchema>;

export const AgentExtensionsSchema = z.array(ExtensionSchema).max(100).superRefine((extensions, context) => {
  const identities = new Set<string>();
  for (const [index, extension] of extensions.entries()) {
    const identity = extension.type === 'mount' ? `mount:${extension.target}`
      : extension.type === 'network' || extension.type === 'mcp' ? `${extension.type}:${extension.name}` : extension.type;
    if (identities.has(identity)) context.addIssue({ code: 'custom', path: [index], message: 'Duplicate extension or extension destination' });
    identities.add(identity);
    if (extension.type === 'browser' && extension.mode === 'ssh_tunnel' && !extensions.some(candidate => candidate.type === 'ssh')) {
      context.addIssue({ code: 'custom', path: [index], message: 'A browser SSH tunnel requires the ssh extension' });
    }
    const items = extension.type === 'ssh' ? extension.hosts : extension.type === 'tools' ? extension.packages
      : extension.type === 'mcp' ? extension.env : undefined;
    if (items !== undefined && new Set(items).size !== items.length) {
      context.addIssue({ code: 'custom', path: [index], message: 'Duplicate extension entries' });
    }
  }
});
export const ExtensionsSchema = AgentExtensionsSchema;

/** `model_fallback` pairs an OpenClaw client with the Muse agent that serves it; both declare each other. */
export const MODEL_FALLBACK_HARNESSES: readonly string[] = ['openclaw', 'muse'];
export function agentExtensionsHarnessViolation(extensions: AgentExtensions, harness: string): string | undefined {
  return extensions.some(extension => extension.type === 'model_fallback') && !MODEL_FALLBACK_HARNESSES.includes(harness)
    ? 'La ampliación model_fallback solo existe en un agente OpenClaw (cliente) o Muse (servidor).' : undefined;
}
export type AgentExtensions = z.infer<typeof AgentExtensionsSchema>;

export const ExtensionsAllowedSchema = z.object({
  types: z.array(ExtensionTypeSchema).max(EXTENSION_TYPES.length),
  mount_roots: z.array(AbsolutePathSchema).max(100),
  networks: z.array(NetworkNameSchema).max(100),
  docker_access: z.array(z.enum(['read', 'control'])).min(1).max(2)
    .refine(levels => levels.includes('read'), 'Docker control requires read access').optional(),
  docker_daemon_dedicated: z.boolean().optional(),
}).strict().superRefine((allowed, context) => {
  for (const field of ['types', 'mount_roots', 'networks', 'docker_access'] as const) {
    const entries = allowed[field];
    if (entries !== undefined && new Set(entries).size !== entries.length) {
      context.addIssue({ code: 'custom', path: [field], message: 'Duplicate policy entries' });
    }
  }
});
export type ExtensionsAllowed = z.infer<typeof ExtensionsAllowedSchema>;

export const ExtensionPreparationReceiptSchema = z.object({
  extensions_sha256: Sha256HexSchema,
  ssh: z.object({
    public_key: z.string().max(512).regex(/^ssh-ed25519 [A-Za-z0-9+/]{68}(?: [^\p{Cc}]{1,128})?$/u),
    fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/u),
    hosts: z.array(SshHostSchema).min(1).max(100),
  }).strict().optional(),
  mcp: z.object({
    harness: z.enum(['claude', 'codex', 'openclaw', 'grok', 'muse']),
    path: z.enum(['.claude.json', 'config.toml', 'openclaw.json', 'config/muse/settings.json']),
    names: z.array(ExtensionNameSchema).max(100), removed: z.array(ExtensionNameSchema).max(100),
  }).strict().optional(),
  tools: z.object({ packages: z.array(FixedToolPackageSchema).min(1).max(100) }).strict().optional(),
  browser: z.object({
    mode: z.literal('ssh_tunnel'), host: HostSchema, port: PortSchema,
    cdp_url: z.url().max(128).regex(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u),
  }).strict().optional(),
}).strict();
export type ExtensionPreparationReceipt = z.infer<typeof ExtensionPreparationReceiptSchema>;

export function agentExtensionsPolicyViolation(extensions: AgentExtensions, allowed: ExtensionsAllowed): string | undefined {
  for (const extension of extensions) {
    if (!allowed.types.includes(extension.type)) return `El ordenador no admite la ampliación ${extension.type}.`;
    if (extension.type === 'mount' && !allowed.mount_roots.some(root => root === '/' || extension.source === root || extension.source.startsWith(`${root}/`))) {
      return `El origen ${extension.source} queda fuera de las raíces de montaje permitidas.`;
    }
    if (extension.type === 'network' && !allowed.networks.includes(extension.name)) {
      return `El ordenador no admite la red ${extension.name}.`;
    }
    if (extension.type === 'docker' && !allowed.docker_access?.includes(extension.access)) {
      return `El ordenador no admite el acceso Docker ${extension.access}.`;
    }
  }
  return undefined;
}
