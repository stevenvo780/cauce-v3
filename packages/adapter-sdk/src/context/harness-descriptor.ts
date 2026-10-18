import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { harnessDefinition } from '../harnesses/index.js';
import type { HarnessDefinition, HarnessId } from '../sdk/types.js';

export type HarnessLifecycleOperation = 'install' | 'authenticate' | 'execute' | 'update' | 'quota';
export type HarnessLifecycleRecipe = 'runtime-package' | 'provider-login' | 'native-execution' | 'provider-update' | 'quota-collector';
export interface HarnessProviderDescriptor {
  readonly authenticate_argv?: readonly string[];
  readonly quota_argv?: readonly string[];
  readonly verify_argv?: readonly string[];
  readonly update_package?: string;
  readonly fleet_module?: string | null;
}
export interface HarnessDescriptor {
  readonly schema_version: 1;
  readonly harness: HarnessId;
  readonly operations: Readonly<Partial<Record<HarnessLifecycleOperation, HarnessLifecycleRecipe>>>;
  readonly context: { readonly native_document: 'AGENTS.md' | 'CLAUDE.md' | 'SOUL.md' | 'none'; readonly max_bytes: number };
  readonly provider?: HarnessProviderDescriptor;
}
const RECIPES: Readonly<Record<HarnessLifecycleOperation, HarnessLifecycleRecipe>> = {
  install: 'runtime-package', authenticate: 'provider-login', execute: 'native-execution', update: 'provider-update', quota: 'quota-collector',
};
const HARNESS_ID = /^[a-z][a-z0-9_-]{0,63}$/u;
const ARGV0 = /^\/usr\/local\/bin\/[A-Za-z0-9][A-Za-z0-9._+@-]{0,127}$/u;
const ARGUMENT = /^(?:[A-Za-z0-9][A-Za-z0-9_@%+=:,./-]{0,255}|--[A-Za-z0-9][A-Za-z0-9_-]{0,253}|-[A-Za-z0-9_-]{1,254}|\/[A-Za-z0-9_@%+=:,./-]{0,255})$/u;
const NPM_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,127}$/u;
const PROVIDER_FIELDS = ['authenticate_argv', 'quota_argv', 'verify_argv', 'update_package', 'fleet_module'];
function fail(field: string, reason: string): never { throw new Error(`${field}: ${reason}`); }
function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(field, 'must be an object');
  return value as Record<string, unknown>;
}
function validateArgv(field: string, value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) fail(field, 'must be a list of 1 to 8 arguments');
  const argv = value.map((argument: unknown, index): string => {
    if (typeof argument !== 'string') fail(`${field}[${String(index)}]`, 'must be a string');
    return argument;
  });
  if (!ARGV0.test(argv[0] ?? '')) fail(`${field}[0]`, 'must be an absolute executable path under /usr/local/bin');
  argv.slice(1).forEach((argument, index) => {
    if (!ARGUMENT.test(argument)) fail(`${field}[${String(index + 1)}]`, 'contains shell metacharacters or unsafe characters');
    if (argument.split('/').includes('..')) fail(`${field}[${String(index + 1)}]`, 'must not contain parent directory segments');
    if (argument.startsWith('/') && !argument.startsWith('/usr/local/bin/') && !argument.startsWith('/home/node/')) {
      fail(`${field}[${String(index + 1)}]`, 'absolute paths are limited to /usr/local/bin and /home/node');
    }
  });
  return Object.freeze(argv);
}
function validateProvider(operations: Record<string, unknown>, value: unknown, harness: string): HarnessProviderDescriptor {
  const provider = value === undefined ? {} : object(value, 'provider');
  for (const field of Object.keys(provider)) if (!PROVIDER_FIELDS.includes(field)) fail(`provider.${field}`, 'unknown field');
  const validated: { -readonly [K in keyof HarnessProviderDescriptor]: HarnessProviderDescriptor[K] } = {};
  if ('authenticate_argv' in provider) validated.authenticate_argv = validateArgv('provider.authenticate_argv', provider.authenticate_argv);
  if ('quota_argv' in provider) validated.quota_argv = validateArgv('provider.quota_argv', provider.quota_argv);
  if ('verify_argv' in provider) validated.verify_argv = validateArgv('provider.verify_argv', provider.verify_argv);
  if ('update_package' in provider) {
    if (typeof provider.update_package !== 'string' || !NPM_PACKAGE.test(provider.update_package)
      || provider.update_package.endsWith('.tgz')) {
      fail('provider.update_package', 'must be an npm package name');
    }
    validated.update_package = provider.update_package;
  }
  if ('fleet_module' in provider) {
    const module = provider.fleet_module;
    if (module !== null && module !== `fleet_provider_${harness}`) {
      fail('provider.fleet_module', `must be null or exactly 'fleet_provider_${harness}'`);
    }
    validated.fleet_module = typeof module === 'string' ? module : null;
  }
  if ('authenticate' in operations && validated.authenticate_argv === undefined && !validated.fleet_module) {
    fail('provider.authenticate_argv', 'required when operations.authenticate is declared without a fleet module');
  }
  if ('quota' in operations && validated.quota_argv === undefined) fail('provider.quota_argv', 'required when operations.quota is declared');
  if ('update' in operations && validated.update_package === undefined) fail('provider.update_package', 'required when operations.update is declared');
  if (validated.authenticate_argv !== undefined && !('authenticate' in operations)) fail('provider.authenticate_argv', 'declared without operations.authenticate');
  if (validated.quota_argv !== undefined && !('quota' in operations)) fail('provider.quota_argv', 'declared without operations.quota');
  if (validated.verify_argv !== undefined && !('authenticate' in operations)) fail('provider.verify_argv', 'declared without operations.authenticate');
  if (validated.update_package !== undefined && !('update' in operations)) fail('provider.update_package', 'declared without operations.update');
  return Object.freeze(validated);
}
export function parseHarnessDescriptor(value: unknown): HarnessDescriptor {
  const raw = object(value, '$');
  for (const field of Object.keys(raw)) {
    if (!['schema_version', 'harness', 'operations', 'context', 'provider'].includes(field)) fail(field, 'unknown field');
  }
  if (raw.schema_version !== 1) fail('schema_version', 'must be 1');
  if (typeof raw.harness !== 'string' || !HARNESS_ID.test(raw.harness)) fail('harness', 'must match [a-z][a-z0-9_-]{0,63}');
  const operations = object(raw.operations, 'operations');
  for (const [name, recipe] of Object.entries(operations)) {
    if (!Object.hasOwn(RECIPES, name)) fail(`operations.${name}`, 'unknown lifecycle operation');
    if (recipe !== RECIPES[name as HarnessLifecycleOperation]) fail(`operations.${name}`, `must be the '${RECIPES[name as HarnessLifecycleOperation]}' recipe`);
  }
  if (operations.execute !== 'native-execution') fail('operations.execute', 'native execution is required');
  const context = object(raw.context, 'context');
  if (Object.keys(context).length !== 2 || !('native_document' in context) || !('max_bytes' in context)) {
    fail('context', 'must declare exactly native_document and max_bytes');
  }
  if (typeof context.native_document !== 'string' || !['AGENTS.md', 'CLAUDE.md', 'SOUL.md', 'none'].includes(context.native_document)) {
    fail('context.native_document', 'must be AGENTS.md, CLAUDE.md, SOUL.md or none');
  }
  if (typeof context.max_bytes !== 'number' || !Number.isSafeInteger(context.max_bytes)
    || context.max_bytes < 1024 || context.max_bytes > 262_144) fail('context.max_bytes', 'must be an integer between 1024 and 262144');
  const provider = validateProvider(operations, raw.provider, raw.harness);
  return Object.freeze({ schema_version: 1, harness: raw.harness,
    operations: Object.freeze({ ...operations }),
    context: Object.freeze({ native_document: context.native_document, max_bytes: context.max_bytes }) as HarnessDescriptor['context'],
    ...('provider' in raw ? { provider } : {}) });
}
export async function packagedHarnessIds(): Promise<string[]> {
  const entries = await readdir(new URL('../../descriptors/', import.meta.url));
  return entries.filter(entry => entry.endsWith('.json')).map(entry => entry.slice(0, -5))
    .filter(name => HARNESS_ID.test(name)).sort();
}
async function readHarnessDescriptor(directory: URL, harness: string, expectedSha256?: string): Promise<HarnessDescriptor> {
  if (!HARNESS_ID.test(harness)) fail('harness', 'invalid descriptor file name');
  const raw = await readFile(new URL(`${harness}.json`, directory));
  if (expectedSha256 !== undefined && (!/^[a-f0-9]{64}$/u.test(expectedSha256)
    || createHash('sha256').update(raw).digest('hex') !== expectedSha256)) fail('descriptor_sha256', 'descriptor differs from its approved digest');
  const value: unknown = JSON.parse(raw.toString('utf8'));
  const descriptor = parseHarnessDescriptor(value);
  if (descriptor.harness !== harness) fail('harness', 'descriptor identity differs from its file name');
  return descriptor;
}
/** Reads one published descriptor without an approval pin: it proves the catalog declares the harness, not that the owner approved its runtime operations. */
export async function publishedHarnessDescriptor(directory: URL, harness: string): Promise<HarnessDescriptor> {
  return readHarnessDescriptor(directory, harness);
}
export async function packagedHarnessDescriptor(harness: HarnessId, expectedSha256?: string): Promise<HarnessDescriptor> {
  return readHarnessDescriptor(new URL('../../descriptors/', import.meta.url), harness, expectedSha256);
}
const APPROVED_PIN = /^[a-f0-9]{64}$/u;
export async function approvedHarnessDescriptors(directory: URL, approvals: Readonly<Record<string, string>>): Promise<readonly HarnessDescriptor[]> {
  const pins = Object.entries(approvals);
  if (pins.some(([harness, pin]) => !HARNESS_ID.test(harness) || !APPROVED_PIN.test(pin))) return [];
  const root = new URL(directory.href);
  if (!root.pathname.endsWith('/')) root.pathname += '/';
  const approved: HarnessDescriptor[] = [];
  for (const [harness, pin] of pins) {
    const file = new URL(`${harness}.json`, root);
    if (file.protocol !== root.protocol || !file.pathname.startsWith(root.pathname)) return [];
    try {
      const raw = await readFile(file);
      if (createHash('sha256').update(raw).digest('hex') !== pin) continue;
      const descriptor = parseHarnessDescriptor(JSON.parse(raw.toString('utf8')));
      if (descriptor.harness !== harness) continue;
      approved.push(descriptor);
    } catch { continue; }
  }
  approved.sort((left, right) => (left.harness < right.harness ? -1 : left.harness > right.harness ? 1 : 0));
  return approved;
}
export interface HarnessLifecycleExecutor {
  run(input: { readonly harness: HarnessId; readonly operation: HarnessLifecycleOperation; readonly recipe: HarnessLifecycleRecipe }): Promise<unknown>;
}
export async function executeHarnessOperation(descriptor: HarnessDescriptor, operation: HarnessLifecycleOperation,
  executor: HarnessLifecycleExecutor): Promise<unknown> {
  const valid = parseHarnessDescriptor(descriptor);
  const recipe = valid.operations[operation];
  if (recipe === undefined) fail(`operations.${operation}`, 'operation is not declared by this harness descriptor');
  return executor.run({ harness: valid.harness, operation, recipe });
}
export function definitionFromDescriptor(descriptor: HarnessDescriptor): HarnessDefinition {
  const valid = parseHarnessDescriptor(descriptor);
  if (valid.operations.execute !== 'native-execution') fail('operations.execute', 'native execution is required');
  return harnessDefinition(valid.harness);
}
