import { http, HttpResponse } from 'msw';
import { vi } from 'vitest';
import { server } from '../../mocks/server';
import { mockTerminalGrant } from '../../mocks/terminal-ticket';
import {
  createTerminalSession,
  deleteTerminalSession,
  listTerminalSessions,
  listTerminalTargets,
  readTerminalTarget,
  rotateTerminalSessionOwner,
  terminalRequest,
  type CreateTerminalSessionInput,
  type TerminalSessionOwner,
  TerminalApiError,
  TERMINAL_REQUEST_TIMEOUT_MS,
} from './api';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_TOKEN = '22222222-2222-4222-8222-222222222222';
const NEXT_OWNER_TOKEN = '33333333-3333-4333-8333-333333333333';
const OWNER: TerminalSessionOwner = {
  request_id: REQUEST_ID,
  owner_generation: '1',
  owner_token: OWNER_TOKEN,
};

function sessionInput(overrides: Partial<CreateTerminalSessionInput> = {}): CreateTerminalSessionInput {
  return {
    tenant_id: 'Steven',
    alias: 'jarvis',
    mode: 'shell',
    reason: 'verificar el despliegue',
    cols: 80,
    rows: 24,
    request_id: REQUEST_ID,
    owner_token: OWNER_TOKEN,
    ...overrides,
  };
}

it('keeps the shared client hygiene: cookies, console header and JSON only when there is a body', async () => {
  const seen: Array<{ method: string; console: string | null; contentType: string | null; credentials: string }> = [];
  server.use(
    http.get('*/v3/console/terminal/probe', ({ request }) => {
      seen.push({ method: request.method, console: request.headers.get('X-Cauce-Console'), contentType: request.headers.get('Content-Type'), credentials: request.credentials });
      return HttpResponse.json({ ok: true });
    }),
    http.post('*/v3/console/terminal/probe', ({ request }) => {
      seen.push({ method: request.method, console: request.headers.get('X-Cauce-Console'), contentType: request.headers.get('Content-Type'), credentials: request.credentials });
      return HttpResponse.json({ ok: true });
    }),
  );

  await terminalRequest('/v3/console/terminal/probe');
  await terminalRequest('/v3/console/terminal/probe', { method: 'POST', body: '{}' });

  expect(seen[0]).toMatchObject({ method: 'GET', console: '1', contentType: null, credentials: 'include' });
  expect(seen[1]).toMatchObject({ method: 'POST', console: '1', contentType: 'application/json', credentials: 'include' });
});

it.each([404, 501])('treats %s on the optional targets endpoint as UNKNOWN, not as an empty allow-list', async (status) => {
  server.use(http.get('*/v3/console/terminal/targets', () => new HttpResponse(null, { status })));

  const snapshot = await listTerminalTargets();

  // UNKNOWN must stay UNKNOWN: an empty array would read as "no destination is authorised",
  // which is a different (and quietly wrong) statement.
  expect(snapshot.items).toBeNull();
  expect(snapshot.reason).toMatch(/no expone el inventario/i);
});

it('propagates a real failure as a typed error instead of swallowing it', async () => {
  server.use(http.get('*/v3/console/terminal/targets', () => HttpResponse.json({ error: 'internal', message: 'store caído' }, { status: 500 })));

  await expect(listTerminalTargets()).rejects.toMatchObject({ name: 'TerminalApiError', status: 500, code: 'internal', message: 'store caído' });
});

it('accepts explicit denied and unknown targets without inferring authority', async () => {
  server.use(http.get('*/v3/console/terminal/targets', () => HttpResponse.json({
    observed_at: '2026-07-25T12:00:00.000Z',
    websocket_path: '/v3/console/terminal/ws',
    items: [
      { tenant_id: 'Steven', alias: 'jarvis', container: 'claw', runtime_user: 'claw', harness: 'claude-code', shares_container_with: [], modes: ['shell'], pty_state: 'online', last_seen: null, authorized: true, reason: 'Autorizado.' },
      { tenant_id: 'Steven', alias: 'argos', container: null, runtime_user: null, harness: null, shares_container_with: [], modes: [], pty_state: 'unknown', last_seen: null, authorized: false, reason: 'sin autoridad sobre Steven:argos' },
    ],
  })));

  const snapshot = await listTerminalTargets();

  expect(snapshot.items).toHaveLength(2);
  expect(snapshot.items?.[0]).toMatchObject({ alias: 'jarvis', pty_state: 'online', authorized: true });
  // UNKNOWN is accepted only when the server said it explicitly and the row is structurally exact.
  expect(snapshot.items?.[1]).toMatchObject({ alias: 'argos', authorized: false, pty_state: 'unknown', shares_container_with: [], modes: [] });
  expect(snapshot.items?.[1].reason).toMatch(/sin autoridad/i);
});

it.each([
  ['a target without identity', [
    { tenant_id: 'Steven', alias: 'jarvis', modes: ['shell'], authorized: true },
    { alias: 'sin-tenant' },
  ]],
  ['a duplicate identity', [
    { tenant_id: 'Steven', alias: 'jarvis', modes: ['shell'], authorized: true },
    { tenant_id: 'Steven', alias: 'jarvis', modes: ['harness'], authorized: true },
  ]],
  ['a partially malformed shared-container cohort', [{
    tenant_id: 'Steven', alias: 'jarvis', container: 'ws-humanizar', runtime_user: 'dev',
    harness: 'claude-code', shares_container_with: [{ tenant_id: 'Miguel', alias: 'kratos' }, null],
    modes: ['shell'], pty_state: 'online', last_seen: null, authorized: true, reason: 'Autorizado.',
  }]],
  ['a duplicated shared-container identity', [{
    tenant_id: 'Steven', alias: 'jarvis', container: 'ws-humanizar', runtime_user: 'dev',
    harness: 'claude-code', shares_container_with: [
      { tenant_id: 'Miguel', alias: 'kratos' }, { tenant_id: 'Miguel', alias: 'kratos' },
    ], modes: ['shell'], pty_state: 'online', last_seen: null, authorized: true, reason: 'Autorizado.',
  }]],
  ['a malformed modes list', [{
    tenant_id: 'Steven', alias: 'jarvis', container: 'claw', runtime_user: 'claw',
    harness: 'claude-code', shares_container_with: [], modes: ['shell', null], pty_state: 'online',
    last_seen: null, authorized: true, reason: 'Autorizado.',
  }]],
])('turns the whole target inventory UNKNOWN when it contains %s instead of hiding one row', async (_case, items) => {
  server.use(http.get('*/v3/console/terminal/targets', () => HttpResponse.json({ items })));

  const snapshot = await listTerminalTargets();

  expect(snapshot.items).toBeNull();
  expect(snapshot.reason).toMatch(/parcial, duplicado o mal formado/i);
});

it.each(['GET', 'POST', 'DELETE'] as const)(
  'cuts a %s terminal request that ignores abort and returns a retryable typed timeout',
  async (method) => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => undefined));
    const session = { csrfForMutation: () => Promise.resolve('csrf') };
    try {
      const outcome = terminalRequest('/v3/console/terminal/never', {
        method,
        ...(method === 'GET' ? {} : { body: '{}' }),
      }, session).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(TERMINAL_REQUEST_TIMEOUT_MS);
      await expect(outcome).resolves.toMatchObject({ status: 504, code: 'timeout' });
    } finally {
      fetchSpy.mockRestore();
      vi.useRealTimers();
    }
  },
);

it('keeps the timeout armed after headers while a JSON body never finishes', async () => {
  vi.useFakeTimers();
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
    new ReadableStream({ start() { /* intentionally never closes */ } }),
    { headers: { 'content-type': 'application/json' } },
  ));
  try {
    const outcome = terminalRequest('/v3/console/terminal/stalled-body')
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(TERMINAL_REQUEST_TIMEOUT_MS);
    await expect(outcome).resolves.toMatchObject({ status: 504, code: 'timeout' });
  } finally {
    fetchSpy.mockRestore();
    vi.useRealTimers();
  }
});

it('ignores a payload without an items array instead of reporting zero targets', async () => {
  server.use(http.get('*/v3/console/terminal/targets', () => HttpResponse.json({ observed_at: null })));
  expect((await listTerminalTargets()).items).toBeNull();
});

it('rejects a target record without an exact tenant and alias', () => {
  expect(readTerminalTarget({ tenant_id: 'Steven' })).toBeUndefined();
  expect(readTerminalTarget({ tenant_id: '  ', alias: 'jarvis' })).toBeUndefined();
  expect(readTerminalTarget('jarvis')).toBeUndefined();
});

it('requests a session with the allow-listed body and surfaces the server reason on 403', async () => {
  let body: Record<string, unknown> | undefined;
  server.use(http.post('*/v3/console/terminal/sessions', async ({ request }) => {
    body = await request.json() as Record<string, unknown>;
    return HttpResponse.json({ error: 'forbidden', reason: 'attribution_required' }, { status: 403 });
  }));

  await expect(createTerminalSession(sessionInput({
    tenant_id: 'Miguel', alias: 'kratos', reason: 'diagnóstico del adaptador',
  }))).rejects.toMatchObject({ status: 403, code: 'forbidden', message: 'attribution_required' });
  expect(body).toEqual(sessionInput({
    tenant_id: 'Miguel', alias: 'kratos', reason: 'diagnóstico del adaptador',
  }));
});

it('surfaces a 409 conflict reason verbatim', async () => {
  server.use(http.post('*/v3/console/terminal/sessions', () => HttpResponse.json({ error: 'conflict', reason: 'agent_offline' }, { status: 409 })));
  await expect(createTerminalSession(sessionInput({ alias: 'argos', reason: 'revisar el bucle' })))
    .rejects.toMatchObject({ status: 409, code: 'conflict', message: 'agent_offline' });
});

it('returns the grant on 201 and releases it with a 204 DELETE', async () => {
  let releaseBody: unknown;
  server.use(
    http.post('*/v3/console/terminal/sessions', () => HttpResponse.json(mockTerminalGrant({
      sessionId: 'sess-1', tenantId: 'Steven', alias: 'jarvis', container: 'claw',
      runtimeUser: 'claw', mode: 'shell', requestId: REQUEST_ID,
    }), { status: 201 })),
    http.delete('*/v3/console/terminal/sessions/sess-1', async ({ request }) => {
      releaseBody = await request.json();
      return new HttpResponse(null, { status: 204 });
    }),
  );

  const grant = await createTerminalSession(sessionInput());
  expect(grant).toMatchObject({
    session_id: 'sess-1', ticket: expect.stringMatching(/^v1\./u), ttl_seconds: 30,
    receipt_recovered: false,
  });
  await expect(deleteTerminalSession('sess-1', OWNER)).resolves.toBeUndefined();
  expect(releaseBody).toEqual({
    request_id: REQUEST_ID,
    owner_generation: '1',
    owner_token: OWNER_TOKEN,
  });
});

it('rotates browser ownership with an exact CAS request and keeps the raw token client-side', async () => {
  let takeoverBody: unknown;
  server.use(http.post('*/v3/console/terminal/sessions/sess-owner/owner', async ({ request }) => {
    takeoverBody = await request.json();
    return HttpResponse.json({
      session_id: 'sess-owner',
      request_id: REQUEST_ID,
      owner_generation: '2',
    });
  }));

  const owner = await rotateTerminalSessionOwner(
    'sess-owner',
    { request_id: REQUEST_ID, owner_generation: '1' },
    NEXT_OWNER_TOKEN,
  );
  expect(takeoverBody).toEqual({
    request_id: REQUEST_ID,
    expected_owner_generation: '1',
    owner_token: NEXT_OWNER_TOKEN,
  });
  expect(owner).toEqual({
    request_id: REQUEST_ID,
    owner_generation: '2',
    owner_token: NEXT_OWNER_TOKEN,
  });
});

it.each([
  ['an echoed owner token', {
    session_id: 'sess-owner', request_id: REQUEST_ID, owner_generation: '2', owner_token: NEXT_OWNER_TOKEN,
  }],
  ['a skipped generation', {
    session_id: 'sess-owner', request_id: REQUEST_ID, owner_generation: '3',
  }],
  ['another request id', {
    session_id: 'sess-owner', request_id: '44444444-4444-4444-8444-444444444444', owner_generation: '2',
  }],
])('rejects an ownership receipt with %s', async (_case, receipt) => {
  server.use(http.post('*/v3/console/terminal/sessions/sess-owner/owner', () => HttpResponse.json(receipt)));
  await expect(rotateTerminalSessionOwner(
    'sess-owner',
    { request_id: REQUEST_ID, owner_generation: '1' },
    NEXT_OWNER_TOKEN,
  )).rejects.toMatchObject({ status: 409, code: 'invalid_owner_receipt' });
});

it.each([
  ['an extra root key', (base: Record<string, unknown>) => ({ ...base, private: true })],
  ['an extra target key', (base: Record<string, unknown>) => ({
    ...base, target: { ...(base.target as Record<string, unknown>), private: true },
  })],
  ['an extra cohort key', (base: Record<string, unknown>) => ({
    ...base,
    target: {
      ...(base.target as Record<string, unknown>),
      shares_container_with: [{ tenant_id: 'Steven', alias: 'kant', private: true }],
    },
  })],
  ['a missing recovered marker', (base: Record<string, unknown>) => {
    const malformed = { ...base };
    delete malformed.receipt_recovered;
    return malformed;
  }],
  ['a non-boolean recovered marker', (base: Record<string, unknown>) => ({
    ...base, receipt_recovered: 'false',
  })],
  ['another request id', (base: Record<string, unknown>) => ({
    ...base, request_id: '44444444-4444-4444-8444-444444444444',
  })],
  ['an invalid owner generation', (base: Record<string, unknown>) => ({
    ...base, owner_generation: 1,
  })],
  ['a ticket naming another session', (base: Record<string, unknown>) => ({
    ...base,
    ticket: mockTerminalGrant({
      sessionId: 'victim-session', tenantId: 'Steven', alias: 'jarvis', container: 'claw',
      runtimeUser: 'claw', mode: 'shell',
    }).ticket,
  })],
])('rejects a 201 grant with %s as an untrusted receipt', async (_case, mutate) => {
  const base = mockTerminalGrant({
    sessionId: 'sess-exact', tenantId: 'Steven', alias: 'jarvis', container: 'claw',
    runtimeUser: 'claw', mode: 'shell', requestId: REQUEST_ID,
  });
  server.use(http.post('*/v3/console/terminal/sessions', () => HttpResponse.json(
    mutate(base), { status: 201 },
  )));

  await expect(createTerminalSession(sessionInput({ reason: 'validar exactitud' })))
    .rejects.toMatchObject({ status: 409, code: 'invalid_grant_receipt' });
});

it('rejects a malformed 201 grant without deleting the untrusted session_id', async () => {
  let deleteAttempts = 0;
  server.use(
    http.post('*/v3/console/terminal/sessions', () => HttpResponse.json({
      // Puede ser el id de una sesión ajena: viene en el mismo recibo que ya probó ser inválido.
      session_id: 'another-tabs-live-session',
      // Sin ticket/expiry/target: un 201 por sí solo no abre un canal ni acredita la reserva.
      websocket_path: '/v3/console/terminal/ws',
    }, { status: 201 })),
    http.delete('*/v3/console/terminal/sessions/:sessionId', () => {
      deleteAttempts += 1;
      return new HttpResponse(null, { status: 204 });
    }),
  );

  await expect(createTerminalSession(sessionInput({ reason: 'validar recibo' })))
    .rejects.toMatchObject({ status: 409, code: 'invalid_grant_receipt' });
  expect(deleteAttempts).toBe(0);
});

it('does not treat a non-204 DELETE response as proof that the PTY slot was released', async () => {
  server.use(http.delete('*/v3/console/terminal/sessions/not-released', () => HttpResponse.json({
    ok: true,
  }, { status: 200 })));

  await expect(deleteTerminalSession('not-released', OWNER)).rejects.toMatchObject({
    status: 409,
    code: 'invalid_release_receipt',
  });
});

it.each([
  ['missing items', {}],
  ['a malformed row', { items: [{ session_id: 'sid-without-verifiable-identity' }] }],
  ['an explicitly truncated empty page', { items: [], truncated: true }],
  ['an empty page carrying an error', { items: [], error: 'database timeout' }],
  ['a row with an uncontracted field', { items: [
    { session_id: 'sid-1', tenant_id: 'Steven', alias: 'zeus', mode: 'harness', opened_at: '2026-08-26T00:00:00.000Z', expires_at: '2026-08-26T00:15:00.000Z', state: 'active', private: true },
  ] }],
  ['duplicate session ids', { items: [
    { session_id: 'sid-1', tenant_id: 'Steven', alias: 'zeus', mode: 'harness', opened_at: '2026-08-26T00:00:00.000Z', expires_at: '2026-08-26T00:15:00.000Z', state: 'active' },
    { session_id: 'sid-1', tenant_id: 'Steven', alias: 'kant', mode: 'harness', opened_at: '2026-08-26T00:00:00.000Z', expires_at: '2026-08-26T00:15:00.000Z', state: 'active' },
  ] }],
])('does not turn a session inventory with %s into an empty or partial list', async (_case, payload) => {
  server.use(http.get('*/v3/console/terminal/sessions', () => HttpResponse.json(payload)));

  await expect(listTerminalSessions()).rejects.toMatchObject({
    status: 409,
    code: 'invalid_sessions_receipt',
  });
});

it('accepts only the exact fenced session inventory projection', async () => {
  server.use(http.get('*/v3/console/terminal/sessions', () => HttpResponse.json({
    items: [{
      session_id: 'sid-1',
      tenant_id: 'Steven',
      alias: 'zeus',
      mode: 'harness',
      opened_at: '2026-08-26T00:00:00.000Z',
      expires_at: '2026-08-26T00:15:00.000Z',
      state: 'active',
      request_id: REQUEST_ID,
      owner_generation: '9223372036854775807',
    }],
  })));

  await expect(listTerminalSessions()).resolves.toEqual([expect.objectContaining({
    session_id: 'sid-1',
    request_id: REQUEST_ID,
    owner_generation: '9223372036854775807',
  })]);
});

it('exposes TerminalApiError so callers can branch on status without parsing strings', async () => {
  server.use(http.get('*/v3/console/terminal/targets', () => new HttpResponse(null, { status: 503 })));
  const error = await listTerminalTargets().catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(TerminalApiError);
});

/*
 * EL 403 QUE MANTENÍA LA TUI CERRADA.
 *
 * 
 * cuerpo en las dos corridas: sin la cabecera `X-CSRF-Token` el gateway contesta
 * 403 {"error":"forbidden","message":"se requiere un token CSRF válido"}; con ella contesta
 * 201 y entrega el grant. Con un token inventado vuelve a ser 403, así que no es "mandar la
 * cabecera": es mandar EL token de la sesión.
 *
 * La trampa que hacía irreconocible el fallo es que la autoridad del PTY también deniega con
 * 403. Los dos cuerpos se distinguen por la clave: la puerta CSRF contesta en `message`, la ruta
 * contesta en `reason`. Por eso "403 siempre, 3 de 3" parecía un permiso que faltaba.
 *
 * Estos casos reproducen esa puerta en el servidor de pruebas: fallan mientras `terminalRequest`
 * mande las mismas cabeceras que mandaba (Accept, X-Cauce-Console, Content-Type) y pasan cuando
 * adjunta el token de la sesión, igual que hace el cliente compartido.
 */

/** La puerta CSRF del gateway, tal cual: 403 sin token, y sólo el token de la sesión abre. */
function puertaCsrf(token: string, alOk: () => Response) {
  return ({ request }: { request: Request }) => {
    const presentado = request.headers.get('X-CSRF-Token');
    if (presentado !== token) {
      return HttpResponse.json({ error: 'forbidden', message: 'se requiere un token CSRF válido' }, { status: 403 });
    }
    return alOk();
  };
}

it('adjunta el token CSRF de la sesión al pedir un grant: sin él el gateway responde 403 y la TUI no abre', async () => {
  const vistos: Array<string | null> = [];
  server.use(http.post('*/v3/console/terminal/sessions', (info) => {
    vistos.push(info.request.headers.get('X-CSRF-Token'));
    return puertaCsrf('mock-csrf-token', () => HttpResponse.json(mockTerminalGrant({
      sessionId: 'sess-csrf', tenantId: 'Steven', alias: 'zeus', container: 'ws-zeus',
      runtimeUser: 'dev', mode: 'harness', requestId: REQUEST_ID,
    }), { status: 201 }))(info);
  }));

  const grant = await createTerminalSession(sessionInput({
    alias: 'zeus', mode: 'harness', reason: 'abrir la TUI',
  }));

  expect(vistos).toEqual(['mock-csrf-token']);
  expect(grant).toMatchObject({ session_id: 'sess-csrf', ttl_seconds: 30 });
});

it('adjunta el token CSRF también al soltar la sesión: un DELETE sin token deja la shell colgada del otro lado', async () => {
  const vistos: Array<string | null> = [];
  server.use(http.delete('*/v3/console/terminal/sessions/sess-csrf', (info) => {
    vistos.push(info.request.headers.get('X-CSRF-Token'));
    return puertaCsrf('mock-csrf-token', () => new HttpResponse(null, { status: 204 }))(info);
  }));

  await expect(deleteTerminalSession('sess-csrf', OWNER)).resolves.toBeUndefined();
  expect(vistos).toEqual(['mock-csrf-token']);
});

it('no manda el token en las lecturas: el gateway no lo exige a un GET y pedirlo sería un viaje de más', async () => {
  const vistos: Array<string | null> = [];
  server.use(http.get('*/v3/console/terminal/targets', ({ request }) => {
    vistos.push(request.headers.get('X-CSRF-Token'));
    return HttpResponse.json({ items: [] });
  }));

  await listTerminalTargets();

  expect(vistos).toEqual([null]);
});

/**
 * El defecto BLOQUEANTE 
 *
 * `POST /v3/console/terminal/sessions` volvía `403 {"error":"forbidden","message":"se requiere un
 * token CSRF válido"}` en los 3 intentos, con dos alias distintos, porque este módulo no mandaba
 * ninguna cabecera CSRF. No era la máquina estrangulada: el rechazo volvía en 1,9-3,7 s mientras
 * el resto de endpoints tardaba entre 4 y 56 s, determinista y siempre igual. Con esto, la TUI no
 * abría NUNCA.
 */
describe('el token CSRF viaja en toda escritura del plano PTY', () => {
  const sesion = { csrfForMutation: () => Promise.resolve('token-de-la-sesion') };

  it('adjunta X-CSRF-Token al POST que abre la sesión', async () => {
    let csrf: string | null = 'ausente';
    server.use(http.post('*/v3/console/terminal/sessions', ({ request }) => {
      csrf = request.headers.get('X-CSRF-Token');
      return HttpResponse.json(mockTerminalGrant({
        sessionId: 'sess-csrf', tenantId: 'Steven', alias: 'zeus', container: 'claw',
        runtimeUser: 'claw', mode: 'harness', requestId: REQUEST_ID,
      }), { status: 201 });
    }));

    await createTerminalSession(
      sessionInput({ alias: 'zeus', mode: 'harness', reason: 'ver la TUI' }),
      sesion,
    );

    expect(csrf).toBe('token-de-la-sesion');
  });

  it('adjunta X-CSRF-Token al DELETE que suelta la sesión', async () => {
    let csrf: string | null = 'ausente';
    server.use(http.delete('*/v3/console/terminal/sessions/sess-csrf', ({ request }) => {
      csrf = request.headers.get('X-CSRF-Token');
      return new HttpResponse(null, { status: 204 });
    }));

    await deleteTerminalSession('sess-csrf', OWNER, sesion);

    expect(csrf).toBe('token-de-la-sesion');
  });

  it('no le pide token a la sesión para una lectura: el inventario es un GET', async () => {
    let pedidos = 0;
    const contadora = { csrfForMutation: () => { pedidos += 1; return Promise.resolve('token'); } };
    server.use(http.get('*/v3/console/terminal/targets', () => HttpResponse.json({ items: [] })));

    await terminalRequest('/v3/console/terminal/targets', {}, contadora);

    expect(pedidos).toBe(0);
  });

  it('toma el token de la sesión compartida cuando el llamador no pasa ninguna', async () => {
    // El singleton `cauceApi` lo resuelve contra `/v3/auth/session`, igual que el resto de la
    // consola: `mock-csrf-token` sale del handler global de MSW.
    let csrf: string | null = 'ausente';
    server.use(http.post('*/v3/console/terminal/probe', ({ request }) => {
      csrf = request.headers.get('X-CSRF-Token');
      return HttpResponse.json({ ok: true });
    }));

    await terminalRequest('/v3/console/terminal/probe', { method: 'POST', body: '{}' });

    expect(csrf).toBe('mock-csrf-token');
  });
});
