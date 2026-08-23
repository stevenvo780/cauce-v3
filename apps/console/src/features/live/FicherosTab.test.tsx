import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { mockActivity } from '../../mocks/data';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { LiveFleetPage } from './LiveFleetPage';

/**
 * El editor de ficheros se prueba DESDE la página viva y no aislado, por lo mismo que el editor
 * del rol declarado: la mitad del encargo es DÓNDE vive. Steven pidió un solo sitio, así que una
 * prueba del componente suelto pasaría igual con la pestaña desenganchada del cajón —que es
 * exactamente el estado del que viene todo esto: `agent-documents.ts` llevaba un día escrito con
 * su superficie HTTP en cero y ninguna prueba lo delataba—.
 */

const RUTA_MAPA = 'http://localhost/v3/console/agents/kant/documents';
const RUTA_CONTENIDO = 'http://localhost/v3/console/agents/kant/documents/directive/content';

function mapaDeKant(items: unknown[], extra: Record<string, unknown> = {}) {
  server.use(http.get(RUTA_MAPA, () => HttpResponse.json({
    tenant_id: 'Steven', alias: 'kant', facts_source: 'measured',
    harness: 'claude', home: '/home/stev', items, ...extra,
  })));
}

const CLAUDE_MD = {
  kind: 'directive',
  label: 'CLAUDE.md (manual del sitio)',
  path: '/home/stev/.claude/CLAUDE.md',
  format: 'markdown',
  editable: true,
};

const MCP_CERRADO = {
  kind: 'mcp',
  label: 'Servidores MCP',
  path: '/home/stev/.claude.json',
  format: 'json',
  editable: false,
  reason: 'Los MCP viven en `.claude.json`, junto al OAuth de la cuenta.',
};

beforeEach(() => {
  window.history.replaceState({}, '', '/live');
  server.use(http.get('http://localhost/v3/console/activity', () => HttpResponse.json(mockActivity())));
});

async function abrirFicheros() {
  const user = userEvent.setup();
  renderWithApi(<LiveFleetPage />);
  await screen.findByLabelText('Veredicto de la flota');
  await user.click(await screen.findByRole('row', { name: /kant/i }));
  const cajon = await screen.findByRole('complementary', { name: /detalle de kant/i });
  await user.click(within(cajon).getByRole('tab', { name: 'Ficheros' }));
  return { user, cajon };
}

it('la pestaña existe en el cajón y enseña el mapa de ficheros del alias', async () => {
  mapaDeKant([CLAUDE_MD, MCP_CERRADO]);
  const { cajon } = await abrirFicheros();

  expect(await within(cajon).findByText('CLAUDE.md (manual del sitio)')).toBeInTheDocument();
  expect(within(cajon).getByText('/home/stev/.claude/CLAUDE.md')).toBeInTheDocument();
  expect(window.location.pathname).toBe('/live');
});

/**
 * Un candado sin explicación es lo que hace que alguien pida por Telegram que le desbloqueen algo
 * que está cerrado a propósito. La razón se enseña SIEMPRE, sin desplegar nada.
 */
it('lo que no se puede tocar dice por qué, sin tener que abrirlo', async () => {
  mapaDeKant([CLAUDE_MD, MCP_CERRADO]);
  const { cajon } = await abrirFicheros();

  // Acotado a la FILA: el «hueco declarado» del pie también habla del OAuth, y una búsqueda a
  // secas encontraría los dos. Lo que hay que probar es que la razón viaja pegada al fichero.
  const fila = (await within(cajon).findByText('Servidores MCP')).closest('li');
  expect(fila).not.toBeNull();
  expect(within(fila as HTMLElement).getByText(/junto al OAuth de la cuenta/)).toBeInTheDocument();
  expect(within(fila as HTMLElement).getByText('sólo lectura')).toBeInTheDocument();
});

it('abre el fichero, lo edita y lo guarda mandando la huella de lo que abrió', async () => {
  mapaDeKant([CLAUDE_MD]);
  let recibido: { content?: string; expected_sha?: string } | undefined;
  server.use(
    http.get(RUTA_CONTENIDO, () => HttpResponse.json({
      tenant_id: 'Steven', alias: 'kant', kind: 'directive',
      path: '/home/stev/.claude/CLAUDE.md', format: 'markdown',
      exists: true, content: '# manual viejo\n', sha: 'huella-de-lo-abierto',
      bytes: 15, editable: true, projected: false,
    })),
    http.put(RUTA_CONTENIDO, async ({ request }) => {
      recibido = await request.json() as { content?: string; expected_sha?: string };
      return HttpResponse.json({ ok: true, path: '/home/stev/.claude/CLAUDE.md', sha: 'nueva', bytes: 9 });
    }),
  );

  const { user, cajon } = await abrirFicheros();
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));

  const caja = await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i) as HTMLTextAreaElement;
  expect(caja).toHaveValue('# manual viejo\n');

  await user.clear(caja);
  await user.type(caja, '# nuevo');
  await user.click(within(cajon).getByRole('button', { name: /Guardar/i }));

  await waitFor(() => expect(recibido).toBeDefined());
  expect(recibido?.content).toBe('# nuevo');
  // La huella de lo que se abrió VIAJA. Sin ella dos personas se pisan en silencio.
  expect(recibido?.expected_sha).toBe('huella-de-lo-abierto');
  expect(await within(cajon).findByText(/Guardado en/)).toBeInTheDocument();
});

/**
 * EL CASO QUE DECIDE SI ESTA PANTALLA ES HONESTA. Hoy el gateway no tiene camino hasta el disco
 * del agente y contesta 503. Lo fácil sería pintar una caja vacía con un botón de guardar: Steven
 * la leería como «este agente no tiene manual» y al guardar escribiría un fichero en blanco
 * encima del suyo.
 */
it('cuando no hay canal hasta el agente lo DICE, y no enseña una caja vacía', async () => {
  mapaDeKant([CLAUDE_MD]);
  server.use(http.get(RUTA_CONTENIDO, () => HttpResponse.json(
    { error: 'no_channel', message: 'La consola no tiene todavía ningún camino hasta el disco de este agente.' },
    { status: 503 },
  )));

  const { user, cajon } = await abrirFicheros();
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));

  expect(await within(cajon).findByText('Todavía no hay camino hasta el disco de este agente'))
    .toBeInTheDocument();
  expect(within(cajon).getByText(/La consola no tiene todavía ningún camino/)).toBeInTheDocument();
  // Y NO hay dónde escribir ni qué guardar.
  expect(within(cajon).queryByLabelText(/Contenido de CLAUDE\.md/i)).not.toBeInTheDocument();
  expect(within(cajon).queryByRole('button', { name: /^Guardar/i })).not.toBeInTheDocument();
});

it('si el fichero cambió mientras se editaba, lo dice y no finge que guardó', async () => {
  mapaDeKant([CLAUDE_MD]);
  server.use(
    http.get(RUTA_CONTENIDO, () => HttpResponse.json({
      tenant_id: 'Steven', alias: 'kant', kind: 'directive',
      path: '/home/stev/.claude/CLAUDE.md', format: 'markdown',
      exists: true, content: 'original', sha: 'vieja', bytes: 8, editable: true, projected: false,
    })),
    http.put(RUTA_CONTENIDO, () => HttpResponse.json(
      { error: 'stale', message: 'el fichero cambió desde que lo abriste' }, { status: 409 },
    )),
  );

  const { user, cajon } = await abrirFicheros();
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));
  const caja = await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i);
  await user.clear(caja);
  await user.type(caja, 'lo mio');
  await user.click(within(cajon).getByRole('button', { name: /Guardar/i }));

  expect(await within(cajon).findByText(/cambió mientras lo editabas/i)).toBeInTheDocument();
  expect(within(cajon).queryByText(/Guardado en/)).not.toBeInTheDocument();
});

/**
 * «No se miró» y «no tiene» se pintan igual de seguros y sólo uno es un hecho. Un gateway que no
 * publica la ruta NO puede convertirse en «este alias no tiene ficheros».
 */
it('un gateway que no publica la ruta no se pinta como «este alias no tiene ficheros»', async () => {
  server.use(http.get(RUTA_MAPA, () => HttpResponse.json({ error: 'not_found' }, { status: 404 })));
  const { cajon } = await abrirFicheros();

  const vacio = await within(cajon).findByText(/no publica el mapa de ficheros/i);
  // El texto se parte en varios nodos dentro del mismo párrafo, así que se comprueba sobre el
  // párrafo entero: lo que importa es que las DOS frases estén, no en qué etiqueta cayó cada una.
  const parrafo = vacio.closest('p') as HTMLElement;
  expect(parrafo.textContent).toMatch(/no publica el mapa de ficheros/i);
  expect(parrafo.textContent).toMatch(/desde aquí no se ha mirado/i);
});

it('cuando las rutas no están medidas, la cabecera lo advierte', async () => {
  mapaDeKant([CLAUDE_MD], {
    facts_source: 'database',
    caveat: 'Estas rutas están DEDUCIDAS del registro, no medidas dentro del contenedor.',
  });
  const { cajon } = await abrirFicheros();

  expect(await within(cajon).findByText(/DEDUCIDAS del registro/)).toBeInTheDocument();
});

/** El hueco declarado tiene que estar en la vista, no sólo en un comentario del código. */
it('la vista declara en castellano lo que todavía no hace', async () => {
  mapaDeKant([CLAUDE_MD]);
  const { cajon } = await abrirFicheros();

  const hueco = await within(cajon).findByLabelText(/Lo que esta vista todavía no hace/i);
  expect(within(hueco).getByText(/no se editan desde aquí/i)).toBeInTheDocument();
});
