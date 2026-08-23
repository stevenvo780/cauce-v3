import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import {
  createTerminalSession,
  deleteTerminalSession,
  listTerminalTargets,
  readTerminalTarget,
  terminalRequest,
  TerminalApiError,
} from './api';

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

it('normalises targets and never infers authority from a missing field', async () => {
  server.use(http.get('*/v3/console/terminal/targets', () => HttpResponse.json({
    observed_at: '2026-07-25T12:00:00.000Z',
    websocket_path: '/v3/console/terminal/ws',
    items: [
      { tenant_id: 'Steven', alias: 'jarvis', container: 'claw', runtime_user: 'claw', harness: 'claude-code', shares_container_with: [], modes: ['shell'], pty_state: 'online', last_seen: null, authorized: true, reason: 'Autorizado.' },
      { tenant_id: 'Steven', alias: 'argos', container: 'ctrl-infra', runtime_user: null, harness: null, shares_container_with: null, modes: null, pty_state: 'brand-new-state', last_seen: null, reason: '' },
      { alias: 'sin-tenant' },
    ],
  })));

  const snapshot = await listTerminalTargets();

  expect(snapshot.items).toHaveLength(2);
  expect(snapshot.items?.[0]).toMatchObject({ alias: 'jarvis', pty_state: 'online', authorized: true });
  // `authorized` absent, unknown pty_state and malformed lists all collapse to the closed side.
  expect(snapshot.items?.[1]).toMatchObject({ alias: 'argos', authorized: false, pty_state: 'unknown', shares_container_with: [], modes: [] });
  expect(snapshot.items?.[1].reason).toMatch(/no informó un motivo/i);
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

  await expect(createTerminalSession({
    tenant_id: 'Miguel', alias: 'kratos', mode: 'shell', reason: 'diagnóstico del adaptador', cols: 80, rows: 24,
  })).rejects.toMatchObject({ status: 403, code: 'forbidden', message: 'attribution_required' });
  expect(body).toEqual({ tenant_id: 'Miguel', alias: 'kratos', mode: 'shell', reason: 'diagnóstico del adaptador', cols: 80, rows: 24 });
});

it('surfaces a 409 conflict reason verbatim', async () => {
  server.use(http.post('*/v3/console/terminal/sessions', () => HttpResponse.json({ error: 'conflict', reason: 'agent_offline' }, { status: 409 })));
  await expect(createTerminalSession({ tenant_id: 'Steven', alias: 'argos', mode: 'shell', reason: 'revisar el bucle', cols: 80, rows: 24 }))
    .rejects.toMatchObject({ status: 409, code: 'conflict', message: 'agent_offline' });
});

it('returns the grant on 201 and releases it with a 204 DELETE', async () => {
  server.use(
    http.post('*/v3/console/terminal/sessions', () => HttpResponse.json({
      session_id: 'sess-1', ticket: 'one-shot', websocket_path: '/v3/console/terminal/ws',
      expires_at: '2026-07-25T12:00:30.000Z', ttl_seconds: 30,
      target: { tenant_id: 'Steven', alias: 'jarvis', container: 'claw', runtime_user: 'claw', mode: 'shell', shares_container_with: [] },
    }, { status: 201 })),
    http.delete('*/v3/console/terminal/sessions/sess-1', () => new HttpResponse(null, { status: 204 })),
  );

  const grant = await createTerminalSession({ tenant_id: 'Steven', alias: 'jarvis', mode: 'shell', reason: 'verificar el despliegue', cols: 80, rows: 24 });
  expect(grant).toMatchObject({ session_id: 'sess-1', ticket: 'one-shot', ttl_seconds: 30 });
  await expect(deleteTerminalSession('sess-1')).resolves.toBeUndefined();
});

it('exposes TerminalApiError so callers can branch on status without parsing strings', async () => {
  server.use(http.get('*/v3/console/terminal/targets', () => new HttpResponse(null, { status: 503 })));
  const error = await listTerminalTargets().catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(TerminalApiError);
});

/*
 * EL 403 QUE MANTENÍA LA TUI CERRADA.
 *
 * Medido contra el gateway desplegado el 2026-08-23, con la credencial de consola y el MISMO
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
    return puertaCsrf('mock-csrf-token', () => HttpResponse.json({
      session_id: 'sess-csrf', ticket: 'one-shot', websocket_path: '/v3/console/terminal/ws',
      expires_at: '2026-08-23T18:00:30.000Z', ttl_seconds: 30,
      target: { tenant_id: 'Steven', alias: 'zeus', container: 'ws-zeus', runtime_user: 'dev', mode: 'harness', shares_container_with: [] },
    }, { status: 201 }))(info);
  }));

  const grant = await createTerminalSession({
    tenant_id: 'Steven', alias: 'zeus', mode: 'harness', reason: 'abrir la TUI', cols: 80, rows: 24,
  });

  expect(vistos).toEqual(['mock-csrf-token']);
  expect(grant).toMatchObject({ session_id: 'sess-csrf', ttl_seconds: 30 });
});

it('adjunta el token CSRF también al soltar la sesión: un DELETE sin token deja la shell colgada del otro lado', async () => {
  const vistos: Array<string | null> = [];
  server.use(http.delete('*/v3/console/terminal/sessions/sess-csrf', (info) => {
    vistos.push(info.request.headers.get('X-CSRF-Token'));
    return puertaCsrf('mock-csrf-token', () => new HttpResponse(null, { status: 204 }))(info);
  }));

  await expect(deleteTerminalSession('sess-csrf')).resolves.toBeUndefined();
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
 * 🔴 El defecto BLOQUEANTE medido contra producción el 2026-08-23.
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
      return HttpResponse.json({
        session_id: 'sess-csrf', ticket: 'one-shot', websocket_path: '/v3/console/terminal/ws',
        expires_at: '2026-08-23T12:00:30.000Z', ttl_seconds: 30,
        target: { tenant_id: 'Steven', alias: 'zeus', container: 'claw', runtime_user: 'claw', mode: 'harness', shares_container_with: [] },
      }, { status: 201 });
    }));

    await createTerminalSession(
      { tenant_id: 'Steven', alias: 'zeus', mode: 'harness', reason: 'ver la TUI', cols: 80, rows: 24 },
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

    await deleteTerminalSession('sess-csrf', sesion);

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
