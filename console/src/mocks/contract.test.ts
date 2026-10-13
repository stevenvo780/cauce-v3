import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FleetCapabilitySchema, FleetOperationSchema, QuotaEnvironmentProviderSchema } from '@cauce/protocol';
import { companyInventory, consolePreferences, officeLayout, versionedContext } from '../api/client/v4-responses';
import { quotaAccounts, quotaEnvironments } from '../api/client/quota-responses';
import { agentQuotaClient } from '../features/accounts/agent-quota-client';
import type { RequestFn } from '../api/client/system-client';
import { handlers } from './handlers';
import { chatDemoHandlers } from './chat-demo';
import { terminalDemoHandlers } from './terminal-demo';
import { mcpVisitorsDemoHandlers } from './mcp-visitors-demo';

interface RutaMock { metodo: string; ruta: string }

function normaliza(ruta: string): string {
  return ruta.replace(/:[A-Za-z_][A-Za-z0-9_]*/gu, ':*');
}

function rutasDe(lista: readonly unknown[]): RutaMock[] {
  return lista.map((handler) => {
    const info = (handler as { info?: { method?: unknown; path?: unknown } }).info;
    if (typeof info?.method !== 'string' || typeof info.path !== 'string') {
      throw new Error('un handler MSW no expone info.method/info.path; el contrato no puede enumerar sus rutas');
    }
    const ruta = info.path.startsWith('http') ? new URL(info.path).pathname : info.path.replace(/^\*/u, '');
    return { metodo: info.method.toUpperCase(), ruta };
  });
}

/** Goes up from this file to the repo root, looking for the gateway route matrix. */
function rutaDeLaMatriz(): string {
  let directorio = dirname(fileURLToPath(import.meta.url));
  for (let salto = 0; salto < 10; salto += 1) {
    const candidato = join(directorio, 'services', 'gateway', 'src', 'security', 'route-isolation-matrix.ts');
    try {
      readFileSync(candidato, 'utf8');
      return candidato;
    } catch {
      directorio = dirname(directorio);
    }
  }
  throw new Error('No se encontró services/gateway/src/security/route-isolation-matrix.ts desde la consola');
}

function rutasDelGateway(fuente: string): Set<string> {
  const rutas = new Set<string>();
  for (const match of fuente.matchAll(/(?:publicRoute|actor|scoped|host)\(\s*'(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)',\s*'([^']+)'/gu)) {
    rutas.add(`${match[1]} ${normaliza(match[2])}`);
  }
  for (const match of fuente.matchAll(/method:\s*'(GET|POST|PUT|PATCH|DELETE)',\s*url:\s*'([^']+)'/gu)) {
    rutas.add(`${match[1]} ${normaliza(match[2])}`);
  }
  return rutas;
}

const TODOS_LOS_HANDLERS = [...handlers, ...chatDemoHandlers, ...terminalDemoHandlers, ...mcpVisitorsDemoHandlers];

describe('contrato entre los handlers MSW y el gateway', () => {
  it('toda ruta mock existe en la matriz de rutas reales del gateway', () => {
    const gateway = rutasDelGateway(readFileSync(rutaDeLaMatriz(), 'utf8'));
    expect(gateway.size, 'el extractor de la matriz debe seguir reconociendo sus entradas').toBeGreaterThan(150);
    const mocks = [...new Map(rutasDe(TODOS_LOS_HANDLERS).map((ruta) => [`${ruta.metodo} ${normaliza(ruta.ruta)}`, ruta])).values()];
    expect(mocks.length).toBeGreaterThan(40);
    const inexistentes = mocks
      .filter((ruta) => !gateway.has(`${ruta.metodo} ${normaliza(ruta.ruta)}`))
      .map((ruta) => `${ruta.metodo} ${ruta.ruta}`);
    expect(inexistentes, 'rutas MSW sin ruta real en el gateway: elimínalas o documenta por qué son demo').toEqual([]);
  });

  it.each([
    ['/v3/console/companies', companyInventory],
    ['/v3/console/preferences', consolePreferences],
    ['/v3/console/office/layout', officeLayout],
    ['/v3/console/quota-accounts', quotaAccounts],
    ['/v3/console/quota-environments', quotaEnvironments],
    ['/v3/console/context/agents/Steven/kant', versionedContext],
  ] as const)('el cuerpo V4 de GET %s pasa el verificador del cliente', async (ruta, verifica) => {
    const respuesta = await fetch(`http://localhost${ruta}`);
    expect(respuesta.ok).toBe(true);
    const cuerpo: unknown = await respuesta.json();
    expect(() => verifica(cuerpo)).not.toThrow();
  });

  it('la cuota mock pasa el cliente de lectura usado en producción', async () => {
    const request: RequestFn = async <T,>(ruta: string, init?: RequestInit) => {
      const response = await fetch(`http://localhost${ruta}`, init);
      expect(response.ok).toBe(true);
      return await response.json() as T;
    };
    await expect(agentQuotaClient(request).getAgentQuota('Steven', 'kant')).resolves.toMatchObject({
      tenant_id: 'Steven', alias: 'kant', reader_available: true, reason: null,
    });
  });

  it('los cuerpos de flota de los handlers pasan los esquemas zod del protocolo', async () => {
    const capacidad = await (await fetch('http://localhost/v3/console/fleet/capability')).json() as unknown;
    expect(() => FleetCapabilitySchema.parse(capacidad)).not.toThrow();
    const recientes = await (await fetch('http://localhost/v3/console/fleet/operations/recent')).json() as { operations: unknown[] };
    expect(Array.isArray(recientes.operations)).toBe(true);
    for (const operacion of recientes.operations) {
      expect(() => FleetOperationSchema.parse(operacion)).not.toThrow();
    }
  });

  it('los proveedores V4 de ejemplo pertenecen al enum zod del protocolo', async () => {
    const entornos = await (await fetch('http://localhost/v3/console/quota-environments')).json() as {
      capabilities: { providers: unknown[] };
    };
    for (const proveedor of entornos.capabilities.providers) {
      expect(() => QuotaEnvironmentProviderSchema.parse(proveedor)).not.toThrow();
    }
  });

  it('el historial de contexto y las invitaciones V4 traen la forma que el cliente lee', async () => {
    const historial = await (await fetch('http://localhost/v3/console/context/agents/Steven/kant/history')).json() as {
      entries: unknown; next_cursor: unknown;
    };
    expect(Array.isArray(historial.entries)).toBe(true);
    expect(historial.next_cursor).toBeNull();
    const invitaciones = await (await fetch('http://localhost/v3/console/fleet/hosts/enrollments')).json() as {
      enrollments: unknown; setup_signer_fingerprint: unknown;
    };
    expect(Array.isArray(invitaciones.enrollments)).toBe(true);
    expect(invitaciones.setup_signer_fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });
});
