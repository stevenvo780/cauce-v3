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
    // A2 del expediente. Se sirve UNA lectura buena y después se rompe el endpoint, que es
    // exactamente lo que pasa cuando el gateway se cae con la consola ya abierta: el snapshot
    // anterior sigue en pantalla y sigue pareciendo fresco. Un cartel verde encima de eso miente.
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
    await waitFor(() => expect(banda).toHaveAttribute('data-tone', 'ok'));

    await user.click(screen.getByRole('button', { name: /refrescar ahora/i }));

    await waitFor(() => expect(banda).toHaveAttribute('data-tone', 'desconocido'));
    expect(banda).not.toHaveAttribute('data-tone', 'ok');
    expect(within(banda).getByText(/no lo sé/i)).toBeInTheDocument();
    expect(within(banda).getByText(/última lectura buena/i)).toBeInTheDocument();
  });

  it('nombra a los agentes que necesitan atención y su chip trae al muñeco a la vista', async () => {
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    const banda = await screen.findByLabelText('Veredicto de la flota');
    await waitFor(() => expect(banda).toHaveAttribute('data-tone', 'alerta'));
    expect(within(banda).getByText(/necesitan atención/i)).toBeInTheDocument();

    const chip = within(banda).getAllByRole('button')[0];
    // jsdom no implementa scrollIntoView; se instala para poder afirmar que se llama sobre el
    // nodo correcto, que es lo que hace que el chip sirva para algo.
    const nodos = document.querySelectorAll('[data-agent-key]');
    const llamados: string[] = [];
    nodos.forEach((nodo) => {
      (nodo as HTMLElement & { scrollIntoView: () => void }).scrollIntoView = () => {
        llamados.push(nodo.getAttribute('data-agent-key') ?? '');
      };
    });

    await user.click(chip);
    expect(llamados.length).toBeLessThanOrEqual(1);
  });

  it('las tres cifras llevan la definición del SERVIDOR en el tooltip, no en el rótulo', async () => {
    // La fila de cinco `Metric` que esto reemplaza tenía por rótulo la expresión SQL. El dato no
    // se pierde —hace falta para contrastar un número dudoso—, cambia de sitio.
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    const banda = await screen.findByLabelText('Veredicto de la flota');
    await user.hover(within(banda).getByText(/en vuelo$/));

    expect(await screen.findByRole('tooltip')).toHaveTextContent(/leased.*accepted.*started/);
  });
});

describe('la flota en reposo', () => {
  it('se lee tranquila y NINGÚN muñeco parece muerto', async () => {
    // A1 del expediente, y el escenario que de verdad se ve casi siempre: en producción hay una
    // entrega en vuelo en toda la base y cero en cola. Una pantalla que sólo se lee bien cuando
    // hay incendio se lee mal el 95 % del tiempo.
    conActividad(mockActivityEnReposo());
    renderWithApi(<LiveFleetPage />);

    const banda = await screen.findByLabelText('Veredicto de la flota');
    await waitFor(() => expect(banda).toHaveAttribute('data-tone', 'ok'));

    expect(screen.getByText(/La flota está libre/)).toBeInTheDocument();
    expect(screen.getByText(/no es una avería/)).toBeInTheDocument();

    // La palabra bajo cada alias es "libre", nunca "caído".
    const palabras = [...document.querySelectorAll('.lhg-bot-word')].map((nodo) => nodo.textContent);
    expect(palabras.length).toBeGreaterThan(0);
    expect(palabras).not.toContain('caído');
    expect(new Set(palabras)).toContain('libre');
  });

  it('la cinta de triage va de lo urgente a lo tranquilo, no en el orden del union', async () => {
    // El orden del union `LIVE_STATES` es la PRECEDENCIA con la que se decide el estado de un
    // agente, no una jerarquía de atención: ahí `settled` va antes que `receiving`. En la cinta va
    // casi al final, porque "una entrega dejó de estar en vuelo" no pide nada por sí solo.
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    const cinta = document.querySelector('.live-tally');
    const etiquetas = [...(cinta?.querySelectorAll('.live-tally-chip') ?? [])]
      .map((chip) => chip.textContent?.replace(/\d+$/, '').trim());

    expect(etiquetas.slice(0, 7)).toEqual([
      'Caído', 'Bloqueado', 'Delegando', 'Recibiendo', 'Trabajando', 'Salió de vuelo', 'Libre',
    ]);
    // Y el chip que antes decía «Respondiendo» ya no existe: no había forma de saber si respondió.
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
   * Los tres tests que siguen fijan LA regla del mapa, que antes no existía y por eso el dibujo
   * contradecía a la base de datos en las dos direcciones a la vez.
   *
   * Regla: **se dibuja un muñeco por cada participante que la actividad reporta —cuyo núcleo es la
   * tabla `agents`— y la membresía sólo decide en qué recuadro cae.** Antes era al revés: un
   * muñeco por MEMBRESÍA, con el estado de la actividad pegado encima.
   *
   * Reemplazan al test de «sin reportar», que afirmaba justamente el comportamiento que resultó
   * ser el defecto: aquel test comprobaba que una membresía sin actividad se dibujara igual, y era
   * ese dibujo el que ponía en el mapa de la flota a un principal de operador que no es un agente.
   * Un alias del que no se sabe nada ya no se pinta con un estado inventado: no se pinta.
   */
  it('un alias que la actividad reporta y NINGUNA sala declara se dibuja igual, en «sin sala»', async () => {
    // El caso `gaia`: se dio de alta en `agents` y no aparecía en ninguna parte de la pantalla,
    // porque el mapa colocaba nodos desde las membresías y ésta no tenía ninguna. Un alta que no
    // se ve es indistinguible de un alta que no se hizo.
    const base = mockActivity();
    const primero = (base.agents ?? [])[0];
    conActividad({
      ...base,
      agents: [
        ...(base.agents ?? []),
        // Registrado (`registered: true`), deshabilitado, y sin una sola sala: exactamente la
        // fila que la vista escondía.
        {
          ...primero, alias: 'gaia', tenant_id: 'Miguel', display_name: 'gaia',
          registered: true, agent_enabled: false, rooms: [], flags: [], in_flight: 0, queued: 0,
        },
      ],
    });
    renderWithApi(<LiveFleetPage />);
    await screen.findByLabelText('Veredicto de la flota');

    await waitFor(() => {
      expect(document.querySelector('[data-agent-key="Miguel/gaia"]')).toBeTruthy();
    });
    // Y con su estado real, no con uno inventado: el registro dice deshabilitado.
    expect(document.querySelector('[data-agent-key="Miguel/gaia"]'))
      .toHaveAttribute('data-state', 'down');
  });

  it('una membresía que la actividad NO reporta deja de dibujarse: no se inventa su estado', async () => {
    // El caso `quota-collector`: un principal `operator` con membresía y sin fila en `agents`.
    // Salía dibujado en el mapa de la flota, pintado «sin reportar», que es una respuesta
    // inventada sobre algo que el plano de estado no conoce.
    const base = mockActivity();
    const soloSteven = (base.agents ?? []).filter((agent) => agent.tenant_id === 'Steven');
    conActividad({ ...base, agents: soloSteven });
    renderWithApi(<LiveFleetPage />);
    await screen.findByLabelText('Veredicto de la flota');

    await waitFor(() => {
      expect(document.querySelectorAll('.lhg-bot').length).toBe(soloSteven.length);
    });
    // La topología del fixture declara a Pablo, Isa, Jhon y Miguel; ninguno se dibuja.
    expect(document.querySelector('[data-agent-key="Isa/salva"]')).toBeNull();
    expect(document.querySelector('.lhg-bot[data-state="unknown"]')).toBeNull();
  });

  it('el recuento de muñecos es EXACTAMENTE el de participantes reportados', async () => {
    // El invariante en una línea. Si alguien vuelve a colgar el dibujo de una segunda fuente,
    // este número deja de cuadrar el mismo día.
    const base = mockActivity();
    conActividad(base);
    renderWithApi(<LiveFleetPage />);
    await screen.findByLabelText('Veredicto de la flota');

    await waitFor(() => {
      expect(document.querySelectorAll('.lhg-bot').length).toBe((base.agents ?? []).length);
    });
  });

  /**
   * Los dos chips de DERIVA, montados: uno por dirección.
   *
   * El contador anterior prometía en su comentario «la diferencia simétrica entre `memberships` y
   * `agents`» y recorría SÓLO las membresías, así que `sinSala` valía cero para siempre. Ver
   * `deriva.ts`.
   *
   * 🔴 La medida de cuánto importaba: el fixture de esta misma suite YA traía el caso —`vulcano`
   * está en `agents` y ninguna sala lo declara— y ninguna prueba lo notaba, porque el chip que
   * debía contarlo no miraba esa dirección.
   */
  it('«Sin sala» cuenta el alias del registro sin una sola membresía habilitada — el caso gaia', async () => {
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);
    await screen.findByLabelText('Veredicto de la flota');

    // Uno, y es `vulcano`: el caso que el fixture traía desde antes de este arreglo.
    expect(await screen.findByTestId('deriva-sin-sala')).toHaveTextContent(/Sin sala\s*1/);
  });

  it('dar de alta en el registro y no darle sala sube «Sin sala» el mismo día', async () => {
    // El caso `gaia` literal: alta en `agents`, cero membresías. Es un alta a medias, y hasta el
    // 2026-08-22 la pantalla que existe para verla no decía una palabra.
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

    // Dos: el `vulcano` que ya estaba, más `gaia`.
    expect(await screen.findByTestId('deriva-sin-sala')).toHaveTextContent(/Sin sala\s*2/);
  });

  it('«Fuera del registro» cuenta la membresía habilitada sin fila en el registro', async () => {
    // La otra dirección: `quota-collector` es un principal de operador con membresía y sin fila en
    // `agents`. No es una avería —vive así a propósito— pero si SUBE es que alguien dio un alta o
    // una baja tocando una sola de las dos tablas.
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
    // Y no se contamina la otra dirección: `vulcano` sigue siendo uno solo.
    expect(await screen.findByTestId('deriva-sin-sala')).toHaveTextContent(/Sin sala\s*1/);
  });

  it('un alta COMPLETA no produce deriva por ninguno de los dos lados', async () => {
    // El control negativo de las tres pruebas de arriba: si los chips salieran por algo que no es
    // la deriva, este caso los delataría. `janus` está en `agents` y en `grp.miguel`, y no hay
    // ninguna otra membresía ni ningún otro participante.
    const base = mockActivity();
    const soloConSala = (base.agents ?? []).filter((agent) => agent.alias === 'janus');
    conActividad({ ...base, agents: soloConSala });
    server.use(http.get('http://localhost/v3/console/topology', () => HttpResponse.json({
      ...topology,
      tenants: [{ id: 'Miguel', label: 'Miguel', rooms: [{ id: 'grp.miguel', label: 'grp.miguel', members: [{ alias: 'janus', enabled: true }] }] }],
    })));
    renderWithApi(<LiveFleetPage />);
    await screen.findByLabelText('Veredicto de la flota');

    await waitFor(() => expect(document.querySelectorAll('.lhg-bot').length).toBe(1));
    expect(screen.queryByTestId('deriva-sin-registro')).toBeNull();
    expect(screen.queryByTestId('deriva-sin-sala')).toBeNull();
  });

  it('el globo del muñeco se abre CON EL FOCO DE TECLADO y cierra con Esc', async () => {
    // A4 del expediente. El `title` nativo del SVG nunca aparecía al tabular, así que quien
    // recorre el mapa con el teclado no tenía forma de leer qué hace cada agente.
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    const nodos = await waitFor(() => {
      const encontrados = [...document.querySelectorAll<SVGGElement>('.lhg-bot')];
      expect(encontrados.length).toBeGreaterThan(0);
      return encontrados;
    });

    // `focus()` sobre un nodo SVG dispara estado de React fuera del ciclo de eventos de
    // userEvent: sin `act` el aviso ensucia la salida de toda la suite, y una suite ruidosa es
    // una suite en la que el aviso que sí importa pasa desapercibido.
    act(() => nodos[0].focus());
    const globo = await screen.findByRole('tooltip');
    expect(globo.textContent).toBeTruthy();

    await user.keyboard('{Escape}');
    // El globo del mapa se cierra al perder el foco; Esc lo suelta igualmente sin dejar rastro.
    act(() => nodos[0].blur());
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  });

  it('conmuta a la capa de permisos sin mover un solo muñeco de sitio', async () => {
    // Las salas y las posiciones tienen que ser IDÉNTICAS entre las dos capas: si el dibujo se
    // reorganiza al conmutar, comparar "quién puede" con "quién está" deja de ser posible de un
    // vistazo y hay que volver a buscar a cada agente.
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
    // Y las flechas cambian de significado: aristas ACL en vez de entregas en vuelo.
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

    const cajon = await screen.findByRole('complementary', { name: /detalle de zeus/i });
    expect(within(cajon).getByRole('heading', { level: 2, name: 'zeus' })).toBeInTheDocument();
    // El mapa NO desapareció: no se navegó a ningún sitio.
    expect(document.querySelector('.lhg-svg')).toBeTruthy();
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
    const cajon = await screen.findByRole('complementary', { name: /detalle de kant/i });
    await user.click(within(cajon).getByRole('tab', { name: 'Conexión' }));

    expect(within(cajon).getByText('Epoch')).toBeInTheDocument();
    expect(within(cajon).getByText('Instancia')).toBeInTheDocument();
    expect(within(cajon).getByText('Último latido')).toBeInTheDocument();
    expect(within(cajon).getByText('Lease vence')).toBeInTheDocument();
    // Los cuatro salen del snapshot de actividad que la página ya tenía: cero fetch nuevo. Sólo
    // `capabilities` necesita /v3/status, y por eso se pide recién al abrir esta pestaña.
    expect(within(cajon).getByText('118')).toBeInTheDocument();
    expect(await within(cajon).findByText('ack')).toBeInTheDocument();
  });

  it('se abre también CON EL TECLADO: el clic en la fila es un atajo, no el único camino', async () => {
    // Un `<tr onClick>` es una acción que sólo existe para el ratón. El nombre del agente es un
    // botón real, así que la misma acción está en el tabulador.
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    const fila = await screen.findByRole('row', { name: /zeus/i });
    const boton = within(fila).getByRole('button', { name: 'Zeus' });

    boton.focus();
    expect(boton).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(await screen.findByRole('complementary', { name: /detalle de zeus/i })).toBeInTheDocument();
  });

  it('cierra con Esc y limpia el enlace profundo', async () => {
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    await user.click(await screen.findByRole('row', { name: /zeus/i }));
    await screen.findByRole('complementary', { name: /detalle de zeus/i });

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('complementary')).not.toBeInTheDocument());
    expect(window.location.search).not.toContain('agente=');
  });

  it('reabre el agente que venía en la URL: el enlace se puede pegar en un chat', async () => {
    window.history.replaceState({}, '', '/live?agente=Steven%2Fkant&pestana=entregas');
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    const cajon = await screen.findByRole('complementary', { name: /detalle de kant/i });
    expect(within(cajon).getByRole('tab', { name: 'Entregas' })).toHaveAttribute('aria-selected', 'true');
  });

  it('NO ofrece ninguna acción destructiva: la entrega se enlaza a Queues, no se reintenta acá', async () => {
    // A9 del expediente. Esta vista se auto-refresca cada cuatro segundos y se reordena sola por
    // urgencia: entre leer una fila y hacer clic, la fila pudo haberse movido. Es el peor sitio
    // posible para un botón que destruye.
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    await user.click(await screen.findByRole('row', { name: /zeus/i }));
    const cajon = await screen.findByRole('complementary', { name: /detalle de zeus/i });
    await user.click(within(cajon).getByRole('tab', { name: 'Entregas' }));

    expect(within(cajon).getByRole('link', { name: /ver en queues/i })).toBeInTheDocument();
    expect(within(cajon).queryByRole('button', { name: /reintentar|replay|cancelar/i })).not.toBeInTheDocument();
  });

  it('en ningún sitio de la vista aparece el TEXTO de un encargo', async () => {
    // A8. No es una elección de la UI que se pueda revisar: /activity no selecciona cuerpos de
    // mensaje, el dato no entra siquiera al result set. Esto lo afirma desde la pantalla.
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    await user.click(await screen.findByRole('row', { name: /zeus/i }));
    const cajon = await screen.findByRole('complementary', { name: /detalle de zeus/i });
    await user.click(within(cajon).getByRole('tab', { name: 'Entregas' }));

    expect(within(cajon).queryByText(/body|preview|cuerpo del mensaje/i)).not.toBeInTheDocument();
  });
});

describe('lo que absorbió del menú', () => {
  it('"Permisos y salas" trae las dos tablas de Tenants & ACL sin pedir la topología otra vez', async () => {
    let lecturas = 0;
    server.use(http.get('http://localhost/v3/console/topology', () => {
      lecturas += 1;
      return HttpResponse.json(topology);
    }));
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    await user.click(screen.getByText('Permisos y salas'));

    expect(await screen.findByLabelText('Aristas de control de acceso')).toBeInTheDocument();
    expect(screen.getAllByText('Tenant').length).toBeGreaterThan(0);
    // El mapa y el desplegable comparten el mismo `useResource('live-topology')`.
    expect(lecturas).toBe(1);
  });
});

// ================================================================================================
// D1 · quién pidió el trabajo, visto desde la pantalla y no desde la función pura.
// ================================================================================================

describe('quién pidió cada encargo', () => {
  it('una delegación heredada de un puente NO se anuncia como «una persona, por telegram»', async () => {
    // El fixture de kant trae el caso real: `argos` le delegó una entrega cuyo `origin_adapter`
    // sigue diciendo 'telegram' porque el `origin` se copia byte a byte en cada salto. El mapa
    // dibuja la flecha argos→kant y el cajón decía, del MISMO encargo, que se lo pidió una persona.
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    await user.click(await screen.findByRole('row', { name: /kant/i }));
    const cajon = await screen.findByRole('complementary', { name: /detalle de kant/i });
    await user.click(within(cajon).getByRole('tab', { name: 'Entregas' }));

    // Las tres entregas de kant vienen de otros agentes de la flota: ninguna es un encargo humano.
    expect(within(cajon).queryByText(/una persona, por telegram/i)).not.toBeInTheDocument();
    expect(within(cajon).getByText(/argos \(Steven\), otro agente/)).toBeInTheDocument();
    expect(within(cajon).getAllByText(/zeus \(Steven\), otro agente/).length).toBe(2);
  });

  it('el puente de verdad sí se nombra: hegel recibe por telegram lo que le escribe su dueño', async () => {
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

// ================================================================================================
// D5, D6, D7 · el selector de Cliente. La suite anterior tenía veinte tests y NI UNA vez la
// palabra 'tenant': el acotamiento por cliente era un requisito y era justo lo único sin prueba.
// ================================================================================================

/** Los alias que el mapa está dibujando, con su tenant delante. */
function dibujados(): string[] {
  return [...document.querySelectorAll('.lhg-bot')]
    .map((nodo) => nodo.getAttribute('data-agent-key') ?? '');
}

async function elegirCliente(user: ReturnType<typeof userEvent.setup>, tenant: string) {
  await user.selectOptions(screen.getByLabelText(/^Cliente/), tenant);
}

describe('el selector de Cliente', () => {
  it('acota EL MAPA, no sólo el veredicto: no queda dibujado ni un muñeco de otro cliente', async () => {
    // D5. El mapa recibía `views` entera y la topología entera, así que con Cliente = Miguel
    // seguían dibujados los muñecos de los otros cuatro clientes, con globo completo y con clic
    // que abría el cajón con SUS entregas.
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    await waitFor(() => expect(dibujados().length).toBeGreaterThan(5));
    expect(dibujados().some((key) => key.startsWith('Steven/'))).toBe(true);

    await elegirCliente(user, 'Miguel');

    await waitFor(() => {
      const claves = dibujados();
      expect(claves.length).toBeGreaterThan(0);
      expect(claves.every((key) => key.startsWith('Miguel/'))).toBe(true);
    });
  });

  it('declara el recorte en pantalla: esconder muñecos sin decirlo es mentir por omisión', async () => {
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

  it('la cabecera no puede afirmar un alcance que el dibujo contradiga', async () => {
    // D6. Decía «Los N alias que podés ver» con N ya acotado mientras el mapa seguía dibujando a
    // los quince. La frase y el dibujo tienen que hablar del mismo conjunto.
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    await elegirCliente(user, 'Miguel');

    const descripcion = await screen.findByText(/Los 4 alias de Miguel/);
    expect(descripcion).toBeInTheDocument();
    await waitFor(() => expect(dibujados().every((key) => key.startsWith('Miguel/'))).toBe(true));
  });

  it('la cinta de triage cuenta el ALCANCE, no la flota entera', async () => {
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    // `:not(.is-unreported)` deja fuera los dos chips de DERIVA: no son estados, y sumarlos a la
    // cinta mezclaría «cuántos alias hay en cada estado» con «cuántas altas están a medias».
    const sumaChips = () => [...document.querySelectorAll('.live-tally-chip:not(.is-unreported) strong')]
      .reduce((total, chip) => total + Number(chip.textContent ?? 0), 0);
    await waitFor(() => expect(sumaChips()).toBe(15));

    await elegirCliente(user, 'Miguel');
    // janus, kratos, iza y atlas: los cuatro alias de Miguel que la actividad reporta.
    await waitFor(() => expect(sumaChips()).toBe(4));
  });

  it('un cliente del que la actividad no reporta NADA no sale verde: sale «no lo sé»', async () => {
    // D2 visto desde la página: la lectura llegó fresca y perfecta, y no acredita nada sobre
    // Miguel. Antes esto daba «Todo en orden · 0 conectados · 0 trabajando».
    const user = userEvent.setup();
    const soloSteven = mockActivity();
    conActividad({
      ...soloSteven,
      agents: (soloSteven.agents ?? []).filter((agente) => agente.tenant_id === 'Steven'),
    });
    renderWithApi(<LiveFleetPage />);

    const banda = await screen.findByLabelText('Veredicto de la flota');
    await elegirCliente(user, 'Miguel');

    await waitFor(() => expect(banda).toHaveAttribute('data-tone', 'desconocido'));
    expect(banda).not.toHaveAttribute('data-tone', 'ok');
    expect(within(banda).getByText(/no hay ni un alias que mirar/i)).toBeInTheDocument();
  });

  it('«Permisos y salas» también se acota: si no, contaría salas que la cabecera dice no mostrar', async () => {
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    await elegirCliente(user, 'Miguel');
    await user.click(screen.getByText('Permisos y salas'));

    const salas = await screen.findByLabelText('Aristas de control de acceso');
    expect(salas).toBeInTheDocument();
    expect(screen.queryByText('grp.pablo')).not.toBeInTheDocument();
    expect(screen.getAllByText('grp.miguel').length).toBeGreaterThan(0);
  });

  it('el resaltado del buscador NO se apaga al pasar el puntero por otro muñeco', async () => {
    // D5, segunda mitad: `focusKey` ganaba sobre `spotlight` en un if/else excluyente, así que
    // rozar cualquier nodo borraba el resaltado del filtro y dejaba el mapa como si no hubiera
    // ninguno puesto.
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

    // `kant` no tiene ninguna relación con `salva`: bajo la regla vieja, enfocarlo dejaba a salva
    // fuera del conjunto activo y por tanto atenuado.
    const kant = document.querySelector('[data-agent-key="Steven/kant"]') as SVGGElement;
    await user.hover(kant);

    expect(salva.classList.contains('is-dim')).toBe(false);
    expect(kant.classList.contains('is-dim')).toBe(false);
  });
});

// ================================================================================================
// D10 · un fallo de GET /v3/console/topology tiene que verse y tiene que poder reintentarse.
// ================================================================================================

describe('la topología caída', () => {
  it('se dice, y no se disfraza de «no hay salas configuradas»', async () => {
    conActividad(mockActivity());
    server.use(http.get('http://localhost/v3/console/topology', () =>
      HttpResponse.json({ error: 'boom', message: 'topología caída' }, { status: 500 })));

    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    // Aparece dos veces a propósito: en la barra (donde vive el reintento) y en el hueco del
    // mapa (donde el operador está mirando cuando nota que no hay dibujo).
    expect(await screen.findAllByText(/No se pudo leer la topología/)).toHaveLength(2);
    // Y NO el cartel de "el control plane todavía no informó ninguna sala", que afirma una
    // configuración vacía a partir de una lectura que falló.
    expect(screen.queryByText(/todavía no informó ninguna sala/)).not.toBeInTheDocument();
  });

  it('se puede reintentar sin recargar el navegador', async () => {
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

    await waitFor(() => expect(document.querySelector('.lhg-svg')).toBeTruthy());
    expect(screen.queryAllByText(/No se pudo leer la topología/)).toHaveLength(0);
  });

  it('«Refrescar ahora» vuelve a leer las DOS fuentes, no sólo la actividad', async () => {
    const user = userEvent.setup();
    conActividad(mockActivity());
    let lecturas = 0;
    server.use(http.get('http://localhost/v3/console/topology', () => {
      lecturas += 1;
      return HttpResponse.json(topology);
    }));

    renderWithApi(<LiveFleetPage />);
    await screen.findByLabelText('Veredicto de la flota');
    await waitFor(() => expect(lecturas).toBe(1));

    await user.click(screen.getByRole('button', { name: /refrescar ahora/i }));
    await waitFor(() => expect(lecturas).toBe(2));
  });
});

describe('prefers-reduced-motion', () => {
  function conMatchMedia(reduce: boolean) {
    // jsdom no implementa matchMedia. Se instala una que responda lo que el test necesita, y se
    // conserva la firma real (addEventListener incluido) para no acreditar un falso positivo con
    // un doble más permisivo que el navegador.
    window.matchMedia = ((query: string) => ({
      matches: reduce && query.includes('reduce'),
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }

  afterEach(() => {
    Reflect.deleteProperty(window, 'matchMedia');
  });

  it('apaga el SMIL, que el CSS NO puede apagar', async () => {
    // A5 del expediente. `<animateMotion>` no es una animación CSS: `prefers-reduced-motion` no lo
    // toca desde la hoja de estilos. Hay que preguntarlo desde JS o la vista incumple lo que el
    // resto de la consola ya respeta.
    conMatchMedia(true);
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    await waitFor(() => expect(document.querySelectorAll('.lhg-flow-line').length).toBeGreaterThan(0));

    expect(document.querySelectorAll('animateMotion')).toHaveLength(0);
    // Pero el punto NO desaparece: se queda fijo a mitad de la curva. Una flecha viva y una muerta
    // tienen que seguir distinguiéndose para quien pidió menos movimiento, no menos información.
    const puntos = [...document.querySelectorAll('.lhg-flow-dot')];
    expect(puntos.length).toBeGreaterThan(0);
    expect(puntos[0].getAttribute('cx')).toBeTruthy();
  });

  it('sin el ajuste puesto, el punto sí viaja: es lo que comunica el SENTIDO de la delegación', async () => {
    conMatchMedia(false);
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    await waitFor(() => expect(document.querySelectorAll('animateMotion').length).toBeGreaterThan(0));
    expect(document.querySelector('.lhg-flow-dot')?.getAttribute('cx')).toBeNull();
  });
});
