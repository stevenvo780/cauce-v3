import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { QuotasPage } from './QuotasPage';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import type { QuotaSnapshot } from '../../api/types';

/**
 * "Cuotas y licencias" es UNA vista con dos fuentes: `/v3/console/quotas` (consumo) y
 * `/v3/console/config` (inventario). Estas pruebas existen sobre todo para que no vuelva a
 * partirse en dos: cada mitad tiene acá una afirmación que falla si alguien la muda a otra ruta o
 * la borra "porque ya estaba en la otra pantalla".
 */

const QUOTAS_URL = 'http://localhost/v3/console/quotas';
const CONFIG_URL = 'http://localhost/v3/console/config';

const BASE: QuotaSnapshot = {
  observed_at: '2026-07-27T14:52:11.000Z',
  thresholds: {
    stale_after_seconds: 900,
    warn_remaining_percent: 25,
    critical_remaining_percent: 10,
    history_window_seconds: 86_400,
    history_bucket_seconds: 1_800,
    history_max_points: 48,
  },
  collectors: [
    { host: 'kratos', collector_tenant: 'Steven', collector_alias: 'quota-collector', captured_at: '2026-07-27T14:40:28.000Z', received_at: '2026-07-27T14:40:29.000Z', age_seconds: 702, stale: false, schema_version: 2, app_version: '0.12.0', provider_count: 2, window_count: 4 },
  ],
  providers: [
    {
      host: 'kratos', provider: 'opencode', ok: true, available: true, kind: 'detected-percent', source: 'opencode-db', plan: null,
      note: 'Estimado local.', effective_remaining_percent: 100, observed_at: '2026-07-27T14:40:14.000Z', age_seconds: 717,
      available_groups: [], limiting_groups: [], severity: 'ok',
      groups: [{
        group_key: 'default', limit_id: null, account_id: 'minimax-pool', account_label: 'MiniMax / OpenCode',
        account_provider: 'opencode', payer_tenant_id: 'Steven', paused_until: null, paused_reason: null,
        min_remaining_percent: 100, severity: 'ok',
        windows: [
          { window_key: '5h', label: '5 horas', used_percent: 0, remaining_percent: 100, used_units: 0, limit_units: 12, window_minutes: 300, reset_at: '2026-07-27T19:40:14.000Z', reset_in_seconds: 17_283, status: null, family: null, model: null, severity: 'ok', history: { bucket_seconds: 1_800, points: [{ at: 'a', used_percent: 0 }, { at: 'b', used_percent: 0 }] } },
        ],
      }],
    },
    {
      host: 'kratos', provider: 'codex', ok: true, available: true, kind: 'detected-percent', source: 'codex-app-server', plan: 'pro',
      note: 'Codex app-server (consulta oficial).', effective_remaining_percent: 100, observed_at: '2026-07-27T14:40:28.000Z', age_seconds: 703,
      available_groups: ['codex_bengalfox'], limiting_groups: ['codex'], severity: 'exhausted',
      groups: [
        {
          group_key: 'codex', limit_id: 'codex', account_id: 'codex-pro-steven', account_label: 'Codex Pro (principal)',
          account_provider: 'codex', payer_tenant_id: 'Steven', paused_until: '2026-08-01T19:18:21.000Z', paused_reason: 'quota_exhausted:codex/codex/codex_primary_10080',
          min_remaining_percent: 0, severity: 'exhausted',
          windows: [
            { window_key: 'codex_primary_10080', label: 'semana', used_percent: 100, remaining_percent: 0, used_units: null, limit_units: null, window_minutes: 10_080, reset_at: '2026-08-01T19:18:21.000Z', reset_in_seconds: 447_970, status: 'rate-limited', family: null, model: null, severity: 'exhausted', history: { bucket_seconds: 1_800, points: [{ at: 'a', used_percent: 94 }, { at: 'b', used_percent: 100 }] } },
          ],
        },
        {
          group_key: 'codex_bengalfox', limit_id: 'codex_bengalfox', account_id: null, account_label: null,
          account_provider: null, payer_tenant_id: null, paused_until: null, paused_reason: null,
          min_remaining_percent: 100, severity: 'ok',
          windows: [
            { window_key: 'codex_bengalfox_primary_10080', label: 'semana', used_percent: 0, remaining_percent: 100, used_units: null, limit_units: null, window_minutes: 10_080, reset_at: '2026-08-03T14:28:04.000Z', reset_in_seconds: 603_353, status: null, family: null, model: null, severity: 'ok', history: { bucket_seconds: 1_800, points: [{ at: 'a', used_percent: 0 }, { at: 'b', used_percent: 0 }] } },
          ],
        },
      ],
    },
  ],
  unbound_groups: [
    { host: 'kratos', provider: 'codex', group_key: 'codex_bengalfox', window_count: 1, reason: 'no_account_id_supplied', detail: 'Sin account_id: no puede pausar nada.' },
  ],
  paused_accounts: [
    { account_id: 'codex-pro-steven', provider: 'codex', label: 'Codex Pro (principal)', payer_tenant_id: 'Steven', paused_until: '2026-08-01T19:18:21.000Z', paused_reason: 'quota_exhausted:codex/codex/codex_primary_10080', automatic: true },
  ],
};

/** Inventario que engancha con BASE: dos cuentas que el recolector conoce y una que no. */
const CONFIG = {
  revision: 42,
  observed_at: '2026-08-06T02:55:00.000Z',
  agents: [
    { tenant_id: 'Steven', alias: 'zeus', harness_id: 'codex', display_name: 'Zeus', enabled: true, container_name: 'claw-zeus' },
    { tenant_id: 'Steven', alias: 'kant', harness_id: 'claude', display_name: 'Kant', enabled: true, container_name: 'claw-kant' },
  ],
  provider_accounts: [
    { id: 'codex-pro-steven', provider: 'codex', payer_tenant_id: 'Steven', label: 'Codex Pro (principal)', shared_with_pool: true, enabled: true, external_account_id: 'bengalfox@openai', credential_ref_kind: 'file' },
    { id: 'minimax-pool', provider: 'opencode', payer_tenant_id: 'Miguel', label: 'MiniMax / OpenCode', shared_with_pool: false, enabled: true, external_account_id: null, credential_ref_kind: 'file' },
    { id: 'claude-max-saldantia', provider: 'claude', payer_tenant_id: 'Steven', label: 'Claude Max — saldantia.sas', shared_with_pool: true, enabled: true, external_account_id: 'saldantia.sas@gmail.com', credential_ref_kind: 'file' },
  ],
  agent_account_bindings: [
    { tenant_id: 'Steven', agent_alias: 'zeus', account_id: 'codex-pro-steven', priority: 0, enabled: true },
    { tenant_id: 'Steven', agent_alias: 'zeus', account_id: 'minimax-pool', priority: 1, enabled: true },
  ],
  alias_routing_ceiling: [
    { tenant_id: 'Steven', alias: 'zeus', account_id: 'codex-pro-steven', account_payer_tenant: 'Steven', created_by_tenant: 'Steven' },
  ],
};

function mockBoth(snapshot: QuotaSnapshot = BASE, config: Record<string, unknown> = CONFIG) {
  server.use(
    http.get(QUOTAS_URL, () => HttpResponse.json(snapshot)),
    http.get(CONFIG_URL, () => HttpResponse.json(config)),
  );
}

function panel(name: string): HTMLElement {
  return screen.getByRole('heading', { level: 2, name }).closest('section')!;
}

/** Las etiquetas de métrica repiten títulos de panel ("Proveedores"): hay que acotar la búsqueda. */
function metrics(): HTMLElement {
  return document.querySelector('.metrics-grid') as HTMLElement;
}

it('es UNA sola vista con las dos mitades: consumo de cuota e inventario de licencias', async () => {
  mockBoth();
  renderWithApi(<QuotasPage />);

  await screen.findByRole('heading', { level: 1, name: 'Cuotas y licencias' });

  // Un solo encabezado de página: si alguien vuelve a partir esto en dos rutas, la mitad que se
  // vaya se lleva su panel y una de estas dos búsquedas deja de encontrarlo.
  expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  expect(panel('Proveedores')).toBeInTheDocument();
  expect(panel('Inventario de cuentas')).toBeInTheDocument();

  // Las métricas de las dos vistas originales conviven: ninguna se perdió en la fusión.
  for (const label of [
    'Cuentas registradas', 'Con datos de cuota', 'Agentes', 'Recolectores conectados',
    'Proveedores', 'Peor remanente', 'Suscripciones pausadas', 'Grupos sin cuenta atada',
  ]) {
    expect(within(metrics()).getByText(label)).toBeInTheDocument();
  }
});

it('conserva entero el inventario de licencias: identidad, pagador, asignaciones y techo de ruteo', async () => {
  mockBoth();
  renderWithApi(<QuotasPage />);

  await screen.findByRole('heading', { level: 1, name: 'Cuotas y licencias' });
  const inventory = panel('Inventario de cuentas');
  const text = inventory.textContent ?? '';

  expect(text).toContain('codex-pro-steven');
  expect(text).toContain('bengalfox@openai');
  // Una cuenta que paga otro tenant no expone su id externo, y eso se dice con todas las letras.
  expect(text).toMatch(/Redactado: pagada por otro tenant/i);
  expect(within(inventory).getAllByText('PUBLICADA AL POOL').length).toBeGreaterThan(0);
  // Quién usa la cuenta y con qué prioridad: esto no existe en ninguna otra parte de la consola
  // junto al saldo, y es la razón de ser de la fusión.
  expect(text).toContain('zeus');
  expect(text).toContain('claw-zeus');
  expect(within(inventory).getAllByText('PRIMARIA').length).toBeGreaterThan(0);
  expect(text).toMatch(/Techo de ruteo/);
  expect(text).toMatch(/está limitado a esta cuenta/);
  // El plan sale de la muestra de cuota, del lado del consumo: la fusión es lo que lo hace posible.
  expect(text).toContain('pro');
});

it('conserva entero el consumo: peor primero, una fila por grupo y el histórico de 24 h', async () => {
  mockBoth();
  renderWithApi(<QuotasPage />);

  const providers = await screen.findByRole('heading', { level: 2, name: 'Proveedores' }).then((h) => h.closest('section')!);
  const cards = within(providers).getAllByRole('heading', { level: 3 });
  // codex está exhausted y opencode ok: el exhausted tiene que aparecer primero.
  expect(cards[0]).toHaveTextContent(/codex/i);

  const codexRow = within(providers).getByRole('row', { name: /codex pro/i });
  expect(within(codexRow).getByText('AGOTADO')).toBeInTheDocument();
  expect(within(codexRow).getByText('PAUSADA')).toBeInTheDocument();
  expect(codexRow.className).toContain('row-critical');
  // 'codex' (agotado) y 'codex_bengalfox' (libre, sin cuenta) son filas separadas: un solo número
  // por proveedor haría creer que hay saldo en la cuenta que justo no lo tiene.
  expect(within(providers).getByRole('row', { name: /sin cuenta/i })).toBeInTheDocument();

  const healthy = within(providers).getByRole('row', { name: /minimax/i });
  expect(healthy.className).not.toContain('row-critical');
  expect(healthy).toHaveTextContent('0 / 12');
  expect(within(providers).getAllByRole('img', { name: /consumo/i }).length).toBeGreaterThan(0);

  expect(panel('Suscripciones pausadas')).toHaveTextContent('Codex Pro (principal)');
});

it('la única representación gráfica es el sparkline: las barras duplicadas de licencias no volvieron', async () => {
  mockBoth();
  renderWithApi(<QuotasPage />);
  await screen.findByRole('heading', { level: 1, name: 'Cuotas y licencias' });

  // Las tarjetas de cuenta dibujaban su propia barra de porcentaje con menos datos que la tabla de
  // Proveedores: dos dibujos del mismo número en la misma página.
  expect(document.querySelectorAll('.windows-grid, .bar-container, .bar-fill')).toHaveLength(0);
  expect(document.querySelectorAll('.sparkline svg').length).toBeGreaterThan(0);
});

it('junta las tres direcciones de huérfano en un solo panel de hallazgos', async () => {
  mockBoth();
  renderWithApi(<QuotasPage />);

  const findings = await screen.findByRole('heading', { level: 2, name: 'Hallazgos' }).then((h) => h.closest('section')!);
  const text = findings.textContent ?? '';
  // 1) cuenta registrada que el recolector no conoce, 2) grupo observado sin cuenta atada —con su
  // window_count, que es lo que la lista pobre de la otra vista no traía—, 3) agente sin binding.
  expect(text).toContain('claude-max-saldantia');
  const unboundRow = within(findings).getByRole('row', { name: /codex_bengalfox/i });
  expect(unboundRow).toHaveTextContent('Sin account_id');
  // window_count: la lista pobre de la vista de licencias no lo traía y la tabla de cuotas sí.
  expect(within(unboundRow).getAllByRole('cell')[3]).toHaveTextContent('1');
  expect(text).toContain('kant');
});

it('marca desactualizado a un recolector viejo aunque el servidor lo declare fresco', async () => {
  mockBoth({
    ...BASE,
    collectors: [
      ...BASE.collectors!,
      // stale:false pero 5.400 s de edad contra un umbral de 900: la vista de licencias aplicaba
      // esta regla y la de cuotas no. Gana la estricta.
      { host: 'ws-midas', collector_tenant: 'Pablo', collector_alias: 'quota-collector', captured_at: '2026-07-27T13:00:00.000Z', received_at: '2026-07-27T13:00:01.000Z', age_seconds: 5_400, stale: false, schema_version: 2, app_version: '0.11.4', provider_count: 1, window_count: 1 },
    ],
  });
  renderWithApi(<QuotasPage />);

  const collectors = await screen.findByRole('heading', { level: 2, name: 'Recolectores' }).then((h) => h.closest('section')!);
  expect(within(within(collectors).getByRole('row', { name: /kratos/i })).getByText('FRESCO')).toBeInTheDocument();
  expect(within(within(collectors).getByRole('row', { name: /ws-midas/i })).getByText('DESACTUALIZADO')).toBeInTheDocument();
  // Y se dice arriba, una sola vez, de qué muestra son los números de abajo.
  expect(screen.getByText(/Muestra vieja\./)).toBeInTheDocument();
});

it('sin recolector NO inventa porcentajes: muestra el inventario y declara que no hay consumo', async () => {
  // Éste es el estado REAL de producción: /v3/console/quotas devuelve todo vacío porque el
  // recolector de kratos nunca se apuntó a POST /v3/quotas/samples.
  mockBoth({
    observed_at: '2026-08-06T02:55:00.107Z',
    thresholds: { stale_after_seconds: 900 },
    collectors: [],
    providers: [],
    unbound_groups: [],
    paused_accounts: [],
  });
  renderWithApi(<QuotasPage />);

  await screen.findByRole('heading', { level: 1, name: 'Cuotas y licencias' });

  // UNA sola vez. La causa es la misma para las tres cuentas, así que repetirla en cada tarjeta
  // —que es lo que hacía el `reason` de alcance global— sólo consigue que se lea menos.
  expect(screen.getAllByText(/Ningún recolector reportó/)).toHaveLength(1);

  // El inventario sigue siendo útil: la cuenta y a quién está asignada se ven igual.
  const inventory = panel('Inventario de cuentas');
  expect(inventory).toHaveTextContent('codex-pro-steven');
  expect(inventory).toHaveTextContent('claw-zeus');
  expect(inventory.textContent ?? '').not.toContain('Ningún recolector reportó');
  expect(document.querySelectorAll('.account-notice')).toHaveLength(0);
  // Y el consumo está declarado como ausente, no como cero. (El alcance es el inventario: la
  // tarjeta explicativa del pie cita porcentajes de ejemplo en texto fijo, que no son un dato.)
  expect(inventory.textContent ?? '').not.toMatch(/\d+\s*%/);
});

it('una sonda caída no reaparece como un número: la cuenta queda en interrogante', async () => {
  mockBoth({
    observed_at: '2026-08-06T02:55:00.107Z',
    thresholds: { stale_after_seconds: 900, warn_remaining_percent: 25, critical_remaining_percent: 10 },
    collectors: [{ host: 'kratos', received_at: '2026-08-06T02:54:00.000Z', age_seconds: 60, stale: false }],
    providers: [{
      host: 'kratos',
      provider: 'codex',
      ok: false,
      note: 'el CLI dejó de responder',
      observed_at: '2026-08-06T02:54:00.000Z',
      age_seconds: 60,
      groups: [{ group_key: 'codex', account_id: 'codex-pro-steven', min_remaining_percent: null, windows: [] }],
    }],
    unbound_groups: [],
    paused_accounts: [],
  });
  renderWithApi(<QuotasPage />);

  await screen.findByRole('heading', { level: 1, name: 'Cuotas y licencias' });
  expect(screen.getByText(/Sonda caída\./)).toBeInTheDocument();
  // El motivo aparece en el cartel agregado, en la tarjeta del proveedor y en la cuenta afectada:
  // las tres son lecturas distintas del mismo `ok:false`, ninguna sobra.
  expect(screen.getAllByText(/dejó de responder/).length).toBeGreaterThan(0);

  // El motivo por cuenta SÍ se queda cuando dice algo que el cartel de arriba no dice: que a esta
  // cuenta la dejó sin número la sonda de SU proveedor, y que a esas otras el recolector ni las trajo.
  const notices = [...document.querySelectorAll('.account-notice')].map((n) => n.textContent ?? '');
  expect(notices.filter((text) => text.includes('Sonda caída:'))).toHaveLength(1);
  expect(notices.filter((text) => text.includes('El recolector no reportó esta cuenta'))).toHaveLength(2);

  // La garantía dura: ningún porcentaje inventado para una cuenta cuya sonda murió.
  const inventory = panel('Inventario de cuentas');
  expect(inventory).toHaveTextContent('codex-pro-steven');
  expect(inventory.textContent ?? '').not.toMatch(/\d+\s*%/);
  expect(panel('Proveedores').textContent ?? '').not.toMatch(/\d+\s*%\s*libre/);
});

it('si se cae el consumo, el inventario sigue en pantalla y hay un botón para reintentar', async () => {
  server.use(
    http.get(QUOTAS_URL, () => HttpResponse.json({ error: 'boom', message: 'cuotas caídas' }, { status: 500 })),
    http.get(CONFIG_URL, () => HttpResponse.json(CONFIG)),
  );
  renderWithApi(<QuotasPage />);

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/cuotas caídas/i);
  expect(within(alert).getByRole('button', { name: /reintentar/i })).toBeInTheDocument();
  // Media consola caída no puede apagar la otra media: el inventario no depende de ese endpoint.
  expect(panel('Inventario de cuentas')).toHaveTextContent('codex-pro-steven');
  // Y no se afirma "ningún recolector reportó" cuando lo que pasó es que la respuesta no llegó.
  expect(screen.queryByText(/Ningún recolector reportó/)).not.toBeInTheDocument();
});

it('si se cae el inventario, el consumo sigue en pantalla y lo dice sin listar cuentas vacías', async () => {
  server.use(
    http.get(QUOTAS_URL, () => HttpResponse.json(BASE)),
    http.get(CONFIG_URL, () => HttpResponse.json({ error: 'boom', message: 'inventario caído' }, { status: 500 })),
  );
  renderWithApi(<QuotasPage />);

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/inventario caído/i);
  expect(panel('Proveedores')).toHaveTextContent(/codex/i);
  expect(panel('Inventario de cuentas')).toHaveTextContent(/no se pudo leer/i);
});
