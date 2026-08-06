import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { LicensesPage } from './LicensesPage';

const CONFIG = 'http://localhost/v3/console/config';
const QUOTAS = 'http://localhost/v3/console/quotas';

/** El inventario real que publica producción hoy, recortado a lo que usa esta vista. */
const REAL_CONFIG = {
  revision: 42,
  observed_at: '2026-08-06T02:55:00.000Z',
  agents: [
    { tenant_id: 'Steven', alias: 'zeus', harness_id: 'claude', enabled: true, container_name: 'claw-zeus' },
    { tenant_id: 'Steven', alias: 'kant', harness_id: 'codex', enabled: true, container_name: 'claw-kant' },
  ],
  provider_accounts: [
    {
      id: 'claude-max-saldantia',
      provider: 'claude',
      payer_tenant_id: 'Steven',
      label: 'Claude Max — saldantia.sas',
      shared_with_pool: true,
      enabled: true,
      external_account_id: 'saldantia.sas@gmail.com',
      credential_ref_kind: 'file',
    },
  ],
  agent_account_bindings: [
    { tenant_id: 'Steven', agent_alias: 'zeus', account_id: 'claude-max-saldantia', priority: 0, enabled: true },
  ],
  alias_routing_ceiling: [],
};

it('sin recolector NO inventa porcentajes: muestra el inventario y declara que no hay consumo', async () => {
  // Éste es el estado REAL de producción: /v3/console/quotas devuelve todo vacío porque el
  // recolector de kratos nunca se apuntó a POST /v3/quotas/samples.
  server.use(
    http.get(CONFIG, () => HttpResponse.json(REAL_CONFIG)),
    http.get(QUOTAS, () => HttpResponse.json({
      observed_at: '2026-08-06T02:55:00.107Z',
      thresholds: { stale_after_seconds: 900 },
      collectors: [],
      providers: [],
      unbound_groups: [],
      paused_accounts: [],
    })),
  );
  renderWithApi(<LicensesPage />);

  await screen.findByRole('heading', { level: 1, name: /licencias y consumo/i });
  const page = document.body.textContent ?? '';

  // El inventario sigue siendo útil: la cuenta y a quién está asignada se ven igual.
  expect(page).toContain('claude-max-saldantia');
  expect(page).toContain('zeus');
  expect(page).toContain('claw-zeus');

  // Y el consumo está declarado como ausente, no como cero.
  expect(page).toMatch(/ningún recolector reportó/i);
  expect(page).not.toMatch(/\b0\s*%/);
});

it('una sonda caída no reaparece como un número: la cuenta queda en interrogante', async () => {
  server.use(
    http.get(CONFIG, () => HttpResponse.json(REAL_CONFIG)),
    http.get(QUOTAS, () => HttpResponse.json({
      observed_at: '2026-08-06T02:55:00.107Z',
      thresholds: { stale_after_seconds: 900, warn_remaining_percent: 25, critical_remaining_percent: 10 },
      collectors: [{ host: 'kratos', received_at: '2026-08-06T02:54:00.000Z', age_seconds: 60, stale: false }],
      providers: [{
        host: 'kratos',
        provider: 'claude',
        ok: false,
        note: 'el CLI dejó de responder',
        observed_at: '2026-08-06T02:54:00.000Z',
        age_seconds: 60,
        groups: [{ group_key: 'weekly', account_id: 'claude-max-saldantia', min_remaining_percent: null, windows: [] }],
      }],
      unbound_groups: [],
      paused_accounts: [],
    })),
  );
  renderWithApi(<LicensesPage />);

  await screen.findByRole('heading', { level: 1, name: /licencias y consumo/i });
  const page = document.body.textContent ?? '';
  expect(page).toContain('claude-max-saldantia');
  expect(page).toMatch(/sonda caída/i);
  expect(page).toMatch(/dejó de responder/i);
  // La garantía dura: ningún porcentaje inventado para una cuenta cuya sonda murió.
  expect(page).not.toMatch(/\d+\s*%/);
});
