import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { FleetActivitySnapshot } from '../../api/types';
import { mockActivity, topology } from '../../mocks/data';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { LiveFleetPage } from './LiveFleetPage';

function conActividad(snapshot: FleetActivitySnapshot) {
  server.use(http.get('http://localhost/v3/console/activity', () => HttpResponse.json(snapshot)));
}

beforeEach(() => {
  window.history.replaceState({}, '', '/live');
});

// ================================================================================================
// D1 · who asked for the work, seen from the screen and not from the pure function.
// ================================================================================================

describe('who asked for each request', () => {
  it('a delegation inherited from a bridge is NOT announced as "a person, by telegram"', async () => {
    // The fixture carries the real case: an agent receives a delivery whose `origin_adapter`
    // still says 'telegram' because `origin` is copied byte-by-byte on every hop. The map draws
    // the arrow between two agents and the drawer said, about the SAME delivery, that a person
    // had asked for it.
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    await user.click(await screen.findByRole('row', { name: /kant/i }));
    const cajon = await screen.findByRole('complementary', { name: /detalle de kant/i });
    await user.click(within(cajon).getByRole('tab', { name: 'Entregas' }));

    // The three deliveries for this agent come from other fleet agents: none is a human request.
    expect(within(cajon).queryByText(/una persona, por telegram/i)).not.toBeInTheDocument();
    expect(within(cajon).getByText(/argos \(Steven\), otro agente/)).toBeInTheDocument();
    expect(within(cajon).getAllByText(/zeus \(Steven\), otro agente/).length).toBe(2);
  });

  it('the real bridge is named: this agent receives by telegram what its owner writes', async () => {
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    await user.click(await screen.findByRole('row', { name: /hegel/i }));
    const cajon = await screen.findByRole('complementary', { name: /detalle de hegel/i });
    await user.click(within(cajon).getByRole('tab', { name: 'Entregas' }));

    expect(within(cajon).getByText(/una persona, por telegram/i)).toBeInTheDocument();
  });
});

describe('absorbed from the menu', () => {
  it('"Permisos y salas" brings both ACL tables without re-fetching topology', async () => {
    let lecturas = 0;
    server.use(http.get('http://localhost/v3/console/topology', () => {
      lecturas += 1;
      return HttpResponse.json(topology);
    }));
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    // The fold summary says HOW MUCH is behind it: without it the fold is a blind door.
    await user.click(screen.getByText(/^Permisos y salas · /));

    expect(await screen.findByLabelText('Aristas de control de acceso')).toBeInTheDocument();
    expect(screen.getAllByText('Tenant').length).toBeGreaterThan(0);
    // The map and the fold share the same `useResource('live-topology')`.
    expect(lecturas).toBe(1);
  });
});

// ================================================================================================
// D5, D6, D7 · the Client selector. The previous suite had twenty tests and NOT ONCE the word
// 'tenant': scoping by client was a requirement and was exactly the only thing untested.
// ================================================================================================

/** Aliases the map is drawing, with their tenant in front. */
function dibujados(): string[] {
  return [...document.querySelectorAll('.lhg-bot')]
    .map((nodo) => nodo.getAttribute('data-agent-key') ?? '');
}

async function elegirCliente(user: ReturnType<typeof userEvent.setup>, tenant: string) {
  await user.selectOptions(screen.getByLabelText(/^Cliente/), tenant);
}

describe('the Client selector', () => {
  it('scopes THE MAP, not only the verdict: not a single bot from another client stays drawn', async () => {
    // D5. The map received the full `views` and the full topology, so with Client = the chosen
    // tenant the bots of the other four clients kept being drawn, with full balloons and with
    // clicks that opened the drawer with THEIR deliveries.
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    await waitFor(() => { expect(dibujados().length).toBeGreaterThan(5); });
    expect(dibujados().some((key) => key.startsWith('Steven/'))).toBe(true);

    await elegirCliente(user, 'Miguel');

    await waitFor(() => {
      const claves = dibujados();
      expect(claves.length).toBeGreaterThan(0);
      expect(claves.every((key) => key.startsWith('Miguel/'))).toBe(true);
    });
  });

  it('declares the scope on screen: hiding bots without saying so is lying by omission', async () => {
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    expect(screen.queryByTestId('aviso-recorte')).not.toBeInTheDocument();

    await elegirCliente(user, 'Miguel');

    const aviso = await screen.findByTestId('aviso-recorte');
    expect(aviso).toHaveTextContent(/Mapa acotado a/);
    expect(aviso).toHaveTextContent(/11 alias de otros clientes/);
  });

  it('the header cannot claim a scope that the drawing contradicts', async () => {
    // D6. It said "Los N alias que podes ver" with N already scoped while the map kept drawing
    // the fifteen. The sentence and the drawing must talk about the same set.
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    await elegirCliente(user, 'Miguel');

    const descripcion = await screen.findByText(/Los 4 alias de Miguel/);
    expect(descripcion).toBeInTheDocument();
    await waitFor(() => { expect(dibujados().every((key) => key.startsWith('Miguel/'))).toBe(true); });
  });

  it('the triage tally counts the SCOPE, not the whole fleet', async () => {
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    // `:not(.is-unreported)` leaves out the two DERIVATION chips: they are not states, and adding
    // them to the tally would mix "how many aliases are in each state" with "how many
    // registrations are half-done".
    const sumaChips = () => [...document.querySelectorAll('.live-tally-chip:not(.is-unreported) strong')]
      .reduce((total, chip) => total + Number(chip.textContent), 0);
    await waitFor(() => { expect(sumaChips()).toBe(15); });

    await elegirCliente(user, 'Miguel');
    // The four aliases of Miguel that activity reports.
    await waitFor(() => { expect(sumaChips()).toBe(4); });
  });

  it('a client about which activity reports NOTHING does not go green: it shows "I don\'t know"', async () => {
    // D2 seen from the page: the reading arrived fresh and perfect, and does not credit
    // anything about that client. Before this gave "Todo en orden · 0 conectados · 0
    // trabajando".
    const user = userEvent.setup();
    const soloSteven = mockActivity();
    conActividad({
      ...soloSteven,
      agents: (soloSteven.agents ?? []).filter((agente) => agente.tenant_id === 'Steven'),
    });
    renderWithApi(<LiveFleetPage />);

    const banda = await screen.findByLabelText('Veredicto de la flota');
    await elegirCliente(user, 'Miguel');

    await waitFor(() => { expect(banda).toHaveAttribute('data-tone', 'desconocido'); });
    expect(banda).not.toHaveAttribute('data-tone', 'ok');
    expect(within(banda).getByText(/no hay ni un alias que mirar/i)).toBeInTheDocument();
  });

  it('"Permisos y salas" is also scoped: otherwise it would count rooms the header says it does not show', async () => {
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    await elegirCliente(user, 'Miguel');
    // The fold summary says HOW MUCH is behind it: without it the fold is a blind door.
    await user.click(screen.getByText(/^Permisos y salas · /));

    const salas = await screen.findByLabelText('Aristas de control de acceso');
    expect(salas).toBeInTheDocument();
    expect(screen.queryByText('grp.pablo')).not.toBeInTheDocument();
    expect(screen.getAllByText('grp.miguel').length).toBeGreaterThan(0);
  });

  it('the search highlight does NOT switch off when hovering another bot', async () => {
    // D5, second half: `focusKey` won over `spotlight` in an exclusive if/else, so hovering any
    // node erased the filter highlight and left the map as if none were applied.
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    await user.type(screen.getByLabelText('Buscar un alias'), 'salva');

    const salva = await waitFor(() => {
      const nodo = document.querySelector('[data-agent-key="Isa/salva"]');
      expect(nodo).toBeTruthy();
      expect(nodo?.classList.contains('is-dim')).toBe(false);
      return nodo as SVGGElement;
    });

    // `kant` has no relation with `salva`: under the old rule, focusing it left salva out of
    // the active set and therefore dimmed.
    const kant = document.querySelector('[data-agent-key="Steven/kant"]');
    expect(kant).not.toBeNull();
    if (!kant) throw new Error('kant node not found');
    await user.hover(kant);

    expect(salva.classList.contains('is-dim')).toBe(false);
    expect(kant.classList.contains('is-dim')).toBe(false);
  });
});

// ================================================================================================
// D10 · a failure of GET /v3/console/topology must be visible and must be retryable.
// ================================================================================================

describe('the topology is down', () => {
  it('says so, and does not disguise itself as "no rooms configured"', async () => {
    conActividad(mockActivity());
    server.use(http.get('http://localhost/v3/console/topology', () =>
      HttpResponse.json({ error: 'boom', message: 'topología caída' }, { status: 500 })));

    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    // Appears twice on purpose: in the bar (where the retry lives) and in the map gap (where
    // the operator is looking when they notice there is no drawing).
    expect(await screen.findAllByText(/No se pudo leer la topología/)).toHaveLength(2);
    // And NOT the banner of "the control plane has not yet reported any room", which asserts
    // an empty configuration from a reading that failed.
    expect(screen.queryByText(/todavía no informó ninguna sala/)).not.toBeInTheDocument();
  });

  it('can be retried without reloading the browser', async () => {
    const user = userEvent.setup();
    conActividad(mockActivity());
    let falla = true;
    server.use(http.get('http://localhost/v3/console/topology', () => (falla
      ? HttpResponse.json({ error: 'boom', message: 'topología caída' }, { status: 500 })
      : HttpResponse.json(topology))));

    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    await screen.findAllByText(/No se pudo leer la topología/);
    expect(document.querySelector('.lhg-svg')).toBeNull();

    falla = false;
    await user.click(screen.getAllByRole('button', { name: /reintentar la topología/i })[0]);

    await waitFor(() => { expect(document.querySelector('.lhg-svg')).toBeTruthy(); });
    expect(screen.queryAllByText(/No se pudo leer la topología/)).toHaveLength(0);
  });

  it('"Refrescar ahora" reads both sources again, not just activity', async () => {
    const user = userEvent.setup();
    conActividad(mockActivity());
    let lecturas = 0;
    server.use(http.get('http://localhost/v3/console/topology', () => {
      lecturas += 1;
      return HttpResponse.json(topology);
    }));

    renderWithApi(<LiveFleetPage />);
    await screen.findByLabelText('Veredicto de la flota');
    await waitFor(() => { expect(lecturas).toBe(1); });

    await user.click(screen.getByRole('button', { name: /refrescar ahora/i }));
    await waitFor(() => { expect(lecturas).toBe(2); });
  });
});

describe('prefers-reduced-motion', () => {
  function conMatchMedia(reduce: boolean) {
    // jsdom does not implement matchMedia. Install one that returns what the test needs, and
    // preserve the real signature (addEventListener included) so we do not green-light a false
    // positive with a stub more permissive than the browser.
    window.matchMedia = (query: string) => ({
      matches: reduce && query.includes('reduce'),
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    });
  }

  afterEach(() => {
    Reflect.deleteProperty(window, 'matchMedia');
  });

  it('switches SMIL off, which CSS CANNOT switch off', async () => {
    // A5. `<animateMotion>` is not a CSS animation: `prefers-reduced-motion` does not reach it
    // from the stylesheet. It has to be asked from JS or the view violates what the rest of the
    // console already respects.
    conMatchMedia(true);
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    await waitFor(() => { expect(document.querySelectorAll('.lhg-flow-line').length).toBeGreaterThan(0); });

    expect(document.querySelectorAll('animateMotion')).toHaveLength(0);
    // But the dot does NOT disappear: it stays fixed halfway along the curve. A live arrow and
    // a dead one must remain distinguishable for whoever asked for less motion, not less
    // information.
    const puntos = [...document.querySelectorAll('.lhg-flow-dot')];
    expect(puntos.length).toBeGreaterThan(0);
    expect(puntos[0].getAttribute('cx')).toBeTruthy();
  });

  it('without the setting on, the dot does travel: that is what conveys the DIRECTION of the delegation', async () => {
    conMatchMedia(false);
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    await waitFor(() => { expect(document.querySelectorAll('animateMotion').length).toBeGreaterThan(0); });
    expect(document.querySelector('.lhg-flow-dot')?.getAttribute('cx')).toBeNull();
  });
});
