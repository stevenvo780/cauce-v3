import { delay, http, HttpResponse } from 'msw';
import {
  adapters, agentAccountBindings, audit, configAclEdges, configMemberships, configRooms,
  configTenants, mockActivity, mockMessages, mockQueues, mockChain, mockQuotas,
  mockStatus, originRelays, providerAccounts, registryAgents, roleBriefHistoryKant, routingCeiling,
  topology,
} from './data';

export const handlers = [
  http.get('*/v3/auth/session', () => HttpResponse.json({
    authenticated: true,
    subject: 'Steven:kant',
    roles: ['operator'],
    permissions: ['route', 'read', 'control'],
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    csrf_token: 'mock-csrf-token',
  })),
  http.post('*/v3/auth/logout', () => new HttpResponse(null, { status: 204 })),
  http.get('*/v3/status', async () => {
    await delay(120);
    return HttpResponse.json(mockStatus());
  }),
  http.get('*/v3/console/access', () => HttpResponse.json({
    subject: 'Steven:kant', roles: ['operator'],
    permissions: ['message.publish', 'delivery.replay', 'delivery.cancel', 'job.create', 'config.write', 'config.rollback', 'ultimate-terminal.connect'],
  })),
  http.get('*/v3/console/topology', () => HttpResponse.json(topology)),
  http.get('*/v3/console/activity', () => HttpResponse.json(mockActivity())),
  http.get('*/v3/console/quotas', () => HttpResponse.json(mockQuotas())),
  // La cadena por trace: el endpoint existía en el gateway y no tenía un solo consumidor.
  http.get('*/v3/console/chains/:traceId', ({ params }) => HttpResponse.json(mockChain(String(params.traceId)))),
  http.get('*/v3/console/messages', () => HttpResponse.json(mockMessages())),
  http.post('*/v3/console/messages', async ({ request }) => {
    const input = await request.json() as { body?: { text?: string } };
    if (!input.body?.text) return HttpResponse.json({ error: 'invalid_request', message: 'text is required' }, { status: 422 });
    return HttpResponse.json({ message_id: crypto.randomUUID(), delivery_ids: [crypto.randomUUID()], duplicate: false, request_id: crypto.randomUUID(), trace_id: `trace-${crypto.randomUUID()}` }, { status: 202 });
  }),
  http.get('*/v3/console/queues', () => HttpResponse.json(mockQueues())),
  http.post('*/v3/console/deliveries/:deliveryId/replay', ({ params }) => HttpResponse.json({ delivery_id: params.deliveryId, state: 'pending', replayed: true }, { status: 202 })),
  http.post('*/v3/console/deliveries/:deliveryId/cancel', ({ params }) => HttpResponse.json({ delivery_id: params.deliveryId, state: 'dead', cancelled: true, cancelled_from_state: 'started', parent_notice: 'returned', origin_relayed: true, replayable: true }, { status: 200 })),
  http.get('*/v3/console/adapters', () => HttpResponse.json(adapters)),
  http.get('*/v3/console/audit', () => HttpResponse.json(audit)),
  http.get('*/v3/console/origin-relays', () => HttpResponse.json(originRelays)),
  http.get('*/v3/console/config', () => HttpResponse.json({
    revision: 1, observed_at: new Date().toISOString(), tenants: configTenants, rooms: configRooms,
    memberships: configMemberships, acl_edges: configAclEdges, harness_definitions: adapters.items,
    role_policies: [
      { role: 'operator', allow_route: true, allow_read: true, allow_control: true, allow_notify: true },
      { role: 'agent', allow_route: true, allow_read: true, allow_control: false, allow_notify: false },
      { role: 'observer', allow_route: false, allow_read: true, allow_control: false, allow_notify: false }
    ],
    chain_policies: [{ id: 'default', progress_relay_enabled: true, progress_relay_max_events: 8, cycle_cut_enabled: true }],
    egress_destinations: [{
      tenant_id: 'Miguel', alias: 'janus', handle: 'steven_dm', adapter: 'telegram', channel: 'telegram',
      conversation_kind: 'dm', allow_kinds: ['task_complete'], require_prior_contact: true, enabled: true
    }],
    agents: registryAgents, provider_accounts: providerAccounts,
    alias_routing_ceiling: routingCeiling, agent_account_bindings: agentAccountBindings,
    revisions: []
  })),
  http.post('*/v3/console/config/changes', async ({ request }) => {
    const input = await request.json() as { dry_run?: boolean; mutation?: Record<string, unknown> };
    return HttpResponse.json({ applied: input.dry_run !== true, dry_run: input.dry_run === true, revision: input.dry_run ? 1 : 2, mutation: input.mutation, summary: 'mock configuration validation' }, { status: input.dry_run ? 200 : 201 });
  }),
  http.post('*/v3/console/config/revisions/:revisionId/rollback', ({ params }) => HttpResponse.json({ applied: true, dry_run: false, revision: Number(params.revisionId) + 1 }, { status: 201 })),
  http.get('*/v3/console/observability', () => HttpResponse.json({
    observed_at: new Date().toISOString(), status: mockStatus(), queues: mockQueues(),
    origin_relays: originRelays
  })),
  /*
   * Las capas 2 y 3 de la directiva. El gateway TODAVÍA NO sirve este endpoint: acá se devuelve
   * un 404 a propósito, que es lo que la consola se va a encontrar en producción hoy. Así el
   * modo mock enseña lo que Steven va a ver de verdad —«no se pudo mirar»— y no una pantalla
   * llena de ficheros inventados que en producción no existen.
   *
   * Cuando el gateway lo publique, se cambia por el JSON real y la pantalla se llena sola: las
   * pruebas de `DirectivaTab.test.tsx` ya cubren las dos ramas.
   */
  // ------------------------------------------------------------------------------------------
  // LOS FICHEROS QUE GOBIERNAN A UN AGENTE
  //
  // El fixture enseña los DOS estados a propósito, porque los dos son reales y la pantalla tiene
  // que distinguirlos: `kant` sirve su CLAUDE.md; el resto de los alias contesta 503, que es lo
  // que hace hoy producción entera —el gateway todavía no tiene camino hasta el disco de un
  // agente—. Un fixture que sirviera contenido para todos escondería justo el caso que hay que
  // mirar antes de dar esto por bueno.
  // ------------------------------------------------------------------------------------------
  http.get('*/v3/console/agents/:alias/documents', ({ params }) => HttpResponse.json({
    tenant_id: 'Steven',
    alias: String(params.alias),
    facts_source: 'measured',
    harness: 'claude',
    home: '/home/stev',
    items: [
      {
        kind: 'directive',
        label: 'CLAUDE.md (manual del sitio)',
        path: '/home/stev/.claude/CLAUDE.md',
        format: 'markdown',
        editable: true,
      },
      {
        kind: 'tools',
        label: 'Herramientas y permisos (settings.json)',
        path: '/home/stev/.claude/settings.json',
        format: 'json',
        editable: true,
        warning: 'Este fichero puede contener `hooks`: órdenes que el arnés ejecuta solo. Cambiarlo equivale a ejecutar código dentro del contenedor del agente.',
      },
      {
        kind: 'prompts',
        label: 'Subagentes (~/.claude/agents)',
        path: '/home/stev/.claude/agents',
        format: 'markdown',
        editable: false,
        reason: 'Es un directorio; v1 sólo lista lo que hay, no edita fichero a fichero.',
      },
      {
        kind: 'mcp',
        label: 'Servidores MCP',
        path: '/home/stev/.claude.json',
        format: 'json',
        editable: false,
        reason: 'Los MCP viven en `.claude.json`, junto al OAuth de la cuenta y al historial de todos los proyectos. No se sirve: habría que proyectar sólo `mcpServers`.',
      },
    ],
  })),
  http.get('*/v3/console/agents/:alias/documents/:kind/content', ({ params }) => {
    if (params.alias !== 'kant') {
      return HttpResponse.json({
        error: 'no_channel',
        message: 'La consola no tiene todavía ningún camino hasta el disco de este agente. El gateway no monta el socket de docker, el relay de terminal sólo llama al gateway y nunca al revés, y kant y salva ni siquiera corren en la misma máquina.',
      }, { status: 503 });
    }
    const esDirectiva = params.kind === 'directive';
    const contenido = esDirectiva
      ? '# Manual del sitio — kant\n\nEste fichero dice CÓMO SE TRABAJA AQUÍ: rutas, comandos y\nconvenciones. No repite quién sos ni qué podés decidir: eso es el rol declarado, y\nescribirlo dos veces es como se llega a que nadie sepa cuál manda.\n'
      : '{\n  "permissions": {\n    "allow": ["Bash(git status)"]\n  }\n}\n';
    return HttpResponse.json({
      tenant_id: 'Steven', alias: 'kant', kind: params.kind,
      path: esDirectiva ? '/home/stev/.claude/CLAUDE.md' : '/home/stev/.claude/settings.json',
      format: esDirectiva ? 'markdown' : 'json',
      exists: true, content: contenido, sha: 'sha-de-lo-servido',
      bytes: contenido.length, editable: true, projected: false,
    });
  }),
  http.put('*/v3/console/agents/:alias/documents/:kind/content', async ({ request }) => {
    const cuerpo = await request.json() as { content?: string };
    return HttpResponse.json({
      ok: true, path: '/home/stev/.claude/CLAUDE.md',
      sha: 'sha-nueva', bytes: (cuerpo.content ?? '').length,
    });
  }),
  /*
   * LAS TRES CAPAS DE DIRECTIVA — y los TRES estados que la pantalla tiene que distinguir.
   *
   * El estado que hoy da PRODUCCIÓN es el tercero, y en los 14 alias: comprobado uno por uno el
   * 2026-08-24, `GET /v3/console/agents/:tenant/:alias/directive` devuelve 404 porque el gateway
   * todavía no publica la ruta (el backend existe en `gateway/editor-ficheros-agente-20260823`,
   * frenado por una auditoría de seguridad). Por eso es el estado por defecto de este fixture.
   *
   * Los otros dos se sirven a propósito para poder MIRARLOS antes de que el backend salga, porque
   * el día que salga van a convivir en la misma flota y confundirlos es el defecto que esta
   * pantalla existe para no cometer:
   *   · `kant` = el caso janus: DOS `CLAUDE.md` a la vez, con la autonomía repetida en el manual.
   *   · `midas` = el caso gaia: el servidor MIRÓ y no hay ningún manual. Eso sí se puede afirmar.
   *   · el resto = NO SE MIRÓ. Que no es «no tiene», y tiene que verse distinto.
   */
  http.get('*/v3/console/agents/:tenantId/:alias/directive', ({ params }) => {
    if (params.alias === 'kant') {
      return HttpResponse.json({
        observed_at: new Date().toISOString(),
        container_id: 'claw-kant',
        files: [
          {
            path: '~/.claude/CLAUDE.md', scope: 'user', bytes: 2079,
            modified_at: new Date(Date.now() - 86_400_000).toISOString(),
            text: '# Flota\n\nAUTONOMIA: decidí y actuá vos. Pedí permiso SOLO si hay dinero de por medio.\n\nEl repo vive en /workspace/cauce-v3 y se prueba con `pnpm test`.\n',
          },
          {
            path: '/workspace/CLAUDE.md', scope: 'workspace', bytes: 512,
            modified_at: new Date(Date.now() - 3_600_000).toISOString(),
            text: '# Cauce V3\n\nLa consola se construye con `pnpm --filter @cauce/console build`.\n',
          },
        ],
        memory: {
          root: '~/.claude/projects', total: 267, truncated: true,
          entries: [
            { path: 'MEMORY.md', bytes: 25_412, modified_at: new Date(Date.now() - 7_200_000).toISOString() },
            { path: 'compilar-no-es-correr.md', bytes: 1_204, modified_at: new Date(Date.now() - 172_800_000).toISOString() },
          ],
        },
      });
    }
    if (params.alias === 'midas') {
      return HttpResponse.json({
        observed_at: new Date().toISOString(),
        container_id: 'ws-midas',
        files: [],
        memory: { root: '~/.openclaw/memory', total: 0, entries: [] },
      });
    }
    return HttpResponse.json(
      { error: 'not_found', message: 'agent directive files are not published by this gateway yet' },
      { status: 404 },
    );
  }),
  /*
   * El diario del rol. A diferencia de las capas 2 y 3, éste SÍ está desplegado: comprobado el
   * 2026-08-23 contra producción, responde 200 con las entradas, y 200 con `entries: []` para un
   * alias que nunca cambió de rol. Las dos respuestas dicen cosas distintas y las dos son ciertas.
   *
   * Sólo kant tiene historia acá: el resto devuelve la lista vacía, que es lo que hoy pasa en la
   * flota de verdad —el disparador se instaló el 23 de agosto y sólo llegó a anotar dos cambios—.
   */
  http.get('*/v3/console/role-assignments/:tenantId/:alias/history', ({ params }) => HttpResponse.json({
    observed_at: new Date().toISOString(),
    tenant_id: params.tenantId,
    alias: params.alias,
    entries: params.alias === 'kant' ? roleBriefHistoryKant : [],
  })),
  http.get('*/v3/console/terminal/capability', () => HttpResponse.json({ available: false, reason: 'Backend PTY no instalado en este entorno' })),
  /*
   * Las sesiones de terminal del operador. La consola las lee para poder CERRAR las que quedaron
   * colgadas: sin este manejador cada prueba de la vista escupía «intercepted a request without a
   * matching request handler» y la trampa que este listado destraba quedaba sin cubrir.
   */
  http.get('*/v3/console/terminal/sessions', () => HttpResponse.json({ items: [] })),
];
