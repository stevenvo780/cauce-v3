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
    // El resumen del desplegable dice CUÁNTO hay detrás: sin eso es una puerta ciega.
    await user.click(screen.getByText(/^Permisos y salas · /));

    expect(await screen.findByLabelText('Aristas de control de acceso')).toBeInTheDocument();
    expect(screen.getAllByText('Tenant').length).toBeGreaterThan(0);
    // El mapa y el desplegable comparten el mismo `useResource('live-topology')`.
    expect(lecturas).toBe(1);
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
    await waitFor(() => { expect(dibujados().length).toBeGreaterThan(5); });
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
    await waitFor(() => { expect(dibujados().every((key) => key.startsWith('Miguel/'))).toBe(true); });
  });

  it('la cinta de triage cuenta el ALCANCE, no la flota entera', async () => {
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    // `:not(.is-unreported)` deja fuera los dos chips de DERIVA: no son estados, y sumarlos a la
    // cinta mezclaría «cuántos alias hay en cada estado» con «cuántas altas están a medias».
    const sumaChips = () => [...document.querySelectorAll('.live-tally-chip:not(.is-unreported) strong')]
      .reduce((total, chip) => total + Number(chip.textContent), 0);
    await waitFor(() => { expect(sumaChips()).toBe(15); });

    await elegirCliente(user, 'Miguel');
    // janus, kratos, iza y atlas: los cuatro alias de Miguel que la actividad reporta.
    await waitFor(() => { expect(sumaChips()).toBe(4); });
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

    await waitFor(() => { expect(banda).toHaveAttribute('data-tone', 'desconocido'); });
    expect(banda).not.toHaveAttribute('data-tone', 'ok');
    expect(within(banda).getByText(/no hay ni un alias que mirar/i)).toBeInTheDocument();
  });

  it('«Permisos y salas» también se acota: si no, contaría salas que la cabecera dice no mostrar', async () => {
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    await elegirCliente(user, 'Miguel');
    // El resumen del desplegable dice CUÁNTO hay detrás: sin eso es una puerta ciega.
    await user.click(screen.getByText(/^Permisos y salas · /));

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
    const kant = document.querySelector('[data-agent-key="Steven/kant"]');
    expect(kant).not.toBeNull();
    if (!kant) throw new Error('kant node not found');
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

    await waitFor(() => { expect(document.querySelector('.lhg-svg')).toBeTruthy(); });
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
    await waitFor(() => { expect(lecturas).toBe(1); });

    await user.click(screen.getByRole('button', { name: /refrescar ahora/i }));
    await waitFor(() => { expect(lecturas).toBe(2); });
  });
});

describe('prefers-reduced-motion', () => {
  function conMatchMedia(reduce: boolean) {
    // jsdom no implementa matchMedia. Se instala una que responda lo que el test necesita, y se
    // conserva la firma real (addEventListener incluido) para no acreditar un falso positivo con
    // un doble más permisivo que el navegador.
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

  it('apaga el SMIL, que el CSS NO puede apagar', async () => {
    // A5 del expediente. `<animateMotion>` no es una animación CSS: `prefers-reduced-motion` no lo
    // toca desde la hoja de estilos. Hay que preguntarlo desde JS o la vista incumple lo que el
    // resto de la consola ya respeta.
    conMatchMedia(true);
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);

    await screen.findByLabelText('Veredicto de la flota');
    await waitFor(() => { expect(document.querySelectorAll('.lhg-flow-line').length).toBeGreaterThan(0); });

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
    await waitFor(() => { expect(document.querySelectorAll('animateMotion').length).toBeGreaterThan(0); });
    expect(document.querySelector('.lhg-flow-dot')?.getAttribute('cx')).toBeNull();
  });
});
