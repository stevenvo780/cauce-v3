import { delay, http, HttpResponse } from 'msw';
import {
  adapters, agentAccountBindings, audit, configAclEdges, configMemberships, configRooms,
  configTenants, mockActivity, mockMessages, mockQueues, mockDlq, mockChain, mockQuotas,
  mockStatus, originRelays, providerAccounts, registryAgents, roleBriefHistoryKant, routingCeiling,
  topology,
} from './data';

const preparedIntentByMeaning = new Map<string, string>();

function mockMeaning(input: unknown): string {
  return JSON.stringify(input);
}

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
    permissions: ['message.publish', 'delivery.replay', 'delivery.cancel', 'job.create', 'config.write', 'config.rollback', 'dlq.resolve', 'ultimate-terminal.connect'],
  })),
  http.get('*/v3/console/topology', () => HttpResponse.json(topology)),
  http.get('*/v3/console/activity', () => HttpResponse.json(mockActivity())),
  http.get('*/v3/console/quotas', () => HttpResponse.json(mockQuotas())),
  // The per-trace chain endpoint existed in the gateway and did not have a single consumer.
  http.get('*/v3/console/chains/:traceId', ({ params }) => HttpResponse.json(mockChain(String(params.traceId)))),
  http.get('*/v3/console/messages', () => HttpResponse.json(mockMessages())),
  http.post('*/v3/console/publish-intents', async ({ request }) => {
    const input = await request.json();
    const meaning = mockMeaning(input);
    let key = preparedIntentByMeaning.get(meaning);
    if (!key) {
      key = `console-intent:${crypto.randomUUID()}`;
      preparedIntentByMeaning.set(meaning, key);
    }
    return HttpResponse.json({ version: 1, state: 'prepared', idempotency_key: key, receipt: null });
  }),
  http.post('*/v3/console/publish-intents/confirm', async ({ request }) => {
    const input = await request.json() as {
      idempotency_key?: unknown; message_id?: unknown; causal_hash?: unknown;
    };
    if (typeof input.idempotency_key !== 'string'
        || typeof input.message_id !== 'string'
        || typeof input.causal_hash !== 'string') {
      return HttpResponse.json({ error: 'invalid_request' }, { status: 422 });
    }
    for (const [meaning, key] of preparedIntentByMeaning) {
      if (key === input.idempotency_key) preparedIntentByMeaning.delete(meaning);
    }
    return HttpResponse.json({ version: 1, confirmed: true, ...input });
  }),
  http.post('*/v3/console/messages', async ({ request }) => {
    const input = await request.json() as { body?: { text?: string }; idempotency_key?: unknown };
    if (!input.body?.text) return HttpResponse.json({ error: 'invalid_request', message: 'text is required' }, { status: 422 });
    return HttpResponse.json({
      message_id: crypto.randomUUID(),
      delivery_ids: [crypto.randomUUID()],
      duplicate: false,
      request_id: crypto.randomUUID(),
      trace_id: `trace-${crypto.randomUUID()}`,
      idempotency_key: input.idempotency_key,
      tenant_id: 'Steven',
      actor_alias: 'kant',
      request_hash: 'a'.repeat(64),
      causal_hash: 'b'.repeat(64),
    }, { status: 202 });
  }),
  http.get('*/v3/console/queues', () => HttpResponse.json(mockQueues())),
  http.get('*/v3/console/dlq', () => HttpResponse.json(mockDlq())),
  http.post('*/v3/console/dlq/:target/:id/resolve-without-replay', async ({ params, request }) => {
    const body = await request.json() as Record<string, unknown>;
    if (body.possible_no_delivery_acknowledged !== true) {
      return HttpResponse.json({ error: 'invalid_input', message: 'no-delivery acknowledgement is required' }, { status: 409 });
    }
    return HttpResponse.json({
      schemaVersion: 1, suite: 'cauce-v3-dlq-no-replay-resolution', phase: 'resolved',
      appliedCount: 1, alreadyApplied: false, evidenceSha256: body.evidence_sha256,
      reasonSha256: '0'.repeat(64),
      possibleDuplicateAcknowledged: body.possible_duplicate_acknowledged === true,
      possibleNoDeliveryAcknowledged: true, target: params.target, id: params.id,
    });
  }),
  http.post('*/v3/console/deliveries/:deliveryId/replay', ({ params }) => HttpResponse.json({
    delivery_id: crypto.randomUUID(), replayed_from_delivery_id: params.deliveryId,
    state: 'pending', replayed: true,
  }, { status: 202 })),
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
    chain_policies: [{
      id: 'default', progress_relay_enabled: true, progress_relay_max_events: 8,
      cycle_cut_enabled: true, failure_coalesce_enabled: true, failure_coalesce_window_seconds: 900,
      // The five caps from 019, with the defaults declared by the migration: the simulator must
      // bring back the SAME columns as the server, or the UI is developed against a shape that
      // does not exist in production.
      delegation_caps_enabled: true, max_fanout_per_turn: 6, max_edge_repeats_per_root: 3,
      max_delegations_per_root: 64, human_gate_enabled: true,
    }],
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
    return HttpResponse.json({
      applied: input.dry_run !== true, dry_run: input.dry_run === true,
      revision: input.dry_run ? 1 : 2, mutation: input.mutation,
      inverse_mutation: input.mutation, rolled_back_revision_id: null,
      summary: 'mock configuration validation',
    }, { status: input.dry_run ? 200 : 201 });
  }),
  http.post('*/v3/console/config/revisions/:revisionId/rollback', async ({ params, request }) => {
    const input = await request.json() as { dry_run?: boolean };
    const dryRun = input.dry_run === true;
    const mutation = { resource: 'tenant', action: 'update', id: 'Steven', value: { enabled: true } };
    return HttpResponse.json({
      applied: !dryRun, dry_run: dryRun,
      revision: dryRun ? Number(params.revisionId) : Number(params.revisionId) + 1,
      rolled_back_revision_id: Number(params.revisionId),
      summary: `rollback ${String(params.revisionId)}`, mutation, inverse_mutation: mutation,
    }, { status: dryRun ? 200 : 201 });
  }),
  http.get('*/v3/console/observability', () => HttpResponse.json({
    observed_at: new Date().toISOString(), status: mockStatus(), queues: mockQueues(),
    origin_relays: originRelays
  })),
  http.get('*/v3/console/tenants/:tenantId/agents/:alias/perfil', ({ params }) => {
    const tenantId = String(params.tenantId);
    const alias = String(params.alias);
    const esOpenclaw = alias === 'argos';
    const perfil = {
      purpose: alias === 'zeus'
        ? 'Sos el médico de la flota: diagnosticás y reparás los fallos de Cauce V3 de punta a punta, sin esperar a que un humano te destrabe.'
        : 'Coordinás lo pendiente de la flota y perseguís lo que se quedó a medias.',
      role_summary: alias === 'zeus'
        ? 'Orquestador e infraestructura. Escalás a kant lo que no es tuyo.'
        : 'PMO de la flota.',
      human_brief: 'Steven. Directo, sin rodeos y sin adornos. Si no lo probaste, decí «no lo probé».',
      responsibilities: ['Diagnosticar los fallos de Cauce', 'Desplegar y revertir sin pedir permiso'],
      restrictions: ['NO tocar credenciales, ni proponerlo', 'No mandar secretos por el bus'],
      tools: ['ssh a kratos y agora-storage', 'docker de la flota'],
      operating_rules: ['Comprobá el EFECTO, no el código de salida', 'Si no lo probaste, escribí «no lo probé»'],
    };
    const bloque = (titulo: string, cuerpo: string) => `<!-- CAUCE:PERFIL v1 — generado desde la configuración, no editar dentro de este bloque -->\n## ${titulo}\n\n${cuerpo}\n<!-- CAUCE:FIN-PERFIL -->\n`;
    const ficheros = esOpenclaw
      ? [
        { nombre: 'SOUL.md', politica: 'bloque-gestionado', texto: bloque('Identidad y propósito', perfil.purpose) },
        { nombre: 'IDENTITY.md', politica: 'bloque-gestionado', texto: bloque('Rol', perfil.role_summary) },
        { nombre: 'USER.md', politica: 'bloque-gestionado', texto: bloque('Tu humano y cómo tratarlo', perfil.human_brief) },
        { nombre: 'MEMORY.md', politica: 'solo-si-falta', texto: '' },
        { nombre: 'HEARTBEAT.md', politica: 'solo-si-falta', texto: '' },
        { nombre: 'AGENTS.md', politica: 'bloque-gestionado', texto: bloque('Responsabilidades', perfil.responsibilities.map((r) => `- ${r}`).join('\n')) },
        { nombre: 'TOOLS.md', politica: 'bloque-gestionado', texto: bloque('Herramientas y capacidades', perfil.tools.map((t) => `- ${t}`).join('\n')) },
      ]
      : [
        { nombre: 'CLAUDE.md', politica: 'bloque-gestionado', texto: bloque('Identidad y propósito', perfil.purpose) },
      ];
    return HttpResponse.json({
      tenant_id: tenantId,
      alias,
      exists: true,
      harness: esOpenclaw ? 'openclaw' : 'claude',
      perfil,
      hechos: {
        permisos: { ruta: true, lectura: true, control: false, notificacion: true },
        cuotas: [{ proveedor: 'claude', cuenta: 'saldantia', limite: '3% semanal' }],
        arnes: { harness: esOpenclaw ? 'openclaw' : 'claude', home: '/home/dev', contenedor: `ws-${alias}`, capacidades: ['bash', 'read', 'edit'] },
        destinos: ['kant', 'argos', 'socrates'],
      },
      limites: { purpose: 2000, role_summary: 4000, item: 1000, items: 64, total: 24000 },
      medida: { unidades: 640, tope: 24000 },
      base: 'fichero-vacio',
      ficheros: ficheros.map((f) => ({ ...f, unidades: f.texto.length })),
    });
  }),

  http.get('*/v3/console/tenants/:tenantId/agents/:alias/documents', ({ params }) => HttpResponse.json({
    tenant_id: String(params.tenantId),
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
        readable: true,
        editable: true,
      },
      {
        kind: 'tools',
        label: 'Herramientas y permisos (settings.json)',
        path: '/home/stev/.claude/settings.json',
        format: 'json',
        readable: false,
        editable: false,
        reason: 'Este canal sólo sirve manuales y perfil allowlisted; settings.json requiere validación estructural.',
        warning: 'Este fichero puede contener `hooks`: órdenes que el arnés ejecuta solo. Cambiarlo equivale a ejecutar código dentro del contenedor del agente.',
      },
      {
        kind: 'prompts',
        label: 'Subagentes (~/.claude/agents)',
        path: '/home/stev/.claude/agents',
        format: 'markdown',
        readable: false,
        editable: false,
        reason: 'Es un directorio; v1 sólo lista lo que hay, no edita fichero a fichero.',
      },
      {
        kind: 'mcp',
        label: 'Servidores MCP',
        path: '/home/stev/.claude.json',
        format: 'json',
        readable: false,
        editable: false,
        reason: 'Los MCP viven en `.claude.json`, junto al OAuth de la cuenta y al historial de todos los proyectos. No se sirve: habría que proyectar sólo `mcpServers`.',
      },
    ],
  })),
  http.get('*/v3/console/tenants/:tenantId/agents/:alias/documents/:kind/content', ({ params }) => {
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
      tenant_id: String(params.tenantId), alias: 'kant', kind: params.kind,
      path: esDirectiva ? '/home/stev/.claude/CLAUDE.md' : '/home/stev/.claude/settings.json',
      format: esDirectiva ? 'markdown' : 'json',
      exists: true, content: contenido,
      sha: esDirectiva
        ? 'fda7b5a2bcdb2d3bd7142ea12a36d23704d45333c029a8c93f3c086d6821bf75'
        : '2e89262dab4996b4d65d1a4770a71757af32b58e3c7925bce829e1fb144258d4',
      bytes: esDirectiva ? 243 : 61,
      editable: esDirectiva, projected: false, truncated: false,
    });
  }),
  http.put(
    '*/v3/console/tenants/:tenantId/agents/:alias/documents/:kind/content',
    async ({ request }) => {
    const cuerpo = await request.json() as { content?: string };
    return HttpResponse.json({
      ok: true, state: 'applied', evidence: 'probe_write_ack',
      path: '/home/stev/.claude/CLAUDE.md',
      sha: 'sha-nueva', bytes: (cuerpo.content ?? '').length,
    });
    },
  ),
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
  http.get('*/v3/console/role-assignments/:tenantId/:alias/history', ({ params }) => HttpResponse.json({
    observed_at: new Date().toISOString(),
    tenant_id: params.tenantId,
    alias: params.alias,
    entries: params.alias === 'kant' ? roleBriefHistoryKant : [],
  })),
  http.get('*/v3/console/terminal/capability', () => HttpResponse.json({ available: false, reason: 'Backend PTY no instalado en este entorno' })),
  http.get('*/v3/console/terminal/targets', () => HttpResponse.json({
    observed_at: new Date().toISOString(),
    items: [],
  })),
  /*
   * The operator's terminal sessions. The console reads them so it can CLOSE the ones left
   * hanging: without this handler, every test of the view spat out "intercepted a request
   * without a matching request handler" and the trap this listing unblocked went uncovered.
   */
  http.get('*/v3/console/terminal/sessions', () => HttpResponse.json({ items: [] })),
  http.delete('*/v3/console/terminal/sessions/:sid', () => new HttpResponse(null, { status: 204 })),
];
