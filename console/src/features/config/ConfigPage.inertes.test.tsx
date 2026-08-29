import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ConfigPage } from './ConfigPage';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { MARCA_INERTE } from './campos-inertes';

/**
 * **That the screen does not lie about what it does.**
 *
 * The catalog only flags columns with no runtime reader: `harness_id`, `home_directory`,
 * `state_directory`, and `harness_definitions.command`.
 *
 * They are not hidden: the server publishes them — hiding a value that exists is another lie. They
 * are FLAGGED, with the reason visible and a citation of where the value that actually rules comes from.
 *
 * Every assertion here comes with its negative control: a flag painted on every column does not
 * distinguish anything, and would be as useless as not having one.
 */

const AGENTES = /agentes y cuentas/i;
const PERMISOS = /^permisos$/i;
const ESPACIOS = /espacios y miembros/i;

type Usuario = ReturnType<typeof userEvent.setup>;

async function irA(user: Usuario, pestana: RegExp) {
  await user.click(await screen.findByRole('tab', { name: pestana }));
}

/** The panel of a collection, by its title. */
function panelDe(titulo: RegExp): HTMLElement {
  const encabezado = screen.getByRole('heading', { name: titulo });
  const panel = encabezado.closest('section') ?? encabezado.closest('div');
  if (!panel) throw new Error(`no encontré el panel de ${String(titulo)}`);
  return panel;
}

/**
 * The mock snapshot brings `harness_definitions` in the shape of the adapters endpoint, which has
 * no `command`. To be able to check the flag on that column, the REAL shape of the table is
 * needed —the one returned by `packages/store/src/configuration.ts:170`.
 */
function conHarnessReal() {
  server.use(http.get('http://localhost/v3/console/config', () => HttpResponse.json({
    revision: 1,
    observed_at: new Date().toISOString(),
    tenants: [{ id: 'Steven', display_name: 'Steven', is_hub: true, enabled: true, created_at: '2026-07-01T10:00:00.000Z' }],
    rooms: [{ tenant_id: 'Steven', id: 'grp.steven', display_name: 'Sala', enabled: true, created_at: '2026-07-01T10:00:00.000Z' }],
    memberships: [{ tenant_id: 'Steven', room_id: 'grp.steven', alias: 'argos', role: 'operator', enabled: true, created_at: '2026-07-01T10:00:00.000Z' }],
    // Edges and role policies are NOT empty on purpose: without rows there are no columns, and a
    // negative control that iterates zero headers approves anything. See the `cabeceras.length`
    // assertion below, which is what blocks that false green.
    acl_edges: [{
      from_tenant: 'Steven', to_tenant: 'Miguel', enabled: true, allow_route: true,
      allow_read: true, allow_control: false, created_at: '2026-07-01T10:00:00.000Z',
    }],
    harness_definitions: [
      { id: 'claude', display_name: 'Claude Code', command: null, capabilities: ['messages.receive'], enabled: true },
    ],
    role_policies: [{
      role: 'operator', allow_route: true, allow_read: true, allow_control: true,
      allow_notify: true, created_at: '2026-07-01T10:00:00.000Z',
    }],
    chain_policies: [], egress_destinations: [],
    agents: [{
      tenant_id: 'Steven', alias: 'argos', harness_id: 'hermes', display_name: 'Argos', enabled: true,
      container_name: 'ctrl-infra', runtime_user: 'dev', home_directory: '/home/dev',
      state_directory: '/var/lib/argos', role_brief: 'Sos argos, el PMO.',
    }],
    provider_accounts: [], alias_routing_ceiling: [], agent_account_bindings: [], revisions: [],
  })));
}

describe('las columnas sin efecto quedan marcadas, no escondidas', () => {
  it('marca las tres columnas de emplazamiento del registro de agentes sin lector runtime', async () => {
    conHarnessReal();
    const user = userEvent.setup();
    renderWithApi(<ConfigPage />);
    await irA(user, AGENTES);

    // The column's accessible name starts with the label and continues with the entire reason (it
    // goes in `sr-only` on purpose). It is anchored to the start: without `^`, "Contenedor" also
    // matches the "Carpeta personal" column, whose reason says "medido dentro del contenedor".
    const registro = panelDe(/agent registry/i);
    for (const rotulo of ['Harness', 'Carpeta personal', 'state_directory']) {
      const cabecera = within(registro).getByRole('columnheader', { name: new RegExp(`^${rotulo}`, 'i') });
      expect(cabecera, `${rotulo} debería estar marcada`).toHaveTextContent(MARCA_INERTE);
    }
  });

  /**
   * NEGATIVE CONTROL. If the flag came out on every column it would distinguish nothing. `Alias`
   * and `Rol declarado` have a proven reader —`selfRoleFromProfile`, packages/store/src/repository/agents.ts:215— and CANNOT carry it.
   */
  it('NO marca las columnas del registro que sí tienen lector', async () => {
    conHarnessReal();
    const user = userEvent.setup();
    renderWithApi(<ConfigPage />);
    await irA(user, AGENTES);

    const registro = panelDe(/agent registry/i);
    for (const rotulo of ['Alias', 'Rol declarado', 'Habilitado', 'Contenedor', 'Usuario']) {
      const cabecera = within(registro).getByRole('columnheader', { name: new RegExp(`^${rotulo}`, 'i') });
      expect(cabecera, `${rotulo} NO debería estar marcada`).not.toHaveTextContent(MARCA_INERTE);
    }
  });

  it('marca el comando del harness, que no lo lee nadie, y dice dónde mirar', async () => {
    conHarnessReal();
    const user = userEvent.setup();
    renderWithApi(<ConfigPage />);
    await irA(user, AGENTES);

    const harneses = panelDe(/harness definitions/i);
    const cabecera = within(harneses).getByRole('columnheader', { name: /comando/i });
    expect(cabecera).toHaveTextContent(MARCA_INERTE);
    // The reason travels in the accessibility tree, not only in a tooltip that needs the mouse to bring it up.
    expect(cabecera).toHaveTextContent(/listAdapters/);
  });

  /**
   * NEGATIVE CONTROL of the entire tab: in "Permisos" not a single column is flagged.
   *
   * The `toBeGreaterThanOrEqual` is NOT decoration. The first version of this assertion iterated
   * `getAllByRole('columnheader')` over a snapshot with `acl_edges: []` and `role_policies` of
   * one row: without rows there are no columns, so the loop ran zero times and PASSED. It was
   * verified by injecting a fake entry into the catalog —`acl_edges.created_at`— and seeing
   * that this test stayed green while the pure-module ones went red. Counting the headers that
   * were actually inspected is what turns the loop into a test.
   */
  it('NO marca ninguna columna en «Permisos»', async () => {
    conHarnessReal();
    const user = userEvent.setup();
    renderWithApi(<ConfigPage />);
    await irA(user, PERMISOS);

    const cabeceras = screen.getAllByRole('columnheader');
    // Edge (merged) + the three permissions + enabled + creation, and the five of `role_policies`.
    expect(cabeceras.length, 'sin cabeceras el bucle de abajo no comprueba nada').toBeGreaterThanOrEqual(10);
    for (const cabecera of cabeceras) {
      expect(cabecera, `${cabecera.textContent} no debería estar marcada`)
        .not.toHaveTextContent(MARCA_INERTE);
    }
  });

  /** And the same control in "Espacios y miembros", which is the default tab. */
  it('NO marca ninguna columna en «Espacios y miembros»', async () => {
    conHarnessReal();
    const user = userEvent.setup();
    renderWithApi(<ConfigPage />);
    await irA(user, ESPACIOS);

    const cabeceras = screen.getAllByRole('columnheader');
    expect(cabeceras.length, 'sin cabeceras el bucle de abajo no comprueba nada').toBeGreaterThanOrEqual(10);
    for (const cabecera of cabeceras) {
      expect(cabecera).not.toHaveTextContent(MARCA_INERTE);
    }
  });
});

describe('la tabla de cómo funciona cada arnés de verdad', () => {
  it('sale en «Agentes y cuentas», con los cuatro arneses y dónde lee cada uno', async () => {
    conHarnessReal();
    const user = userEvent.setup();
    renderWithApi(<ConfigPage />);
    await irA(user, AGENTES);

    const panel = panelDe(/qué lee cada arnés/i);
    expect(within(panel).getByText(/CLAUDE\.md/)).toBeInTheDocument();
    expect(within(panel).getByText(/AGENTS\.md/)).toBeInTheDocument();
    expect(within(panel).getByText(/openclaw\.json/)).toBeInTheDocument();
    // Hermes reads none, and that is SAID: a silent row would read as "we don't know".
    expect(within(panel).getByText(/no lee ningún documento/i)).toBeInTheDocument();
  });

  it('dice que el rol declarado TAMPOCO se escribe acá, y manda a «Perfil» a escribirlo', async () => {
    conHarnessReal();
    const user = userEvent.setup();
    renderWithApi(<ConfigPage />);
    await irA(user, AGENTES);

    const cierre = within(panelDe(/qué lee cada arnés/i)).getByRole('note');
    expect(cierre).toHaveTextContent(/role_brief/);
    expect(cierre).toHaveTextContent(/proyección de sólo lectura/);
    expect(cierre).toHaveTextContent(/«Perfil»/);
  });

  /** NEGATIVE CONTROL: the panel belongs to that tab, not a banner glued to the whole page. */
  it('NO sale en «Permisos»', async () => {
    conHarnessReal();
    const user = userEvent.setup();
    renderWithApi(<ConfigPage />);
    await irA(user, PERMISOS);

    expect(screen.queryByRole('heading', { name: /qué lee cada arnés/i })).not.toBeInTheDocument();
  });
});

/**
 * **The table notice appears with what IS, not with what the catalog knows.**
 *
 * It was spotted LOOKING at the screen in Chrome, not in a test: the mocks gateway publishes
 * `harness_definitions` in the adapters endpoint shape —without `command`— and the notice came
 * out anyway above a table with no flagged columns. A banner announcing what is not there is
 * the same defect this change chases, committed by the fix.
 */
describe('el aviso de columnas sin efecto', () => {
  const AVISO = /no las lee ningún camino de ejecución|no la lee ningún camino de ejecución/i;

  it('sale sobre el registro de agentes, que sí trae columnas marcadas', async () => {
    conHarnessReal();
    const user = userEvent.setup();
    renderWithApi(<ConfigPage />);
    await irA(user, AGENTES);

    expect(within(panelDe(/agent registry/i)).getByText(AVISO)).toBeInTheDocument();
  });

  /**
   * NEGATIVE CONTROL — the broken case: SAME `harness_definitions` collection, but a
   * gateway that does not publish `command`. Without flagging anything, there is nothing to announce.
   */
  it('NO sale sobre una tabla cuyo gateway no publica ninguna columna inerte', async () => {
    server.use(http.get('http://localhost/v3/console/config', () => HttpResponse.json({
      revision: 1,
      observed_at: new Date().toISOString(),
      tenants: [], rooms: [], memberships: [], acl_edges: [],
      // The shape returned by `GET /v3/console/adapters`: without `command`, as in production today.
      harness_definitions: [{ id: 'claude', label: 'Claude Code', capabilities: ['messages.receive'], state: 'available' }],
      role_policies: [], chain_policies: [], egress_destinations: [],
      agents: [], provider_accounts: [], alias_routing_ceiling: [], agent_account_bindings: [],
      revisions: [],
    })));
    const user = userEvent.setup();
    renderWithApi(<ConfigPage />);
    await irA(user, AGENTES);

    const harneses = panelDe(/harness definitions/i);
    // The table is populated —if it were empty this would pass without checking anything—…
    expect(within(harneses).getAllByRole('columnheader').length).toBeGreaterThanOrEqual(3);
    // …and yet there is neither a flag nor a notice.
    expect(within(harneses).queryByText(AVISO)).not.toBeInTheDocument();
    for (const cabecera of within(harneses).getAllByRole('columnheader')) {
      expect(cabecera).not.toHaveTextContent(MARCA_INERTE);
    }
  });
});
