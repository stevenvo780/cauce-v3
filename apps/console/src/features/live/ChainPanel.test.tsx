import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { mockChain } from '../../mocks/data';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { ChainPanel } from './ChainPanel';

it('dibuja la cadena salto a salto contra GET /v3/console/chains/:traceId', async () => {
  renderWithApi(<ChainPanel traceId="trace-2b7e4c19" />);

  const saltos = await screen.findByLabelText(/Saltos de la cadena/);
  expect(saltos).toHaveTextContent('zeus');
  expect(saltos).toHaveTextContent('socrates');
  expect(saltos).toHaveTextContent('salto 1 de 6');
});

it('el extremo que el operador no puede ver se NOMBRA como anónimo, no se borra de la cadena', async () => {
  // Borrar la arista haría que la cadena se vea más corta de lo que fue, y desde la pantalla no
  // habría forma de notar la diferencia. El store ya la redujo a un id opaco estable; la consola
  // sólo tiene que dibujarla como lo que es.
  renderWithApi(<ChainPanel traceId="trace-2b7e4c19" />);

  const saltos = await screen.findByLabelText(/Saltos de la cadena/);
  expect(saltos).toHaveTextContent(/otro cliente \(opaque-/);
  // Y los tres saltos siguen ahí: dos materializados y uno rechazado.
  expect(saltos.querySelectorAll('li')).toHaveLength(3);
});

it('declara cuántos saltos NO estás viendo, en vez de callarlo', async () => {
  renderWithApi(<ChainPanel traceId="trace-2b7e4c19" />);

  expect(await screen.findByText(/1 ocultos por permisos/)).toBeInTheDocument();
  expect(screen.getByText(/1 extremos anónimos/)).toBeInTheDocument();
});

it('una rama que no llegó a nadie se dice con esas palabras, con su código de rechazo', async () => {
  renderWithApi(<ChainPanel traceId="trace-2b7e4c19" />);

  const saltos = await screen.findByLabelText(/Saltos de la cadena/);
  expect(saltos).toHaveTextContent('no llegó a nadie');
  expect(saltos).toHaveTextContent('hop_budget_exhausted');
});

it('una cadena sin saltos visibles no se presenta como una cadena que no existe', async () => {
  server.use(http.get('http://localhost/v3/console/chains/:traceId', ({ params }) => HttpResponse.json({
    ...mockChain(String(params.traceId)),
    edges: [],
    counters: { edges: 0, hidden_edges: 4, redacted_endpoints: 0, open_branches: 0, rejected_branches: 0 },
  })));
  renderWithApi(<ChainPanel traceId="trace-oculta" />);

  expect(await screen.findByText(/ninguno de sus extremos cae dentro de lo que este operador puede leer/i))
    .toBeInTheDocument();
  expect(screen.getByText(/4 ocultos por permisos/)).toBeInTheDocument();
});

it('un fallo del endpoint se muestra como fallo, no como cadena vacía', async () => {
  server.use(http.get('http://localhost/v3/console/chains/:traceId', () =>
    HttpResponse.json({ error: 'not_found', message: 'agent chain not found or not visible' }, { status: 404 })));
  renderWithApi(<ChainPanel traceId="trace-inexistente" />);

  expect(await screen.findByRole('alert')).toHaveTextContent(/not visible/i);
});
