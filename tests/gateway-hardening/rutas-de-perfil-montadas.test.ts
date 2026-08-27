import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabasePool } from '@cauce/store';
import { buildGateway } from '../../services/gateway/src/index.js';
import type {
  AgentFactsProbe, GovernanceBatchWrite,
} from '../../services/gateway/src/console/agent-documents.routes.js';
import { FixedAuthProvider, fakePool, fakeRepository, grants, noDeliveryWakes, roles, testPrincipal } from './helpers.js';

/**
 * Verifica que las rutas de perfiles y documentos de agentes estén montadas
 * y registradas en el gateway, respondiendo desde sus propios manejadores.
 */

const apps: Array<Awaited<ReturnType<typeof buildGateway>>> = [];
const ORIGIN = 'http://localhost';

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

async function gatewayDeOperador() {
  const app = await buildGateway({
    pool: fakePool(),
    repository: fakeRepository(),
    authProvider: new FixedAuthProvider(testPrincipal({
      roles: roles('operator'),
      permissions: grants('route', 'read', 'control')
    })),
    deliveryWakeSubscriber: noDeliveryWakes,
    outboxPollMs: 60_000
  });
  apps.push(app);
  return app;
}

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

interface ProfileState {
  purpose: string | null;
  role_summary: string | null;
  human_brief: string | null;
  responsibilities: string[];
  restrictions: string[];
  tools: string[];
  operating_rules: string[];
  revision: number;
  applied_revision: number | null;
}

function poolDePerfil(state: ProfileState): DatabasePool {
  const row = () => ({
    tenant_id: 'Steven', alias: 'zeus', purpose: state.purpose,
    role_summary: state.role_summary, human_brief: state.human_brief,
    responsibilities: [...state.responsibilities], restrictions: [...state.restrictions],
    tools: [...state.tools], operating_rules: [...state.operating_rules],
    revision: String(state.revision),
    applied_revision: state.applied_revision === null ? null : String(state.applied_revision),
  });
  const query = async (sql: string, params: readonly unknown[] = []) => {
    const normalized = sql.replace(/\s+/gu, ' ').trim();
    if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK'
      || normalized.startsWith('INSERT INTO audit_events')) {
      return { rows: [], rowCount: normalized === 'BEGIN' ? null : 1 };
    }
    if (normalized.startsWith('SELECT tenant_id,alias,purpose')) {
      return { rows: [row()], rowCount: 1 };
    }
    if (normalized.startsWith('SELECT enabled FROM agents')) {
      return { rows: [{ enabled: true }], rowCount: 1 };
    }
    if (normalized.startsWith('UPDATE agent_profiles SET applied_revision=')) {
      state.applied_revision = Number(params[2]);
      return { rows: [row()], rowCount: 1 };
    }
    if (normalized.startsWith('UPDATE agent_profiles SET purpose=')) {
      const siguiente = {
        purpose: params[2] as string | null,
        role_summary: params[3] as string | null,
        human_brief: params[4] as string | null,
        responsibilities: params[5] as string[],
        restrictions: params[6] as string[],
        tools: params[7] as string[],
        operating_rules: params[8] as string[],
      };
      const cambio = Object.entries(siguiente).some(([key, value]) => (
        JSON.stringify(state[key as keyof typeof siguiente]) !== JSON.stringify(value)
      ));
      Object.assign(state, siguiente);
      if (cambio) state.revision += 1;
      return { rows: [row()], rowCount: 1 };
    }
    if (normalized.includes('AS ruta') && normalized.includes('AS notify_rol')) {
      return { rows: [{ ruta: false, lectura: false, control: false, notify_rol: false }], rowCount: 1 };
    }
    if (normalized.includes('FROM agent_account_bindings')) return { rows: [], rowCount: 0 };
    if (normalized.includes('FROM agents agent') && normalized.includes('harness_definitions')) {
      return { rows: [{
        harness_id: 'claude', home_directory: '/home/dev', container_name: 'ws-zeus',
        capabilities: [], enabled: true,
      }], rowCount: 1 };
    }
    if (normalized.includes('FROM egress_destinations')) {
      return { rows: [{ total: '0' }], rowCount: 1 };
    }
    if (normalized.includes('AS alias')) return { rows: [], rowCount: 0 };
    return { rows: [{ '?column?': 1 }], rowCount: 1 };
  };
  const client = {
    query,
    on: () => client,
    off: () => client,
    release: () => undefined,
  };
  return {
    query,
    connect: async () => client,
  } as unknown as DatabasePool;
}

async function gatewayCanonico(supersedeAfterBatch = false) {
  const state: ProfileState = {
    purpose: 'Antes.', role_summary: null, human_brief: null,
    responsibilities: [], restrictions: [], tools: [], operating_rules: [],
    revision: 1, applied_revision: 1,
  };
  const repository = {
    ...fakeRepository(),
    authorizeAgentTarget: async () => ({
      tenant_id: 'Steven', alias: 'zeus', enabled: true,
      harness_id: 'claude', home_directory: '/home/dev',
    }),
    recordProfileRuntimeExpectation: async () => undefined,
    readProfileRuntimeAdoption: async (
      _tenantId: string,
      _alias: string,
      contract: {
        revision: number;
        generation: string;
        documents: readonly { name: string; path: string; sha: string }[];
      },
    ) => ({
      evidence: 'adapter_delivery' as const,
      ...contract,
      documents: [...contract.documents],
      adopted_at: '2026-08-26T18:00:00.000Z',
    }),
  };
  const app = await buildGateway({
    pool: poolDePerfil(state),
    repository,
    authProvider: new FixedAuthProvider(testPrincipal({
      tenant_id: 'Steven', alias: 'kant', roles: roles('operator'),
      permissions: grants('route', 'read', 'control'),
    })),
    deliveryWakeSubscriber: noDeliveryWakes,
    outboxPollMs: 60_000,
  });
  apps.push(app);

  let disco = '# Manual humano\n';
  const batches: GovernanceBatchWrite[][] = [];
  const probe: AgentFactsProbe = {
    factsFor: async () => ({
      source: 'measured',
      facts: {
        harness: 'claude', home: '/home/dev',
        generation: 'generation-profile-route-test', containerId: 'ws-zeus-test',
      },
    }),
    readGovernanceDocument: async () => ({
      text: disco, bytes: Buffer.byteLength(disco), truncated: false,
      modified_at: '2026-08-25T18:00:00.000Z', sha: sha(disco),
    }),
    listMemoryDirectory: async () => ({
      root: '/none', total: 0, observed_at_least: 0, truncated: false, entries: [],
    }),
    writeGovernanceBatch: async (writes) => {
      batches.push([...writes]);
      const entry = writes[0];
      if (writes.length !== 1 || entry?.mode !== 'write') {
        return { error: 'unknown', reason: 'el test esperaba un único CLAUDE.md' };
      }
      disco = entry.content;
      if (supersedeAfterBatch) {
        state.purpose = 'Desired de otro editor.';
        state.revision = 3;
      }
      return [{
        path: entry.path, operation: 'replace', sha: sha(entry.content),
        bytes: Buffer.byteLength(entry.content),
      }];
    },
  };
  app.sondaDeDocumentos?.instalar(probe);
  return { app, state, batches, disco: () => disco };
}

/** Las rutas del perfil y de los documentos, nombradas a mano y sin extractor de por medio. */
const RUTAS = [
  { method: 'GET' as const, url: '/v3/console/agents/zeus/perfil' },
  { method: 'GET' as const, url: '/v3/console/agents/zeus/documents' },
  { method: 'GET' as const, url: '/v3/console/agents/zeus/documents/directive/content' },
  { method: 'PUT' as const, url: '/v3/console/agents/zeus/documents/directive/content' }
];

describe('las rutas del perfil y de los documentos están MONTADAS en el gateway', () => {
  for (const ruta of RUTAS) {
    it(`${ruta.method} ${ruta.url} no contesta 404`, async () => {
      const app = await gatewayDeOperador();
      const res = await app.inject({
        method: ruta.method,
        url: ruta.url,
        ...(ruta.method === 'PUT' ? { payload: { content: 'hola' } } : {})
      });
      /*
       * Se exige que el 404, si lo hay, provenga del manejador y no del enrutador Fastify.
       * Fastify contesta a una ruta inexistente con `{"message":"Route ... not found"}`;
       * el manejador devuelve `{"error":"not_found", ...}`.
       */
      const cuerpo: unknown = res.json();
      const message = cuerpo !== null && typeof cuerpo === 'object' && 'message' in cuerpo
        && typeof cuerpo.message === 'string' ? cuerpo.message : '';
      const error = cuerpo !== null && typeof cuerpo === 'object' && 'error' in cuerpo
        && typeof cuerpo.error === 'string' ? cuerpo.error : undefined;
      expect(message).not.toContain('not found');
      expect(res.statusCode === 404 ? error : 'ruta-viva')
        .not.toBeUndefined();
    });
  }

  it('CONTROL NEGATIVO: una ruta que NADIE registró sí contesta 404', async () => {
    /*
     * Sin esto la prueba de arriba podría estar verde por un `setNotFoundHandler` que devuelve
     * 500, o por un prefijo que traga todo. Se exige que el 404 siga siendo alcanzable.
     */
    const app = await gatewayDeOperador();
    const res = await app.inject({ method: 'GET', url: '/v3/console/agents/zeus/inventado-que-no-existe' });
    expect(res.statusCode).toBe(404);
  });

  it('sin plano de terminal, el contenido dice que NO HAY CANAL en vez de lanzar un 500', async () => {
    /*
     * Este gateway se monta sin `registerTerminalControlPlane`, así que nadie instaló la sonda que
     * lee el disco del contenedor. La degradada contesta «no hay canal hasta el disco» —503— en
     * lugar de lanzar: un throw se vería como «internal error» y el operador no podría accionarlo.
     *
     * Como además no hay hechos medidos, el manejador corta antes con el 409. Lo que se afirma acá
     * es que en NINGUNA de las dos ausencias sale un 500.
     */
    const app = await gatewayDeOperador();
    const res = await app.inject({ method: 'GET', url: '/v3/console/agents/zeus/documents/directive/content' });
    expect(res.statusCode).toBeLessThan(500);
  });

  it('el contenido de un documento contesta «no medido» y NO 404, que dicen cosas distintas', async () => {
    /*
     * Comprueba que la falta de hechos medidos devuelva 409 (no medido)
     * en lugar de un 404 de ruta no encontrada.
     */
    const app = await gatewayDeOperador();
    const res = await app.inject({ method: 'GET', url: '/v3/console/agents/zeus/documents/directive/content' });
    expect(res.statusCode).toBe(409);
    const cuerpo: unknown = res.json();
    expect(cuerpo).toMatchObject({ error: 'no_medido' });
    const message = cuerpo !== null && typeof cuerpo === 'object' && 'message' in cuerpo
      && typeof cuerpo.message === 'string' ? cuerpo.message : '';
    expect(message).toContain('no se ha mirado');
  });

  it('un `kind` inventado se rechaza por 400 y no por 404', async () => {
    // 404 sobre un kind inválido sería indistinguible de «la ruta no existe», que es la confusión
    // que esta suite entera viene a cerrar.
    const app = await gatewayDeOperador();
    const res = await app.inject({ method: 'GET', url: '/v3/console/agents/zeus/documents/credenciales/content' });
    expect(res.statusCode).toBe(400);
  });

  it('el PUT canónico montado sólo responde applied tras el ACK batch exacto', async () => {
    const { app, state, batches, disco } = await gatewayCanonico();
    const res = await app.inject({
      method: 'PUT',
      url: '/v3/console/tenants/Steven/agents/zeus/perfil',
      headers: { origin: ORIGIN },
      payload: {
        expected_revision: 1,
        profile: { purpose: 'Después.', role_summary: 'Médico de la flota.' },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true, state: 'applied', tenant_id: 'Steven', alias: 'zeus',
      revision: 2, applied_revision: 2,
      acknowledgements: [{
        name: 'CLAUDE.md', path: '/home/dev/.claude/CLAUDE.md', state: 'written',
        sha: sha(disco()), bytes: Buffer.byteLength(disco()),
      }],
    });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0]?.[0]).toMatchObject({
      mode: 'write', path: '/home/dev/.claude/CLAUDE.md',
      precondition: { state: 'present', sha256: sha('# Manual humano\n') },
    });
    expect(state).toMatchObject({ revision: 2, applied_revision: 2, purpose: 'Después.' });
  });

  it('si nace otro desired después del ACK, el PUT montado responde 409 y GET queda pending', async () => {
    const { app, state } = await gatewayCanonico(true);
    const res = await app.inject({
      method: 'PUT',
      url: '/v3/console/tenants/Steven/agents/zeus/perfil',
      headers: { origin: ORIGIN },
      payload: { expected_revision: 1, profile: { purpose: 'Revisión dos.' } },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: 'profile_superseded_after_runtime_ack', state: 'pending',
      revision: 3, applied_revision: 2,
    });
    expect(state).toMatchObject({ revision: 3, applied_revision: 2 });

    const get = await app.inject({
      method: 'GET', url: '/v3/console/tenants/Steven/agents/zeus/perfil',
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({
      revision: 3, applied_revision: 2, runtime_state: 'pending',
    });
  });
});
