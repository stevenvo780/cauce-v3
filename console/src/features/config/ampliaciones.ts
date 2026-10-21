import { AgentExtensionsSchema, ExtensionsAllowedSchema, type ExtensionsAllowed, type ExtensionType } from '@cauce/protocol/agent-extensions';
import type { ConfigMutation, ConfigurationSnapshot } from '../../api/types';
import type { Tone } from '../../status-tone';

export type { ExtensionType };
export type RiskLevel = 'bajo' | 'medio' | 'alto' | 'maximo';

export interface AgentExtension {
  type: ExtensionType;
  source?: string;
  target?: string;
  mode?: string;
  name?: string;
  memory?: string;
  cpus?: number;
  pids?: number;
  hosts?: string[];
  access?: string;
  host?: string;
  port?: number;
  command?: string;
  args?: string[];
  env?: string[];
  packages?: string[];
  agent?: string;
  model?: string;
}

export type HostExtensionsAllowed = ExtensionsAllowed;

export interface CatalogEntry {
  type: ExtensionType;
  label: string;
  allows: string;
  riskLabel: string;
  tone: Tone;
}

export const RISK_TONE: Record<RiskLevel, Tone> = { bajo: 'ok', medio: 'warn', alto: 'danger', maximo: 'danger' };
export const RISK_LABEL: Record<RiskLevel, string> = { bajo: 'Bajo', medio: 'Medio', alto: 'Alto', maximo: 'Máximo' };

export function extensionRisk(ext: Pick<AgentExtension, 'type' | 'mode' | 'access'>): RiskLevel {
  switch (ext.type) {
    case 'resources': return 'bajo';
    case 'mount': return ext.mode === 'rw' ? 'alto' : 'medio';
    case 'docker': return 'alto';
    case 'ssh': return 'alto';
    case 'full_control': return 'maximo';
    default: return 'medio';
  }
}

export const EXTENSION_CATALOG: CatalogEntry[] = [
  { type: 'mount', label: 'Montaje', allows: 'Montar una carpeta del ordenador dentro del contenedor', riskLabel: 'Medio (solo lectura) · Alto (lectura y escritura)', tone: 'warn' },
  { type: 'network', label: 'Red adicional', allows: 'Conectar el contenedor a otra red Docker existente', riskLabel: 'Medio', tone: 'warn' },
  { type: 'resources', label: 'Recursos', allows: 'Más memoria, CPU o procesos que el perfil base', riskLabel: 'Bajo', tone: 'ok' },
  { type: 'gpu', label: 'GPU', allows: 'Acceso a todas las GPU del ordenador (--gpus all)', riskLabel: 'Medio', tone: 'warn' },
  { type: 'ssh', label: 'SSH saliente', allows: 'Clave propia del agente para entrar en otros equipos; la privada nunca sale del perfil', riskLabel: 'Alto', tone: 'danger' },
  { type: 'docker', label: 'Docker', allows: 'Leer los metadatos y el entorno de todos los contenedores del ordenador; con control, operar Docker mediante un proxy propio', riskLabel: 'Alto (control equivale a root en el host)', tone: 'danger' },
  { type: 'browser', label: 'Navegador', allows: 'Navegador Chromium propio o túnel SSH a un navegador remoto (CDP)', riskLabel: 'Medio', tone: 'warn' },
  { type: 'mcp', label: 'Servidor MCP', allows: 'Registrar un servidor MCP en la configuración del arnés, dentro del perfil', riskLabel: 'Según el MCP', tone: 'warn' },
  { type: 'tools', label: 'Herramientas', allows: 'Instalar paquetes npm o pip con versión fija, sin root, en el volumen de estado', riskLabel: 'Medio', tone: 'warn' },
  { type: 'model_fallback', label: 'Respaldo Muse', allows: 'Un agente OpenClaw responde con un agente Muse propio, del mismo ordenador, si su modelo falla; los dos se declaran mutuamente y solo comparten un socket', riskLabel: 'Medio', tone: 'warn' },
  { type: 'full_control', label: 'Control total', allows: 'Raíz escribible y sin cap-drop. Salida de emergencia para agentes de infraestructura', riskLabel: 'Máximo', tone: 'danger' },
];

export function catalogEntry(type: ExtensionType): CatalogEntry {
  return EXTENSION_CATALOG.find((entry) => entry.type === type)
    ?? { type: 'mount', label: 'Montaje', allows: 'Montar una carpeta del ordenador dentro del contenedor', riskLabel: 'Medio', tone: 'warn' };
}

export function parseExtensions(raw: unknown): { known: AgentExtension[]; published: boolean } {
  const result = AgentExtensionsSchema.safeParse(raw);
  return result.success ? { known: result.data, published: true } : { known: [], published: false };
}

export function readAgentExtensions(snapshot: ConfigurationSnapshot, tenantId: string, alias: string): { known: AgentExtension[]; published: boolean } {
  const row = snapshot.agents?.find((item) => item.tenant_id === tenantId && item.alias === alias);
  if (!row || !('extensions' in row)) return { known: [], published: false };
  return parseExtensions(row.extensions);
}

function text(value: string | undefined, fallback = ''): string {
  return value ?? fallback;
}

export function extensionSummary(ext: AgentExtension): string {
  switch (ext.type) {
    case 'mount': return `${text(ext.source, '?')} → ${text(ext.target, '?')} (${text(ext.mode, 'ro')})`;
    case 'network': return text(ext.name);
    case 'resources': {
      const parts: string[] = [];
      if (ext.memory) parts.push(`memoria ${ext.memory}`);
      if (ext.cpus !== undefined) parts.push(`CPU ${String(ext.cpus)}`);
      if (ext.pids !== undefined) parts.push(`procesos ${String(ext.pids)}`);
      return parts.join(' · ') || 'Sin detalle';
    }
    case 'gpu': return 'Todas las GPU';
    case 'ssh': return (ext.hosts ?? []).join(', ') || 'Sin destinos';
    case 'docker': return ext.access === 'control' ? 'Control (equivale a root en el host)' : 'Solo lectura';
    case 'browser': return ext.mode === 'ssh_tunnel' ? `Túnel SSH a ${text(ext.host, '?')}:${ext.port === undefined ? '' : String(ext.port)}` : 'Chromium propio (sidecar)';
    case 'mcp': return [ext.name, ext.command, ...(ext.args ?? [])].filter(Boolean).join(' ') || 'Sin detalle';
    case 'tools': return (ext.packages ?? []).join(', ') || 'Sin paquetes';
    case 'full_control': return 'Raíz escribible, sin cap-drop';
    case 'model_fallback': return `${text(ext.agent, '?')} · muse-cli/${text(ext.model, '?')}`;
  }
}

export function parseHostAllowed(raw: unknown): HostExtensionsAllowed {
  const result = ExtensionsAllowedSchema.safeParse(raw);
  return result.success ? result.data : { types: [], mount_roots: [], networks: [] };
}

export function readHostAllowed(snapshot: ConfigurationSnapshot, hostId: string | undefined, hostRaw?: unknown): { allowed: HostExtensionsAllowed; published: boolean } {
  const rows: unknown = (snapshot as Record<string, unknown>).host_extensions_allowed;
  if (Array.isArray(rows)) {
    const list: unknown[] = rows;
    const row = list.find((item): boolean => {
      if (typeof item !== 'object' || item === null) return false;
      const record = item as Record<string, unknown>;
      return record.host_id === hostId || record.id === hostId;
    });
    if (row !== undefined) {
      const record = row as Record<string, unknown>;
      return { allowed: parseHostAllowed(record.extensions_allowed ?? record.value ?? record), published: true };
    }
    if (hostId) return { allowed: { types: [], mount_roots: [], networks: [] }, published: false };
  }
  if (typeof hostRaw === 'object' && hostRaw !== null && 'extensions_allowed' in hostRaw) {
    return { allowed: parseHostAllowed((hostRaw as Record<string, unknown>).extensions_allowed), published: true };
  }
  return { allowed: { types: [], mount_roots: [], networks: [] }, published: false };
}

export function buildHostExtensionsMutation(hostId: string, allowed: HostExtensionsAllowed): ConfigMutation {
  const mutation: ConfigMutation = {
    resource: 'host_extensions_allowed', action: 'set', host_id: hostId,
    extensions_allowed: { ...allowed },
  };
  return mutation;
}

export function linesToList(value: string): string[] {
  return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}
export function linesOnlyList(value: string): string[] {
  return value.split('\n').map((item) => item.trim()).filter(Boolean);
}

const ABSOLUTE_PATH = /^\/[^\s:,]*$/;
function isAbsolutePath(value: string): boolean {
  if (!ABSOLUTE_PATH.test(value)) return false;
  return value === '/' || value.slice(1).split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}
const FIXED_PACKAGE = /^(?:npm:(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?|pip:[A-Za-z0-9][A-Za-z0-9._-]*==[0-9][A-Za-z0-9.!+_-]*)$/;
const SSH_HOST = /^[a-z_][a-z0-9_-]{0,31}@(\[[a-fA-F0-9:]+\]|[^:\s]+)(?::([0-9]{1,5}))?$/;

export function validateDraft(type: ExtensionType, fields: Partial<Record<string, string>>): { extension?: AgentExtension; error?: string } {
  const get = (key: string): string => fields[key] ?? '';
  switch (type) {
    case 'mount': {
      const source = get('source').trim();
      const target = get('target').trim();
      if (!isAbsolutePath(source) || !isAbsolutePath(target)) return { error: 'El origen y el destino del montaje deben ser rutas absolutas, sin segmentos «.» ni «..».' };
      return { extension: { type, source, target, mode: get('mode') === 'rw' ? 'rw' : 'ro' } };
    }
    case 'network': {
      const name = get('name').trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) return { error: 'Indica el nombre de la red Docker (letras, números, «_», «.» o «-»).' };
      return { extension: { type, name } };
    }
    case 'resources': {
      const pidsText = get('pids').trim();
      const pids = pidsText ? Number(pidsText) : undefined;
      if (pids !== undefined && (!Number.isSafeInteger(pids) || pids < 1 || pids > 4096)) return { error: 'Los procesos deben ser un entero entre 1 y 4096.' };
      const cpusText = get('cpus').trim();
      const cpus = cpusText ? Number(cpusText) : undefined;
      if (cpus !== undefined && (!Number.isFinite(cpus) || cpus <= 0)) return { error: 'La CPU debe ser un número mayor que cero (p. ej. 1.5).' };
      const memory = get('memory').trim();
      if (memory && !/^[1-9][0-9]*(?:[bkmg])?$/i.test(memory)) return { error: 'La memoria debe tener la forma 512m o 2g.' };
      if (!memory && cpus === undefined && pids === undefined) return { error: 'Indica al menos memoria, CPU o procesos.' };
      return { extension: { type, ...(memory ? { memory } : {}), ...(cpus !== undefined ? { cpus } : {}), ...(pids !== undefined ? { pids } : {}) } };
    }
    case 'gpu': return { extension: { type } };
    case 'ssh': {
      const hosts = linesToList(get('hosts'));
      if (!hosts.length || hosts.some((host) => !SSH_HOST.test(host)) || new Set(hosts).size !== hosts.length) {
        return { error: 'Cada destino SSH debe tener la forma usuario@host o usuario@host:puerto, sin repetir, uno por línea.' };
      }
      return { extension: { type, hosts } };
    }
    case 'docker': return { extension: { type, access: get('access') === 'control' ? 'control' : 'read' } };
    case 'browser': {
      if (get('mode') === 'ssh_tunnel') {
        const port = Number(get('port').trim());
        const host = get('host').trim();
        if (!host || !Number.isSafeInteger(port) || port < 1 || port > 65535) return { error: 'El túnel necesita un host y un puerto válido (1-65535).' };
        return { extension: { type, mode: 'ssh_tunnel', host, port } };
      }
      return { extension: { type, mode: 'sidecar' } };
    }
    case 'mcp': {
      const name = get('name').trim();
      const command = get('command').trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name) || !command || /\s/.test(command)) return { error: 'El servidor MCP necesita un nombre válido y un comando sin espacios.' };
      const env = linesToList(get('env'));
      if (env.some((item) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(item))) return { error: 'En env solo van nombres de variables, nunca valores.' };
      return { extension: { type, name, command, args: linesOnlyList(get('args')), env } };
    }
    case 'tools': {
      const packages = linesToList(get('packages'));
      if (!packages.length || packages.some((pkg) => !FIXED_PACKAGE.test(pkg))) return { error: 'Cada paquete debe ser npm:<paquete>@<versión exacta> o pip:<paquete>==<versión>, uno por línea.' };
      return { extension: { type, packages } };
    }
    case 'full_control': return { extension: { type } };
    case 'model_fallback': {
      const agent = get('agent').trim();
      const model = get('model').trim();
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(agent) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,111}$/.test(model)) {
        return { error: 'Indica el alias del otro agente del par y el modelo Muse (p. ej. muse-spark-1.3).' };
      }
      return { extension: { type, agent, model } };
    }
  }
}
