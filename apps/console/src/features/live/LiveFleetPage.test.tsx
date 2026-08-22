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
    // agente, no una jerarquía de atención: ahí `responding` va antes que `receiving`. En la cinta
    // "acaba de cerrar un turno" es la mejor noticia de la fila y va al final.
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    const cinta = document.querySelector('.live-tally');
    const etiquetas = [...(cinta?.querySelectorAll('.live-tally-chip') ?? [])]
      .map((chip) => chip.textContent?.replace(/\d+$/, '').trim());

    expect(etiquetas.slice(0, 7)).toEqual([
      'Caído', 'Bloqueado', 'Delegando', 'Recibiendo', 'Trabajando', 'Respondiendo', 'Libre',
    ]);
  });

  it('el chip del estado sin trabajo se llama «Libre», no «Ocioso»', async () => {
    conActividad(mockActivityEnReposo());
    renderWithApi(<LiveFleetPage />);

    expect(await screen.findByRole('button', { name: /^Libre \d+$/ })).toBeInTheDocument();
    expect(screen.queryByText(/ocioso/i)).not.toBeInTheDocument();
  });
});

describe('el mapa', () => {
  it('un alias que la topología declara y la actividad NO reporta se dibuja «sin reportar», no caído', async () => {
    // A3 del expediente, y era un bug real: `view?.state ?? 'down'` afirmaba una avería a partir
    // de un silencio. No informado y roto son dos cosas distintas.
    const soloUno = mockActivity();
    conActividad({ ...soloUno, agents: (soloUno.agents ?? []).slice(0, 1) });
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');

    await waitFor(() => {
      const sinReportar = [...document.querySelectorAll('.lhg-bot[data-state="unknown"]')];
      expect(sinReportar.length).toBeGreaterThan(0);
      // El anillo punteado es el segundo canal; la palabra escrita, el tercero.
      expect(sinReportar[0].querySelector('.lhg-bot-unknown-ring')).toBeTruthy();
      expect(sinReportar[0].querySelector('.lhg-bot-word')?.textContent).toBe('sin reportar');
    });

    expect(document.querySelectorAll('.lhg-bot[data-state="down"]').length).toBe(0);
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
