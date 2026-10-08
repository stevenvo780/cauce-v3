import { readFile } from 'node:fs/promises';
import { Agent, request } from 'node:https';
import { isDeepStrictEqual } from 'node:util';
import { AliasSchema, TenantSchema, normalizeAgentProfile, type ContextoDeAlias } from '@cauce/protocol';

export type BootstrapPhase = 'bootstrap' | 'normal';
export interface BootstrapDocument { name: string; sha256: string; native_revision: number | null }
export interface BootstrapDescriptor {
  operation_id: string; phase: BootstrapPhase; action: 'profile' | 'verify'; nonce: string; account_id: string;
  profile_revision: number; probe_id: string; tenant_id: string; alias: string; runtime_key: string;
  harness_id: string; model_id: string | null; reasoning_effort?: string | null | undefined; deadline: string; prompt: string; documents: BootstrapDocument[]; claim_token: string;
}
export interface BootstrapProfile {
  operation_id: string; phase: BootstrapPhase; tenant_id: string; alias: string; runtime_key: string;
  harness_id: string; model_id: string | null; reasoning_effort?: string | null | undefined; account_id: string; profile_revision: number; contexto: ContextoDeAlias; documents: BootstrapDocument[];
}
export interface BootstrapState {
  operation_id: string; phase: BootstrapPhase; status: string; enabled: boolean; lifecycle_state: string;
  runtime_key: string; profile_revision: number; account_id: string; normal_admitted: boolean;
}
export interface BootstrapProof {
  operation_id: string; phase: BootstrapPhase; runtime_key: string; nonce: string; claim_token: string;
  account_id: string; profile_revision: number; harness_id: string; model_id: string | null; reasoning_effort?: string | null | undefined;
  documents: BootstrapDocument[]; reply: string | null; harness_started: boolean;
}
export interface BootstrapTransport {
  claim(signal: AbortSignal): Promise<BootstrapDescriptor | null>;
  profile(signal: AbortSignal): Promise<BootstrapProfile>;
  state(signal: AbortSignal): Promise<BootstrapState>;
  ack(probe: BootstrapDescriptor, proof: BootstrapProof, signal: AbortSignal): Promise<void>;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const HEX = /^[a-f0-9]{64}$/u;
const ID = /^[a-z][a-z0-9_-]{0,63}$/u;
const documentNames = new Set(['AGENTS.md', 'CLAUDE.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'TOOLS.md']);
export function bootstrapObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid bootstrap response');
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some(key => !keys.includes(key))) throw new Error('invalid bootstrap response');
  return object;
}
export function bootstrapString(value: unknown, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || (pattern !== undefined && !pattern.test(value))) {
    throw new Error('invalid bootstrap response');
  }
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('invalid bootstrap response'); return value;
}
function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('invalid bootstrap response'); return value;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('invalid bootstrap response'); return value.map(item => bootstrapString(item));
}
function nullable(value: unknown): string | null { return value === null ? null : bootstrapString(value); }
export function bootstrapDocuments(value: unknown): BootstrapDocument[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) throw new Error('invalid bootstrap documents');
  const documents = value.map(item => {
    const object = bootstrapObject(item, ['name', 'sha256', 'native_revision']);
    const name = bootstrapString(object.name);
    if (!documentNames.has(name)) throw new Error('invalid bootstrap documents');
    return { name, sha256: bootstrapString(object.sha256, HEX), native_revision: object.native_revision === null ? null : revision(object.native_revision) };
  });
  if (new Set(documents.map(file => file.name)).size !== documents.length) throw new Error('invalid bootstrap documents');
  return documents;
}
const scopeKeys = ['operation_id', 'phase', 'tenant_id', 'alias', 'runtime_key', 'harness_id', 'model_id', 'reasoning_effort', 'account_id', 'profile_revision'];
function scope(value: Record<string, unknown>): Omit<BootstrapProfile, 'contexto' | 'documents'> {
  if (value.phase !== 'bootstrap' && value.phase !== 'normal') throw new Error('invalid bootstrap phase');
  return { operation_id: bootstrapString(value.operation_id, UUID), phase: value.phase,
    tenant_id: TenantSchema.parse(value.tenant_id), alias: AliasSchema.parse(value.alias),
    runtime_key: bootstrapString(value.runtime_key, /^[a-z][a-z0-9-]{0,63}$/u), harness_id: bootstrapString(value.harness_id, ID),
    model_id: nullable(value.model_id), ...(value.reasoning_effort === undefined ? {} : { reasoning_effort: value.reasoning_effort === null ? null
      : bootstrapString(value.reasoning_effort, /^(?:minimal|low|medium|high|xhigh|max)$/u) }),
    account_id: bootstrapString(value.account_id, ID), profile_revision: revision(value.profile_revision) };
}
export function parseBootstrapDescriptor(value: unknown): BootstrapDescriptor {
  const object = bootstrapObject(value, [...scopeKeys, 'action', 'nonce', 'probe_id', 'deadline', 'prompt', 'documents', 'claim_token']);
  if (object.action !== 'profile' && object.action !== 'verify') throw new Error('invalid bootstrap action');
  const nonce = bootstrapString(object.nonce, HEX); const deadline = bootstrapString(object.deadline);
  const prompt = bootstrapString(object.prompt);
  if (!Number.isFinite(Date.parse(deadline)) || prompt !== `Responde únicamente CAUCE_BOOTSTRAP_${nonce}. No uses herramientas ni envíes mensajes.`) {
    throw new Error('invalid bootstrap descriptor');
  }
  return { ...scope(object), action: object.action, nonce, deadline, prompt,
    probe_id: bootstrapString(object.probe_id, UUID), documents: bootstrapDocuments(object.documents), claim_token: bootstrapString(object.claim_token, HEX) };
}
export function parseBootstrapProfile(value: unknown): BootstrapProfile {
  const object = bootstrapObject(value, [...scopeKeys, 'contexto', 'documents']); const identity = scope(object);
  const context = bootstrapObject(object.contexto, ['perfil', 'hechos']);
  const authored = bootstrapObject(context.perfil, ['tenant_id', 'alias', 'purpose', 'role_summary', 'human_brief', 'responsibilities', 'restrictions', 'tools', 'operating_rules']);
  const perfil = normalizeAgentProfile(authored);
  const facts = bootstrapObject(context.hechos, ['permisos', 'cuotas', 'arnes', 'destinos']);
  const permissions = bootstrapObject(facts.permisos, ['ruta', 'lectura', 'control', 'notificacion']);
  const harness = bootstrapObject(facts.arnes, ['harness', 'home', 'contenedor', 'capacidades']);
  if (!Array.isArray(facts.cuotas)) throw new Error('invalid bootstrap profile');
  const quotas = facts.cuotas.map(item => {
    const quota = bootstrapObject(item, ['proveedor', 'cuenta', 'limite']);
    return { proveedor: bootstrapString(quota.proveedor), cuenta: bootstrapString(quota.cuenta),
      ...(quota.limite === undefined ? {} : { limite: bootstrapString(quota.limite) }) };
  });
  if (perfil.tenant_id !== identity.tenant_id || perfil.alias !== identity.alias || harness.harness !== identity.harness_id) {
    throw new Error('invalid bootstrap profile identity');
  }
  return { ...identity, documents: bootstrapDocuments(object.documents), contexto: { perfil, hechos: {
    permisos: { ruta: boolean(permissions.ruta), lectura: boolean(permissions.lectura), control: boolean(permissions.control), notificacion: boolean(permissions.notificacion) },
    cuotas: quotas, destinos: strings(facts.destinos), arnes: { harness: identity.harness_id, home: bootstrapString(harness.home),
      capacidades: strings(harness.capacidades), ...(harness.contenedor === undefined ? {} : { contenedor: bootstrapString(harness.contenedor) }) },
  } } };
}
function parseState(value: unknown): BootstrapState {
  const object = bootstrapObject(value, ['operation_id', 'phase', 'status', 'enabled', 'lifecycle_state', 'runtime_key', 'profile_revision', 'account_id', 'normal_admitted']);
  if (object.phase !== 'bootstrap' && object.phase !== 'normal') throw new Error('invalid bootstrap phase');
  return { operation_id: bootstrapString(object.operation_id, UUID), phase: object.phase, status: bootstrapString(object.status),
    enabled: boolean(object.enabled), lifecycle_state: bootstrapString(object.lifecycle_state), runtime_key: bootstrapString(object.runtime_key),
    profile_revision: revision(object.profile_revision), account_id: bootstrapString(object.account_id, ID), normal_admitted: boolean(object.normal_admitted) };
}
export class BootstrapClient implements BootstrapTransport {
  private readonly origin: URL;
  private readonly agent: Promise<Agent>;
  constructor(private readonly options: { origin: string; operation_id: string; phase: BootstrapPhase; runtime_key: string;
    tls: { certFile: string; keyFile: string; caFile: string } }) {
    bootstrapString(options.operation_id, UUID); bootstrapString(options.runtime_key, /^[a-z][a-z0-9-]{0,63}$/u);
    this.origin = new URL(options.origin);
    if (this.origin.protocol !== 'https:' || this.origin.username || this.origin.password || this.origin.search || this.origin.hash || this.origin.pathname !== '/') {
      throw new Error('bootstrap requires an https origin');
    }
    this.agent = Promise.all([readFile(options.tls.certFile), readFile(options.tls.keyFile), readFile(options.tls.caFile)])
      .then(([cert, key, ca]) => new Agent({ cert, key, ca, rejectUnauthorized: true }));
  }
  close(): void { void this.agent.then(agent => { agent.destroy(); }, () => undefined); }
  private async call(method: string, path: string, signal: AbortSignal, payload?: unknown): Promise<unknown> {
    const agent = await this.agent; const body = payload === undefined ? undefined : JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      const req = request(new URL(path, this.origin), { method, agent, signal, timeout: 10_000,
        headers: { 'x-cauce-bootstrap-phase': this.options.phase, ...(body === undefined ? {} : { 'content-type': 'application/json' }) } }, response => {
        const chunks: Buffer[] = []; let bytes = 0;
        response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 262_144) { req.destroy(new Error('bootstrap response too large')); } else chunks.push(chunk); });
        response.on('error', () => { reject(new Error('bootstrap transport failed')); });
        response.on('end', () => {
          if (response.statusCode !== 200 && response.statusCode !== 201) { reject(new Error('bootstrap request rejected')); return; }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown); } catch { reject(new Error('invalid bootstrap response')); }
        });
      });
      req.on('timeout', () => { req.destroy(new Error('bootstrap transport timeout')); });
      req.on('error', () => { reject(new Error('bootstrap transport failed')); });
      req.end(body);
    });
  }
  async claim(signal: AbortSignal): Promise<BootstrapDescriptor | null> {
    const value = await this.call('POST', '/v3/bootstrap/claim', signal, { operation_id: this.options.operation_id, phase: this.options.phase, runtime_key: this.options.runtime_key });
    return value === null ? null : parseBootstrapDescriptor(value);
  }
  async profile(signal: AbortSignal): Promise<BootstrapProfile> {
    return parseBootstrapProfile(await this.call('GET', `/v3/bootstrap/profile?operation_id=${this.options.operation_id}`, signal));
  }
  async state(signal: AbortSignal): Promise<BootstrapState> {
    return parseState(await this.call('GET', `/v3/bootstrap/state?operation_id=${this.options.operation_id}`, signal));
  }
  async ack(probe: BootstrapDescriptor, proof: BootstrapProof, signal: AbortSignal): Promise<void> {
    const receipt = bootstrapObject(await this.call('POST', `/v3/bootstrap/probes/${probe.probe_id}/ack`, signal, proof), ['probe', 'state', 'proof']);
    const { claim_token: _secret, ...expected } = proof;
    const { claim_token: _token, ...descriptor } = probe;
    if (receipt.state !== 'succeeded' || !isDeepStrictEqual(receipt.proof, expected)
        || !isDeepStrictEqual(receipt.probe, descriptor)) throw new Error('invalid bootstrap acknowledgment');
  }
}
