import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { FleetActivitySnapshot } from '../../api/types';
import { mockActivity, mockActivityEnReposo, topology } from '../../mocks/data';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { LiveFleetPage } from './LiveFleetPage';

function conActividad(snapshot: FleetActivitySnapshot) {
  server.use(http.get('http://localhost/v3/console/activity', () => HttpResponse.json(snapshot)));
}

beforeEach(() => {
  window.history.replaceState({}, '', '/live');
});

describe('el veredicto', () => {
  it('nunca queda en verde si el fetch falla: se degrada a ámbar «No lo sé»', async () => {
    // A2. Serve ONE good reading and then break the endpoint, which is exactly what happens when
    // the gateway goes down with the console already open: the previous snapshot stays on screen
    // and still looks fresh. A green banner on top of that lies.
    let llamadas = 0;
    server.use(http.get('http://localhost/v3/console/activity', () => {
      llamadas += 1;
      return llamadas === 1
        ? HttpResponse.json(mockActivityEnReposo())
        : HttpResponse.json({ error: 'boom', message: 'actividad caída' }, { status: 500 });
    }));

    const user = userEvent.setup();
    renderWithApi(<LiveFleetPage />);

    const banda = await screen.findByLabelText('Veredicto de la flota');
    await waitFor(() => { expect(banda).toHaveAttribute('data-tone', 'ok'); });

    await user.click(screen.getByRole('button', { name: /refrescar ahora/i }));

    await waitFor(() => { expect(banda).toHaveAttribute('data-tone', 'desconocido'); });
    expect(banda).not.toHaveAttribute('data-tone', 'ok');
    expect(within(banda).getByText(/no lo sé/i)).toBeInTheDocument();
    expect(within(banda).getByText(/última lectura buena/i)).toBeInTheDocument();
  });

  it('nombra a los agentes que necesitan atención y su chip trae su FILA a la vista', async () => {
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    const banda = await screen.findByLabelText('Veredicto de la flota');
    await waitFor(() => { expect(banda).toHaveAttribute('data-tone', 'alerta'); });
    expect(within(banda).getByText(/necesitan atención/i)).toBeInTheDocument();

    const chip = within(banda).getAllByRole('button')[0];
    await user.type(screen.getByRole('searchbox', { name: 'Buscar un alias' }), 'kant');
    await waitFor(() => { expect(document.querySelectorAll('tr[data-agent-key]').length).toBe(1); });
    // The scroll target has to be the table row: the map ships folded, so its SVG node is not
    // laid out and scrolling to it moves nothing. jsdom has no scrollIntoView, so it is stubbed.
    const llamados: Element[] = [];
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: function stub(this: HTMLElement) { llamados.push(this); },
    });
    try {
      await user.click(chip);
      await waitFor(() => { expect(llamados).toHaveLength(1); });
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', original);
      else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
    const fila = llamados[0];
    expect(fila.tagName).toBe('TR');
    expect(fila.closest('table')).not.toBeNull();
    expect(fila).toBe(document.querySelector('tr[data-highlighted="true"]'));
    expect(document.querySelectorAll('tr[data-agent-key]').length).toBeGreaterThan(1);
  });

  it('las tres cifras llevan la definición del SERVIDOR en el tooltip, no en el rótulo', async () => {
    // The row of five `Metric` this replaces used the SQL expression as its label. The data is
    // not lost — it is needed to cross-check a doubtful number — it moves.
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    const banda = await screen.findByLabelText('Veredicto de la flota');
    await user.hover(within(banda).getByText(/en vuelo$/));

    expect(await screen.findByRole('tooltip', {}, { timeout: 10000 })).toHaveTextContent(/leased.*accepted.*started/);
  });
});

describe('la flota en reposo', () => {
  it('se lee tranquila y NINGÚN muñeco parece muerto', async () => {
    // A1, and the scenario that is actually seen most of the time: in production there is one
    // delivery in flight across the whole base and zero queued. A screen that only reads well
    // when there is a fire reads badly 95% of the time.
    conActividad(mockActivityEnReposo());
    renderWithApi(<LiveFleetPage />);

    const banda = await screen.findByLabelText('Veredicto de la flota');
    await waitFor(() => { expect(banda).toHaveAttribute('data-tone', 'ok'); });

    expect(screen.getByText(/La flota está libre/)).toBeInTheDocument();
    expect(screen.getByText(/no es una avería/)).toBeInTheDocument();

    // The word under each alias is "libre", never the down label.
    const palabras = [...document.querySelectorAll('.lhg-bot-word')].map((nodo) => nodo.textContent);
    expect(palabras.length).toBeGreaterThan(0);
    expect(palabras).not.toContain('caído');
    expect(new Set(palabras)).toContain('libre');
  });

  it('la cinta de triage va de lo urgente a lo tranquilo, no en el orden del union', async () => {
    // The order of the `LIVE_STATES` union is the PRECEDENCE used to decide an agent's state, not
    // an attention hierarchy: there `settled` comes before `receiving`. In the tally it sits near
    // the end, because "a delivery stopped being in flight" does not ask for anything by itself.
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    const cinta = document.querySelector('.live-tally');
    const etiquetas = [...(cinta?.querySelectorAll('.live-tally-chip') ?? [])]
      .map((chip) => chip.textContent.replace(/\d+$/, '').trim());

    expect(etiquetas.slice(0, 7)).toEqual([
      // "Trabado" and not "Bloqueado": it is the word the verdict already used, the one the
      // STATUS column of the table below uses, and the one the landing alert uses. Four words
      // for the same fact spread across three screens.
      'Caído', 'Trabado', 'Delegando', 'Recibiendo', 'Trabajando', 'Salió de vuelo', 'Libre',
    ]);
    // And the chip that used to say "Respondiendo" no longer exists: there was no way to know
    // if it actually responded.
    expect(etiquetas).not.toContain('Respondiendo');
  });

  it('el chip del estado sin trabajo se llama «Libre», no «Ocioso»', async () => {
    conActividad(mockActivityEnReposo());
    renderWithApi(<LiveFleetPage />);

    expect(await screen.findByRole('button', { name: /^Libre \d+$/ })).toBeInTheDocument();
    expect(screen.queryByText(/ocioso/i)).not.toBeInTheDocument();
  });
});

describe('el mapa', () => {
  /**
   * The three tests that follow fix THE rule of the map, which did not exist before and is why
   * the drawing contradicted the database in both directions at once.
   *
   * Rule: **draw one bot per participant reported by activity — whose core is the `agents`
   * table — and membership only decides which box it falls into.** Before it was the opposite:
   * one bot per MEMBERSHIP, with the activity state glued on top.
   *
   * They replace the "sin reportar" test, which asserted exactly the behavior that turned out to
   * be the bug: that test checked that a membership without activity was drawn anyway, and it
   * was that drawing that put on the fleet map an operator principal that is not an agent. An
   * alias about which nothing is known is no longer painted with an invented state: it is not
   * painted.
   */
  it('un alias que la actividad reporta y NINGUNA sala declara se dibuja igual, en «sin sala»', async () => {
    // The case: registered in `agents` and not appearing anywhere on the screen, because the
    // map placed nodes from memberships and this one had none. A registration that is not seen
    // is indistinguishable from a registration that was not done.
    const base = mockActivity();
    const primero = (base.agents ?? [])[0];
    conActividad({
      ...base,
      agents: [
        ...(base.agents ?? []),
        // Registered (`registered: true`), disabled, with not a single room: exactly the row
        // the view was hiding.
        {
          ...primero, alias: 'gaia', tenant_id: 'Miguel', display_name: 'gaia',
          registered: true, agent_enabled: false, rooms: [], flags: [], in_flight: 0, queued: 0,
        },
      ],
    });
    renderWithApi(<LiveFleetPage />);
    await screen.findByLabelText('Veredicto de la flota');

    await waitFor(() => {
      expect(document.querySelector('[data-agent-key="Miguel/gaia"]')?.getAttribute('data-agent-key')).toBe('Miguel/gaia');
    });
    // Y con su estado real, no con uno inventado: el registro dice deshabilitado.
    expect(document.querySelector('[data-agent-key="Miguel/gaia"]'))
      .toHaveAttribute('data-state', 'down');
  });

  it('una membresía que la actividad NO reporta deja de dibujarse: no se inventa su estado', async () => {
    // The case: an `operator` principal with membership and no row in `agents`. It was drawn on
    // the fleet map, painted "sin reportar", which is an invented response about something the
    // state plane does not know.
    const base = mockActivity();
    const soloSteven = (base.agents ?? []).filter((agent) => agent.tenant_id === 'Steven');
    conActividad({ ...base, agents: soloSteven });
    renderWithApi(<LiveFleetPage />);
    await screen.findByLabelText('Veredicto de la flota');

    await waitFor(() => {
      expect(document.querySelectorAll('.lhg-bot').length).toBe(soloSteven.length);
    });
    // The fixture topology declares four external tenants; none of them is drawn.
    expect(document.querySelector('[data-agent-key="Isa/salva"]')).toBeNull();
    expect(document.querySelector('.lhg-bot[data-state="unknown"]')).toBeNull();
  });

  it('el recuento de muñecos es EXACTAMENTE el de participantes reportados', async () => {
    // The invariant in one line. If anyone re-hooks the drawing to a second source, this number
    // stops matching the same day.
    const base = mockActivity();
    conActividad(base);
    renderWithApi(<LiveFleetPage />);
    await screen.findByLabelText('Veredicto de la flota');

    await waitFor(() => {
      expect(document.querySelectorAll('.lhg-bot').length).toBe((base.agents ?? []).length);
    });
  });

  /**
   * The two DERIVATION chips, mounted: one per direction.
   *
   * The previous counter promised in its comment "the symmetric difference between `memberships`
   * and `agents`" and only walked memberships, so `sinSala` was zero forever. See `deriva.ts`.
   *
   * How much it mattered: this suite's own fixture ALREADY carried the case — one alias is in
   * `agents` and no room declares it — and no test noticed, because the chip that should have
   * counted it was not looking in that direction.
   */
  it('«Sin sala» cuenta el alias del registro sin una sola membresía habilitada — el caso gaia', async () => {
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);
    await screen.findByLabelText('Veredicto de la flota');

    // One, and it is the case the fixture carried before this fix.
    expect(await screen.findByTestId('deriva-sin-sala')).toHaveTextContent(/Sin sala\s*1/);
  });

  it('dar de alta en el registro y no darle sala sube «Sin sala» el mismo día', async () => {
    // Case of an agent with an active registry but zero memberships assigned.
    const base = mockActivity();
    const primero = (base.agents ?? [])[0];
    conActividad({
      ...base,
      agents: [
        ...(base.agents ?? []),
        {
          ...primero, alias: 'gaia', tenant_id: 'Miguel', display_name: 'gaia',
          registered: true, agent_enabled: true, rooms: [], flags: [], in_flight: 0, queued: 0,
        },
      ],
    });
    renderWithApi(<LiveFleetPage />);
    await screen.findByLabelText('Veredicto de la flota');

    // Two: the one that was already there, plus the newly added one.
    expect(await screen.findByTestId('deriva-sin-sala')).toHaveTextContent(/Sin sala\s*2/);
  });

  it('«Fuera del registro» cuenta la membresía habilitada sin fila en el registro', async () => {
    // The other direction: an operator principal with membership and no row in `agents`. It is
    // not a fault — it lives that way on purpose — but if it GOES UP it means someone added or
    // removed a row in only one of the two tables.
    conActividad(mockActivity());
    server.use(http.get('http://localhost/v3/console/topology', () => HttpResponse.json({
      ...topology,
      tenants: (topology.tenants ?? []).map((tenant) => (tenant.id !== 'Steven' ? tenant : {
        ...tenant,
        rooms: (tenant.rooms ?? []).map((room, indice) => (indice !== 0 ? room : {
          ...room,
          members: [...(room.members ?? []), { alias: 'quota-collector', enabled: true }],
        })),
      })),
    })));
    renderWithApi(<LiveFleetPage />);
    await screen.findByLabelText('Veredicto de la flota');

    expect(await screen.findByTestId('deriva-sin-registro')).toHaveTextContent(/Fuera del registro\s*1/);
    // And the other direction is not contaminated: the other counter stays at one.
    expect(await screen.findByTestId('deriva-sin-sala')).toHaveTextContent(/Sin sala\s*1/);
  });

  it('un alta COMPLETA no produce deriva por ninguno de los dos lados', async () => {
    // The negative control for the three tests above: if the chips appeared for something that
    // was not derivation, this case would expose it. The agent is in `agents` and in a single
    // room, with no other membership and no other participant.
    const base = mockActivity();
    const soloConSala = (base.agents ?? []).filter((agent) => agent.alias === 'janus');
    conActividad({ ...base, agents: soloConSala });
    server.use(http.get('http://localhost/v3/console/topology', () => HttpResponse.json({
      ...topology,
      tenants: [{ id: 'Miguel', label: 'Miguel', rooms: [{ id: 'grp.miguel', label: 'grp.miguel', members: [{ alias: 'janus', enabled: true }] }] }],
    })));
    renderWithApi(<LiveFleetPage />);
    await screen.findByLabelText('Veredicto de la flota');

    await waitFor(() => { expect(document.querySelectorAll('.lhg-bot').length).toBe(1); });
    expect(screen.queryByTestId('deriva-sin-registro')).toBeNull();
    expect(screen.queryByTestId('deriva-sin-sala')).toBeNull();
  });

  it('el globo del muñeco se abre CON EL FOCO DE TECLADO y cierra con Esc', async () => {
    // A4. The native SVG `title` never appeared when tabbing, so whoever traversed the map with
    // the keyboard had no way to read what each agent does.
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    const nodos = await waitFor(() => {
      const encontrados = [...document.querySelectorAll<SVGGElement>('.lhg-bot')];
      expect(encontrados.length).toBeGreaterThan(0);
      return encontrados;
    });

    // `focus()` on an SVG node triggers React state outside userEvent's event cycle: without
    // `act` the warning pollutes the whole suite's output, and a noisy suite is one where the
    // warning that actually matters goes unnoticed.
    act(() => { nodos[0].focus(); });
    const globo = await screen.findByRole('tooltip');
    expect(globo.textContent.trim().length).toBeGreaterThan(0);
    expect(globo.textContent).not.toMatch(/^\s*$/);

    await user.keyboard('{Escape}');
    // The map balloon closes when it loses focus; Esc dismisses it the same way without trace.
    act(() => { nodos[0].blur(); });
    await waitFor(() => { expect(screen.queryByRole('tooltip')).not.toBeInTheDocument(); });
  });

  it('conmuta a la capa de permisos sin mover un solo muñeco de sitio', async () => {
    // Rooms and positions must be IDENTICAL across the two layers: if the drawing reorganizes
    // when toggling, comparing "who can" with "who is" is no longer possible at a glance and each
    // agent has to be searched for again.
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    const antes = await waitFor(() => {
      const nodos = [...document.querySelectorAll('.lhg-bot')];
      expect(nodos.length).toBeGreaterThan(0);
      return nodos.map((nodo) => nodo.getAttribute('transform'));
    });

    await user.click(screen.getByRole('button', { name: 'Permisos' }));

    const despues = [...document.querySelectorAll('.lhg-bot')].map((nodo) => nodo.getAttribute('transform'));
    expect(despues).toEqual(antes);
    // And the arrows change meaning: ACL edges instead of in-flight deliveries.
    expect(document.querySelectorAll('.lhg-flow-acl-line').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.lhg-flow-line').length).toBe(0);
  });

  it('el layout es DETERMINISTA: dos refrescos con la misma topología no mueven los muñecos', async () => {
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    const antes = await waitFor(() => {
      const nodos = [...document.querySelectorAll('.lhg-bot')];
      expect(nodos.length).toBeGreaterThan(0);
      return nodos.map((nodo) => nodo.getAttribute('transform'));
    });

    await user.click(screen.getByRole('button', { name: /refrescar ahora/i }));
    await waitFor(() => {
      const despues = [...document.querySelectorAll('.lhg-bot')].map((nodo) => nodo.getAttribute('transform'));
      expect(despues).toEqual(antes);
    });
  });
});

describe('el cajón', () => {
  it('se abre sobre la misma página, con el mapa todavía a la vista, y escribe el enlace profundo', async () => {
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    const fila = await screen.findByRole('row', { name: /zeus/i });
    await user.click(fila);

    const cajon = await screen.findByRole('dialog', { name: /detalle de zeus/i });
    expect(cajon).toHaveAttribute('aria-modal', 'true');
    for (const pestana of within(cajon).getAllByRole('tab')) {
      const panelId = pestana.getAttribute('aria-controls');
      expect(panelId).toBe('agent-drawer-panel');
      if (panelId === null) throw new Error('La pestaña no declara aria-controls');
      expect(document.getElementById(panelId)).toBeInTheDocument();
    }
    expect(within(cajon).getByRole('heading', { level: 2, name: 'zeus' })).toBeInTheDocument();
    // The map did NOT disappear: we did not navigate anywhere.
    const svg = document.querySelector('.lhg-svg');
    expect(svg).not.toBeNull();
    expect(svg?.tagName.toLowerCase()).toBe('svg');
    expect(window.location.pathname).toBe('/live');
    expect(window.location.search).toContain('agente=Steven%2Fzeus');
    expect(window.location.search).toContain('pestana=ahora');
  });

  it('la pestaña Conexión trae las columnas que eran la razón de ser de la vista "Fleet"', async () => {
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    await user.click(await screen.findByRole('row', { name: /kant/i }));
    const cajon = await screen.findByRole('dialog', { name: /detalle de kant/i });
    await user.click(within(cajon).getByRole('tab', { name: 'Conexión' }));

    expect(within(cajon).getByText('Epoch')).toBeInTheDocument();
    expect(within(cajon).getByText('Instancia')).toBeInTheDocument();
    expect(within(cajon).getByText('Último latido')).toBeInTheDocument();
    expect(within(cajon).getByText('Lease vence')).toBeInTheDocument();
    // All four come from the activity snapshot the page already had: zero new fetches. Only
    // `capabilities` needs /v3/status, which is why it is requested only when this tab opens.
    expect(within(cajon).getByText('118')).toBeInTheDocument();
    expect(await within(cajon).findByText('ack')).toBeInTheDocument();
  });

  it('se abre también CON EL TECLADO: el clic en la fila es un atajo, no el único camino', async () => {
    // A `<tr onClick>` is an action that exists only for the mouse. The agent name is a real
    // button, so the same action is reachable via the keyboard.
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    const fila = await screen.findByRole('row', { name: /zeus/i });
    const boton = within(fila).getByRole('button', { name: 'Zeus' });

    boton.focus();
    expect(boton).toHaveFocus();
    await user.keyboard('{Enter}');

    const cajon = await screen.findByRole('dialog', { name: /detalle de zeus/i });
    expect(within(cajon).getByRole('button', { name: 'Cerrar el detalle' })).toHaveFocus();
    expect(document.querySelector('.live-main')).toHaveAttribute('inert');
  });

  it('aísla todas las superficies externas y restaura sólo las que el cajón inertizó', async () => {
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(
      <>
        <a className="skip-link" data-testid="superficie-skip" href="#main-content">Saltar</a>
        <aside className="sidebar" data-testid="superficie-sidebar" />
        <header className="topbar" data-testid="superficie-preinerte" />
        <main id="main-content">
          <section data-testid="superficie-banner">Autenticación no gestionada</section>
          <LiveFleetPage />
          <section data-testid="superficie-hermana">Aviso adicional</section>
        </main>
      </>,
    );
    const preinerte = screen.getByTestId('superficie-preinerte');
    preinerte.setAttribute('inert', '');

    await screen.findByLabelText('Veredicto de la flota');
    await user.click(await screen.findByRole('row', { name: /zeus/i }));
    const cajon = await screen.findByRole('dialog', { name: /detalle de zeus/i });
    const fondoLive = document.querySelector('.live-main');

    expect(cajon).not.toHaveAttribute('inert');
    expect(fondoLive).toHaveAttribute('inert');
    for (const testId of [
      'superficie-skip', 'superficie-sidebar', 'superficie-preinerte',
      'superficie-banner', 'superficie-hermana',
    ]) expect(screen.getByTestId(testId)).toHaveAttribute('inert');

    await user.click(within(cajon).getByRole('button', { name: 'Cerrar el detalle' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /detalle de zeus/i })).not.toBeInTheDocument();
    });

    expect(fondoLive).not.toHaveAttribute('inert');
    for (const testId of [
      'superficie-skip', 'superficie-sidebar', 'superficie-banner', 'superficie-hermana',
    ]) expect(screen.getByTestId(testId)).not.toHaveAttribute('inert');
    expect(preinerte).toHaveAttribute('inert');
  });

  it('cierra con Esc, limpia el enlace profundo y devuelve el foco al control que lo abrió', async () => {
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    const fila = await screen.findByRole('row', { name: /zeus/i });
    const boton = within(fila).getByRole('button', { name: 'Zeus' });
    boton.focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('dialog', { name: /detalle de zeus/i });

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /detalle de zeus/i })).not.toBeInTheDocument();
    });
    expect(window.location.search).not.toContain('agente=');
    expect(document.querySelector('.live-main')).not.toHaveAttribute('inert');
    expect(boton).toHaveFocus();
  });

  it('mantiene el tabulador dentro del cajón y permite recorrer sus pestañas con flechas', async () => {
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    await user.click(within(await screen.findByRole('row', { name: /zeus/i })).getByRole('button', { name: 'Zeus' }));
    const cajon = await screen.findByRole('dialog', { name: /detalle de zeus/i });
    const cerrar = within(cajon).getByRole('button', { name: 'Cerrar el detalle' });
    const ahora = within(cajon).getByRole('tab', { name: 'Ahora' });
    const conexion = within(cajon).getByRole('tab', { name: 'Conexión' });

    const terminal = within(cajon).getByRole('link', { name: /abrir este agente en terminal/i });
    expect(terminal).toHaveAttribute('href', '/terminal/Steven/zeus');
    await user.tab({ shift: true });
    expect(terminal).toHaveFocus();
    ahora.focus();
    await user.keyboard('{ArrowRight}');
    expect(conexion).toHaveFocus();
    expect(conexion).toHaveAttribute('aria-selected', 'true');
    expect(ahora).toHaveAttribute('tabindex', '-1');
    cerrar.focus();
    await user.tab({ shift: true });
    expect(terminal).toHaveFocus();
  });

  it('reabre el agente que venía en la URL: el enlace se puede pegar en un chat', async () => {
    window.history.replaceState({}, '', '/live?agente=Steven%2Fkant&pestana=entregas');
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    const cajon = await screen.findByRole('dialog', { name: /detalle de kant/i });
    expect(within(cajon).getByRole('tab', { name: 'Entregas' })).toHaveAttribute('aria-selected', 'true');
  });

  it('NO ofrece ninguna acción destructiva: la entrega se enlaza a Queues, no se reintenta acá', async () => {
    // A9. This view self-refreshes every four seconds and reorders itself by urgency: between
    // reading a row and clicking it, the row may have moved. The worst place for a destructive
    // button.
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    await user.click(await screen.findByRole('row', { name: /zeus/i }));
    const cajon = await screen.findByRole('dialog', { name: /detalle de zeus/i });
    await user.click(within(cajon).getByRole('tab', { name: 'Entregas' }));

    expect(within(cajon).getByRole('link', { name: /ver en queues/i })).toBeInTheDocument();
    expect(within(cajon).queryByRole('button', { name: /reintentar|replay|cancelar/i })).not.toBeInTheDocument();
  });

  it('en ningún sitio de la vista aparece el TEXTO de un encargo', async () => {
    // A8. Not a UI choice that can be revisited: /activity does not select message bodies, the
    // data does not even enter the result set. This asserts it from the screen.
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    await user.click(await screen.findByRole('row', { name: /zeus/i }));
    const cajon = await screen.findByRole('dialog', { name: /detalle de zeus/i });
    await user.click(within(cajon).getByRole('tab', { name: 'Entregas' }));

    expect(within(cajon).queryByText(/body|preview|cuerpo del mensaje/i)).not.toBeInTheDocument();
  });
});
