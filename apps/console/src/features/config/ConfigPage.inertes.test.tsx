import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ConfigPage } from './ConfigPage';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { MARCA_INERTE } from './campos-inertes';

/**
 * **Que la pantalla no mienta sobre lo que hace.**
 *
 * El encargo de Steven: «evitando mantener una lógica antigua basada en campos que luego no tienen
 * efecto real». La auditoría encontró seis: las cinco columnas de emplazamiento de `agents`
 * —`harness_id`, `container_name`, `runtime_user`, `home_directory`, `state_directory`— y
 * `harness_definitions.command`. Ninguna la obedece ningún camino de ejecución.
 *
 * No se esconden: el servidor las publica y esconder un dato que hay es otra forma de mentir. Se
 * MARCAN, con el motivo a la vista y la cita de dónde sale el valor que sí manda.
 *
 * Cada aserto de acá viene con su control negativo: una marca que se pinta en todas las columnas no
 * distingue nada, y sería tan inútil como no tenerla.
 */

const AGENTES = /agentes y cuentas/i;
const PERMISOS = /^permisos$/i;
const ESPACIOS = /espacios y miembros/i;

type Usuario = ReturnType<typeof userEvent.setup>;

async function irA(user: Usuario, pestana: RegExp) {
  await user.click(await screen.findByRole('tab', { name: pestana }));
}

/** El panel de una colección, por su título. */
function panelDe(titulo: RegExp): HTMLElement {
  const encabezado = screen.getByRole('heading', { name: titulo });
  const panel = encabezado.closest('section') ?? encabezado.closest('div');
  if (!panel) throw new Error(`no encontré el panel de ${String(titulo)}`);
  return panel as HTMLElement;
}

/**
 * El snapshot del mock trae `harness_definitions` con la forma del endpoint de adaptadores, que no
 * tiene `command`. Para poder comprobar la marca sobre esa columna hace falta la forma REAL de la
 * tabla, la que devuelve `packages/store/src/configuration.ts:170`.
 */
function conHarnessReal() {
  server.use(http.get('http://localhost/v3/console/config', () => HttpResponse.json({
    revision: 1,
    observed_at: new Date().toISOString(),
    tenants: [{ id: 'Steven', display_name: 'Steven', is_hub: true, enabled: true, created_at: '2026-07-01T10:00:00.000Z' }],
    rooms: [{ tenant_id: 'Steven', id: 'grp.steven', display_name: 'Sala', enabled: true, created_at: '2026-07-01T10:00:00.000Z' }],
    memberships: [{ tenant_id: 'Steven', room_id: 'grp.steven', alias: 'argos', role: 'operator', enabled: true, created_at: '2026-07-01T10:00:00.000Z' }],
    // Las aristas y las políticas de rol NO van vacías a propósito: sin filas no hay columnas, y
    // un control negativo que recorre cero cabeceras aprueba cualquier cosa. Ver el aserto de
    // `cabeceras.length` más abajo, que es lo que impide ese verde falso.
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
  it('marca las cinco columnas de emplazamiento del registro de agentes', async () => {
    conHarnessReal();
    const user = userEvent.setup();
    renderWithApi(<ConfigPage />);
    await irA(user, AGENTES);

    // El nombre accesible de la cabecera arranca por el rótulo y sigue con el motivo entero (va en
    // `sr-only` a propósito). Se ancla al principio: sin el `^`, «Contenedor» casa también con la
    // columna «Carpeta personal», cuyo motivo dice «medido dentro del contenedor».
    const registro = panelDe(/agent registry/i);
    for (const rotulo of ['Harness', 'Contenedor', 'Usuario', 'Carpeta personal', 'state_directory']) {
      const cabecera = within(registro).getByRole('columnheader', { name: new RegExp(`^${rotulo}`, 'i') });
      expect(cabecera, `${rotulo} debería estar marcada`).toHaveTextContent(MARCA_INERTE);
    }
  });

  /**
   * CONTROL NEGATIVO. Si la marca saliera en todas las columnas no distinguiría nada. `Alias` y
   * `Rol declarado` tienen lector probado —`selfRoleBrief`, repository.ts:1821— y NO pueden llevarla.
   */
  it('NO marca las columnas del registro que sí tienen lector', async () => {
    conHarnessReal();
    const user = userEvent.setup();
    renderWithApi(<ConfigPage />);
    await irA(user, AGENTES);

    const registro = panelDe(/agent registry/i);
    for (const rotulo of ['Alias', 'Rol declarado', 'Habilitado']) {
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
    // El motivo viaja en el árbol accesible, no sólo en un globo que hay que provocar con el ratón.
    expect(cabecera).toHaveTextContent(/repository\.ts:7566/);
  });

  /**
   * CONTROL NEGATIVO de la pestaña entera: en «Permisos» no hay una sola columna marcada.
   *
   * El `toBeGreaterThanOrEqual` NO es decoración. La primera versión de este aserto recorría
   * `getAllByRole('columnheader')` sobre un snapshot con `acl_edges: []` y `role_policies` de una
   * fila: sin filas no hay columnas, así que el bucle daba cero vueltas y APROBABA. Se comprobó
   * metiendo una entrada falsa en el catálogo —`acl_edges.created_at`— y viendo que esta prueba
   * seguía verde mientras las del módulo puro se ponían rojas. Contar las cabeceras que de verdad
   * se inspeccionaron es lo que convierte el bucle en una prueba.
   */
  it('NO marca ninguna columna en «Permisos»', async () => {
    conHarnessReal();
    const user = userEvent.setup();
    renderWithApi(<ConfigPage />);
    await irA(user, PERMISOS);

    const cabeceras = screen.getAllByRole('columnheader');
    // Arista (fundida) + los tres permisos + habilitado + alta, y las cinco de `role_policies`.
    expect(cabeceras.length, 'sin cabeceras el bucle de abajo no comprueba nada').toBeGreaterThanOrEqual(10);
    for (const cabecera of cabeceras) {
      expect(cabecera, `${cabecera.textContent ?? ''} no debería estar marcada`)
        .not.toHaveTextContent(MARCA_INERTE);
    }
  });

  /** Y el mismo control en «Espacios y miembros», que es la pestaña por defecto. */
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
    // Hermes no lee ninguno, y eso se DICE: una fila muda se leería como «no lo sabemos».
    expect(within(panel).getByText(/no lee ningún documento/i)).toBeInTheDocument();
  });

  it('dice que el rol declarado es lo único que esta pantalla gobierna de eso', async () => {
    conHarnessReal();
    const user = userEvent.setup();
    renderWithApi(<ConfigPage />);
    await irA(user, AGENTES);

    const panel = panelDe(/qué lee cada arnés/i);
    expect(within(panel).getByText(/role_brief/)).toBeInTheDocument();
  });

  /** CONTROL NEGATIVO: el panel es de esa pestaña, no un cartel pegado a toda la página. */
  it('NO sale en «Permisos»', async () => {
    conHarnessReal();
    const user = userEvent.setup();
    renderWithApi(<ConfigPage />);
    await irA(user, PERMISOS);

    expect(screen.queryByRole('heading', { name: /qué lee cada arnés/i })).not.toBeInTheDocument();
  });
});

/**
 * **El aviso de la tabla aparece con lo que HAY, no con lo que el catálogo conoce.**
 *
 * Se vio MIRANDO la pantalla en Chrome, no en una prueba: el gateway de los mocks publica
 * `harness_definitions` con la forma del endpoint de adaptadores —sin `command`— y el aviso salía
 * igual encima de una tabla donde no había ni una columna marcada. Un cartel que anuncia algo que
 * no está es el mismo defecto que este cambio persigue, cometido por el arreglo.
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
   * CONTROL NEGATIVO, y es el caso que se vio roto: MISMA colección `harness_definitions`, pero un
   * gateway que no publica `command`. Sin marcar nada, no hay nada que anunciar.
   */
  it('NO sale sobre una tabla cuyo gateway no publica ninguna columna inerte', async () => {
    server.use(http.get('http://localhost/v3/console/config', () => HttpResponse.json({
      revision: 1,
      observed_at: new Date().toISOString(),
      tenants: [], rooms: [], memberships: [], acl_edges: [],
      // La forma que devuelve `GET /v3/console/adapters`: sin `command`, como en producción hoy.
      harness_definitions: [{ id: 'claude', label: 'Claude Code', capabilities: ['messages.receive'], state: 'available' }],
      role_policies: [], chain_policies: [], egress_destinations: [],
      agents: [], provider_accounts: [], alias_routing_ceiling: [], agent_account_bindings: [],
      revisions: [],
    })));
    const user = userEvent.setup();
    renderWithApi(<ConfigPage />);
    await irA(user, AGENTES);

    const harneses = panelDe(/harness definitions/i);
    // La tabla está poblada —si estuviera vacía esto aprobaría sin comprobar nada—…
    expect(within(harneses).getAllByRole('columnheader').length).toBeGreaterThanOrEqual(3);
    // …y aun así no hay ni marca ni aviso.
    expect(within(harneses).queryByText(AVISO)).not.toBeInTheDocument();
    for (const cabecera of within(harneses).getAllByRole('columnheader')) {
      expect(cabecera).not.toHaveTextContent(MARCA_INERTE);
    }
  });
});
