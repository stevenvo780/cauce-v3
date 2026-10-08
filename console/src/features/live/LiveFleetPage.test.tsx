import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { FleetActivitySnapshot } from '../../api/types';
import { mockActivity, mockActivityEnReposo } from '../../mocks/data';
import { server } from '../../mocks/server';
import { renderLive } from './render-live';

function conActividad(snapshot: FleetActivitySnapshot) {
  server.use(http.get('http://localhost/v3/console/activity', () => HttpResponse.json(snapshot)));
}

beforeEach(() => {
  window.history.replaceState({}, '', '/live');
});

describe('el veredicto', () => {
  it('nunca queda en verde si el fetch falla: se degrada a «No lo sé»', async () => {
    let llamadas = 0;
    server.use(http.get('http://localhost/v3/console/activity', () => {
      llamadas += 1;
      return llamadas === 1
        ? HttpResponse.json(mockActivityEnReposo())
        : HttpResponse.json({ error: 'boom', message: 'actividad caída' }, { status: 500 });
    }));
    const user = userEvent.setup();
    renderLive();

    const veredicto = await screen.findByLabelText('Veredicto de la flota');
    await waitFor(() => { expect(veredicto).toHaveAttribute('data-tone', 'ok'); });
    expect(veredicto).toHaveTextContent(/todo en orden/i);

    await user.click(screen.getByRole('button', { name: /actualizar ahora/i }));

    await waitFor(() => { expect(veredicto).toHaveAttribute('data-tone', 'desconocido'); });
    expect(veredicto).toHaveTextContent(/no lo sé/i);
  });

  it('cuenta los que necesitan atención y al pulsarlo deja sólo a los caídos y trabados', async () => {
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderLive();

    const veredicto = await screen.findByLabelText('Veredicto de la flota');
    await waitFor(() => { expect(veredicto).toHaveAttribute('data-tone', 'alerta'); });
    await user.click(within(veredicto).getByRole('button', { name: /necesitan atención/i }));

    const atencion = screen.getByRole('region', { name: 'Necesitan atención' });
    const estados = within(atencion).getAllByRole('button').map((boton) => boton.getAttribute('data-state'));
    expect(estados.length).toBeGreaterThan(0);
    expect(new Set(estados)).toEqual(new Set(['down', 'blocked']));
    expect(estados.indexOf('blocked')).toBeGreaterThan(estados.lastIndexOf('down'));
    expect(screen.getByRole('button', { name: /^Caído/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^Trabado/ })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Quitar filtro' }));
    expect(screen.getByRole('button', { name: /^Caído/ })).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('los chips de estado', () => {
  it('van de lo urgente a lo tranquilo y sólo muestran estados presentes', async () => {
    conActividad(mockActivity());
    renderLive();

    const grupo = await screen.findByRole('group', { name: 'Filtrar por estado' });
    const etiquetas = within(grupo).getAllByRole('button').map((chip) => chip.textContent.replace(/\d+$/, '').trim());
    expect(etiquetas).toEqual(['Caído', 'Trabado', 'Delegando', 'Trabajando', 'Libre']);
  });

  it('la flota en reposo se lee tranquila: «Libre», nunca «Ocioso» ni «Caído»', async () => {
    conActividad(mockActivityEnReposo());
    renderLive();

    expect(await screen.findByRole('button', { name: /^Libre \d+$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Caído/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/ocioso/i)).not.toBeInTheDocument();
  });
});

describe('la oficina', () => {
  it('es el objeto principal y ninguna tabla debajo la repite', async () => {
    conActividad(mockActivity());
    renderLive();

    const oficina = await screen.findByRole('region', { name: 'Oficina' });
    expect(oficina).toHaveAttribute('data-objeto-principal', 'oficina');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('enumera a cada agente con su estado para el lector de pantalla y se recorre con el teclado', async () => {
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderLive();

    const lista = await screen.findByRole('listbox', { name: /oficina con \d+ agentes/i });
    const opciones = within(lista).getAllByRole('option');
    const chips = within(screen.getByRole('group', { name: 'Filtrar por estado' })).getAllByRole('button');
    expect(opciones.length).toBe(chips.reduce((total, chip) => total + Number(/(\d+)$/.exec(chip.textContent)?.[1] ?? 0), 0));
    expect(within(lista).getByRole('option', { name: /^hegel: Trabado\./ })).toBeInTheDocument();

    lista.focus();
    await user.keyboard('{ArrowRight}');
    expect(opciones.map((opcion) => opcion.id)).toContain(lista.getAttribute('aria-activedescendant'));
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('agente')).toMatch(/\//);
  });
  it('trae controles de cámara con nombre y el modo paseo se activa con el botón o con la tecla P', async () => {
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderLive();

    const camara = await screen.findByRole('toolbar', { name: 'Cámara de la oficina' });
    for (const nombre of ['Acercar', 'Alejar', 'Ver toda la oficina', 'Centrar en mí']) {
      expect(within(camara).getByRole('button', { name: nombre })).toBeInTheDocument();
    }
    const paseo = within(camara).getByRole('button', { name: 'Modo paseo' });
    expect(paseo).toHaveAttribute('aria-pressed', 'false');
    await user.click(paseo);
    expect(paseo).toHaveAttribute('aria-pressed', 'true');

    const lista = screen.getByRole('listbox', { name: /oficina con \d+ agentes/i });
    expect(lista).toHaveAccessibleName(/modo paseo/i);
    lista.focus();
    await user.keyboard('p');
    expect(paseo).toHaveAttribute('aria-pressed', 'false');
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(lista).not.toHaveAttribute('aria-activedescendant');
  });
});

describe('la ficha del agente', () => {
  it('se abre desde la oficina, escribe el enlace profundo y lleva al chat, la terminal y el contexto', async () => {
    const user = userEvent.setup();
    conActividad(mockActivity());
    renderLive();

    const lista = await screen.findByRole('listbox', { name: /oficina con \d+ agentes/i });
    await user.click(within(lista).getByRole('option', { name: /^kant:/ }));
    const ficha = await screen.findByRole('dialog', { name: 'kant' });
    expect(window.location.search).toBe('?agente=Steven%2Fkant');
    expect(within(ficha).getByRole('link', { name: /abrir chat/i })).toHaveAttribute('href', '/messages/Steven/kant');
    expect(within(ficha).getByRole('link', { name: /abrir terminal/i })).toHaveAttribute('href', '/terminal/Steven/kant');
    expect(within(ficha).getByRole('link', { name: /perfil y contexto/i }))
      .toHaveAttribute('href', '/messages/Steven/kant?view=context');
    expect(within(ficha).queryByRole('tab', { name: /contexto|ficheros/i })).not.toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => { expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); });
    expect(window.location.search).toBe('');
  });

  it('reabre el agente que venía en la URL: el enlace se puede pegar en un chat', async () => {
    window.history.replaceState({}, '', '/live?agente=Jhon%2Fhegel');
    conActividad(mockActivity());
    renderLive();

    const ficha = await screen.findByRole('dialog', { name: 'hegel' });
    expect(within(ficha).getByText('Trabado')).toBeInTheDocument();
  });

  it('la pestaña Conexión trae epoch, instancia y lease sin otra ruta', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '/live?agente=Steven%2Fkant');
    conActividad(mockActivity());
    renderLive();

    const ficha = await screen.findByRole('dialog', { name: 'kant' });
    await user.click(within(ficha).getByRole('tab', { name: 'Conexión' }));
    for (const rotulo of ['Epoch', 'Instancia', 'Último latido', 'Lease vence', 'Capacidades']) {
      expect(within(ficha).getByText(rotulo)).toBeInTheDocument();
    }
  });

  it('NO ofrece acciones destructivas ni el texto de un encargo: la entrega se enlaza a Colas', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '/live?agente=Steven%2Fkant');
    conActividad(mockActivity());
    renderLive();

    const ficha = await screen.findByRole('dialog', { name: 'kant' });
    await user.click(within(ficha).getByRole('tab', { name: /^Entregas/ }));

    expect(within(ficha).getAllByRole('link', { name: /ver en colas/i })[0]).toHaveAttribute('href', expect.stringMatching(/^\/queues\?delivery=/));
    expect(within(ficha).queryByRole('button', { name: /reintentar|replay|cancelar/i })).not.toBeInTheDocument();
    expect(within(ficha).queryByText(/body|preview|cuerpo del mensaje/i)).not.toBeInTheDocument();
    expect(within(ficha).getByText(/argos \(Steven\), otro agente/)).toBeInTheDocument();
  });
});
