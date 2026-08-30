/**
 * The role meter, seen the way the operator reaches it.
 *
 * `role_summary` admits 4000 characters, but the projection to `role_brief` and the `self_role` of
 * every delivery cut at 1200: what goes past is saved, and the agent never reads it. The meter
 * says so, and there was already a test proving the COMPONENT renders the warning. That is not the
 * same question as whether the warning is reachable: the field it hangs off is disabled unless the
 * runtime is verified and current, so it is possible to render the warning in a test and still
 * have nobody able to trip it on the real screen.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { AgentPerfil } from '../../api/types';
import { beforeEach, expect, it } from 'vitest';
import { mockActivity } from '../../mocks/data';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { LiveFleetPage } from './LiveFleetPage';

const SHA = 'a'.repeat(64);

function perfilEditable(overrides: Partial<AgentPerfil> = {}) {
  return {
    tenant_id: 'Steven', alias: 'kant', agent_enabled: true, exists: true, publicado: true,
    revision: 4, applied_revision: 4, runtime_state: 'applied', harness: 'codex',
    runtime_verification: {
      state: 'current', generation: 'gen-4', container_id: 'ws-kant',
      observed_at: '2026-08-26T00:00:00Z',
      documents: [{
        name: 'AGENTS.md', path: '/home/kant/.codex/AGENTS.md',
        expected_sha: SHA, observed_sha: SHA, expected_bytes: 0, observed_bytes: 0, current: true,
      }],
    },
    runtime_adoption: {
      evidence: 'adapter_delivery', revision: 4, generation: 'gen-4',
      adopted_at: '2026-08-26T00:01:00Z',
      documents: [{ name: 'AGENTS.md', path: '/home/kant/.codex/AGENTS.md', sha: SHA }],
    },
    perfil: {
      purpose: 'Hub de la flota.', role_summary: '', human_brief: null,
      responsibilities: [], restrictions: [], tools: [], operating_rules: [],
    },
    limites: { purpose: 2_000, role_summary: 4_000, item: 1_000, items: 64, total: 24_000 },
    medida: { unidades: 0, tope: 24_000 },
    base: 'runtime-medido',
    ficheros: [{ nombre: 'AGENTS.md', politica: 'bloque-gestionado', texto: '', unidades: 0 }],
    ...overrides,
  };
}

beforeEach(() => {
  window.history.replaceState({}, '', '/live?agente=Steven%2Fkant&pestana=perfil');
  server.use(
    http.get('*/v3/console/activity', () => HttpResponse.json(mockActivity())),
    http.get('*/v3/console/tenants/:tenantId/agents/:alias/perfil', () => HttpResponse.json(perfilEditable())),
  );
});

/** The tab reached by the deep link the console already supports, not by mounting the component. */
async function abrirPerfilDeKant() {
  const user = userEvent.setup();
  renderWithApi(<div className="app-shell"><LiveFleetPage /></div>);
  const cajon = await screen.findByRole('complementary', { name: /detalle de kant/i });
  await within(cajon).findByText(/Le llega al agente/i);
  return { user, cajon };
}

it('el campo de rol se puede escribir de verdad en el flujo real, no sólo en el componente', async () => {
  const { cajon } = await abrirPerfilDeKant();
  const campos = within(cajon).getAllByRole('textbox');
  const rol = campos.find((campo) => campo.parentElement?.textContent.includes('Le llega al agente'));
  expect(rol, 'el campo con el medidor tiene que existir').toBeDefined();
  expect(rol).toBeEnabled();
});

it('pasado de 1200 el aviso SE VE en el cajón, escrito en el campo real', async () => {
  const { user, cajon } = await abrirPerfilDeKant();
  const rol = within(cajon).getAllByRole('textbox')
    .find((campo) => campo.parentElement?.textContent.includes('Le llega al agente'));
  if (!rol) throw new Error('no hay campo de rol con medidor');

  await user.click(rol);
  await user.paste('a'.repeat(1300));

  await waitFor(() => {
    expect(within(cajon).getByRole('alert')).toHaveTextContent(/Pasado de 1200/i);
  });
  expect(within(cajon).getByText(/1300 puntos de código · 1300 unidades UTF-16 \/ 1200/i)).toBeInTheDocument();
});

/* Without this the previous case proves nothing: an alert that is always on the screen would
   satisfy it just the same. */
it('🔴 CONTROL NEGATIVO: con 1200 justos no hay aviso ninguno', async () => {
  const { user, cajon } = await abrirPerfilDeKant();
  const rol = within(cajon).getAllByRole('textbox')
    .find((campo) => campo.parentElement?.textContent.includes('Le llega al agente'));
  if (!rol) throw new Error('no hay campo de rol con medidor');

  await user.click(rol);
  await user.paste('a'.repeat(1200));

  await waitFor(() => {
    expect(within(cajon).getByText(/1200 puntos de código/i)).toBeInTheDocument();
  });
  expect(within(cajon).queryByText(/Pasado de 1200/i)).not.toBeInTheDocument();
});

/**
 * The other half of the question. When the runtime is not verified the field is disabled, so the
 * operator cannot type past 1200 — but a `role_summary` already over the limit is exactly what
 * brings them to this screen: their agent is not reading the end of its role. The diagnosis has to
 * be legible without being able to edit, or the screen sends them away with nothing.
 */
it('con el campo apagado por runtime sin verificar, un rol ya pasado SIGUE avisando', async () => {
  server.use(http.get('*/v3/console/tenants/:tenantId/agents/:alias/perfil', () => HttpResponse.json(
    perfilEditable({
      runtime_state: 'runtime_unverified',
      perfil: {
        purpose: 'Hub de la flota.', role_summary: 'b'.repeat(1300), human_brief: null,
        responsibilities: [], restrictions: [], tools: [], operating_rules: [],
      },
    }),
  )));
  const { cajon } = await abrirPerfilDeKant();

  const rol = within(cajon).getAllByRole('textbox')
    .find((campo) => campo.parentElement?.textContent.includes('Le llega al agente'));
  expect(rol).toBeDisabled();
  expect(within(cajon).getByText(/1300 puntos de código · 1300 unidades UTF-16 \/ 1200/i)).toBeInTheDocument();
  expect(within(cajon).getAllByRole('alert').map((a) => a.textContent).join(' '))
    .toMatch(/Pasado de 1200/i);
});
