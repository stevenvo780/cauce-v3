import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { mockActivity } from '../../mocks/data';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { LiveFleetPage } from './LiveFleetPage';

/**
 * El editor de ficheros se prueba DESDE la página viva y no aislado, por lo mismo que el editor
 * del rol declarado: la mitad del encargo es DÓNDE vive.  así que una
 * prueba del componente suelto pasaría igual con la pestaña desenganchada del cajón —que es
 * exactamente el estado del que viene todo esto: `agent-documents.ts` llevaba un día escrito con
 * su superficie HTTP en cero y ninguna prueba lo delataba—.
 */

const RUTA_MAPA = 'http://localhost/v3/console/tenants/Steven/agents/kant/documents';
const RUTA_CONTENIDO =
  'http://localhost/v3/console/tenants/Steven/agents/kant/documents/directive/content';
const rutaContenido = (kind: string) =>
  `http://localhost/v3/console/tenants/Steven/agents/kant/documents/${kind}/content`;
const SHA_VIEJO = 'a'.repeat(64);
const SHA_NUEVO = 'b'.repeat(64);

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
  readable: true,
  editable: true,
};

const MCP_CERRADO = {
  kind: 'mcp',
  label: 'Servidores MCP',
  path: '/home/stev/.claude.json',
  format: 'json',
  readable: false,
  editable: false,
  reason: 'Los MCP viven en `.claude.json`, junto al OAuth de la cuenta.',
};

const DIRECTIVA_DE_PROYECTO = {
  kind: 'directive',
  category: 'manual',
  label: 'AGENTS.md del proyecto',
  path: '/workspace/cauce-v3/AGENTS.md',
  format: 'markdown',
  readable: true,
  editable: false,
  reason: 'El proceso lo carga desde el proyecto; se inspecciona aquí sin reescribirlo.',
};

const IDENTIDAD_DE_PERFIL = {
  kind: 'identity',
  category: 'profile',
  label: 'Identidad (IDENTITY.md)',
  path: '/home/claw/workspace/IDENTITY.md',
  format: 'markdown',
  readable: true,
  editable: false,
  reason: 'Es parte del perfil canónico: se cambia desde Perfil y se aplica como un lote.',
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
it('lo no servido dice por qué y no finge ser desplegable ni hace GET', async () => {
  const PROMPTS_DIRECTORIO = {
    kind: 'prompts', category: 'configuration', label: 'Subagentes (~/.claude/agents)',
    path: '/home/stev/.claude/agents', format: 'markdown', readable: false, editable: false,
    reason: 'Es un directorio; sólo se lista, no se sirve como si fuera un fichero.',
  };
  mapaDeKant([CLAUDE_MD, MCP_CERRADO, PROMPTS_DIRECTORIO]);
  let gets = 0;
  server.use(
    http.get(rutaContenido('mcp'), () => { gets += 1; return HttpResponse.json({}); }),
    http.get(rutaContenido('prompts'), () => { gets += 1; return HttpResponse.json({}); }),
  );
  const { user, cajon } = await abrirFicheros();

  // Acotado a la FILA: el «hueco declarado» del pie también habla del OAuth, y una búsqueda a
  // secas encontraría los dos. Lo que hay que probar es que la razón viaja pegada al fichero.
  const fila = (await within(cajon).findByText('Servidores MCP')).closest('li');
  expect(fila).not.toBeNull();
  expect(within(fila as HTMLElement).getByText(/junto al OAuth de la cuenta/)).toBeInTheDocument();
  expect(within(fila as HTMLElement).getByText('no se sirve')).toBeInTheDocument();
  expect(within(fila as HTMLElement).queryByRole('button')).not.toBeInTheDocument();
  expect(within(fila as HTMLElement).getByText('Servidores MCP').closest('.ficheros-cabecera'))
    .not.toHaveAttribute('aria-expanded');

  const directorio = within(cajon).getByText('Subagentes (~/.claude/agents)').closest('li');
  expect(directorio).not.toBeNull();
  expect(within(directorio as HTMLElement).queryByRole('button')).not.toBeInTheDocument();
  await user.click(within(fila as HTMLElement).getByText('Servidores MCP'));
  await user.click(within(directorio as HTMLElement).getByText('Subagentes (~/.claude/agents)'));
  expect(gets).toBe(0);
});

it('abre manuales y perfil allowlisted en visor readonly, sin Guardar ni PUT', async () => {
  mapaDeKant([DIRECTIVA_DE_PROYECTO, IDENTIDAD_DE_PERFIL]);
  let puts = 0;
  server.use(
    http.get(RUTA_CONTENIDO, () => HttpResponse.json({
      tenant_id: 'Steven', alias: 'kant', kind: 'directive',
      path: '/workspace/cauce-v3/AGENTS.md', format: 'markdown', exists: true,
      content: '# reglas del proyecto\n', sha: SHA_VIEJO, bytes: 22,
      editable: false, projected: false, truncated: false,
    })),
    http.get(rutaContenido('identity'), () => HttpResponse.json({
      tenant_id: 'Steven', alias: 'kant', kind: 'identity',
      path: '/home/claw/workspace/IDENTITY.md', format: 'markdown', exists: true,
      content: '# identidad\n', sha: SHA_NUEVO, bytes: 12,
      editable: false, projected: false, truncated: false,
    })),
    http.put(/\/documents\/[^/]+\/content$/u, () => {
      puts += 1;
      return HttpResponse.json({ error: 'unexpected_put' }, { status: 500 });
    }),
  );

  const { user, cajon } = await abrirFicheros();
  await user.click(await within(cajon).findByText('AGENTS.md del proyecto'));
  const manual = await within(cajon).findByLabelText('Contenido de AGENTS.md del proyecto');
  expect(manual).toHaveValue('# reglas del proyecto\n');
  expect(manual).toHaveAttribute('readonly');
  expect(within(cajon).queryByRole('button', { name: /^Guardar/i })).not.toBeInTheDocument();

  await user.click(within(cajon).getByText('Identidad (IDENTITY.md)'));
  const perfil = await within(cajon).findByLabelText('Contenido de Identidad (IDENTITY.md)');
  expect(perfil).toHaveValue('# identidad\n');
  expect(perfil).toHaveAttribute('readonly');
  expect(within(cajon).queryByRole('button', { name: /^Guardar/i })).not.toBeInTheDocument();
  expect(puts).toBe(0);
});

it('un 200 malformado se muestra como fallo verificable, nunca como ausencia', async () => {
  mapaDeKant([IDENTIDAD_DE_PERFIL]);
  server.use(http.get(rutaContenido('identity'), () => HttpResponse.json({
    tenant_id: 'Steven', alias: 'kant', kind: 'identity',
    path: '/home/claw/workspace/IDENTITY.md', format: 'markdown', exists: true,
    // Sin content/sha/bytes: un cliente sin validación lo confundía con un documento vacío.
    editable: false, projected: false, truncated: false,
  })));

  const { user, cajon } = await abrirFicheros();
  await user.click(await within(cajon).findByText('Identidad (IDENTITY.md)'));

  expect(await within(cajon).findByText(/contenido de documento incompleto o incoherente/i))
    .toBeInTheDocument();
  expect(within(cajon).queryByText(/comprobó que este fichero todavía no existe/i))
    .not.toBeInTheDocument();
});

it('una sonda unavailable queda visible y tampoco se convierte en ausencia', async () => {
  mapaDeKant([IDENTIDAD_DE_PERFIL]);
  server.use(http.get(rutaContenido('identity'), () => HttpResponse.json(
    { error: 'unavailable', message: 'la sonda allowlisted no está conectada' }, { status: 503 },
  )));

  const { user, cajon } = await abrirFicheros();
  await user.click(await within(cajon).findByText('Identidad (IDENTITY.md)'));

  expect(await within(cajon).findByText(/Todavía no hay camino hasta el disco/i)).toBeInTheDocument();
  expect(within(cajon).getByText(/sonda allowlisted no está conectada/i)).toBeInTheDocument();
  expect(within(cajon).queryByText(/comprobó que este fichero todavía no existe/i))
    .not.toBeInTheDocument();
});

it('abre el fichero, lo edita y lo guarda mandando la huella de lo que abrió', async () => {
  mapaDeKant([CLAUDE_MD]);
  let recibido: { content?: string; expected_sha?: string } | undefined;
  server.use(
    http.get(RUTA_CONTENIDO, () => HttpResponse.json({
      tenant_id: 'Steven', alias: 'kant', kind: 'directive',
      path: '/home/stev/.claude/CLAUDE.md', format: 'markdown',
      exists: true, content: '# manual viejo\n', sha: SHA_VIEJO,
      bytes: 15, editable: true, projected: false, truncated: false,
    })),
    http.put(RUTA_CONTENIDO, async ({ request }) => {
      recibido = await request.json() as { content?: string; expected_sha?: string };
      return HttpResponse.json({
        ok: true,
        state: 'applied',
        evidence: 'probe_write_ack',
        path: '/home/stev/.claude/CLAUDE.md',
        sha: SHA_NUEVO,
        bytes: 9,
      });
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
  expect(recibido?.expected_sha).toBe(SHA_VIEJO);
  expect(await within(cajon).findByText(/Aplicado en/)).toBeInTheDocument();
  expect(within(cajon).getByText(/ACK de escritura/)).toBeInTheDocument();
});

/**
 * EL CASO QUE DECIDE SI ESTA PANTALLA ES HONESTA. Si el relay/pty-agent no está disponible, el
 * gateway contesta 503. Lo fácil sería pintar una caja vacía con un botón de guardar: Steven
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
      exists: true, content: 'original', sha: SHA_VIEJO, bytes: 8,
      editable: true, projected: false, truncated: false,
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
  expect(within(cajon).queryByText(/Aplicado en/)).not.toBeInTheDocument();
});

it('un fichero ausente se crea con create_if_absent, nunca como reemplazo sin SHA', async () => {
  mapaDeKant([CLAUDE_MD]);
  let recibido: { content?: string; create_if_absent?: boolean; expected_sha?: string } | undefined;
  server.use(
    http.get(RUTA_CONTENIDO, () => HttpResponse.json({
      tenant_id: 'Steven', alias: 'kant', kind: 'directive',
      path: '/home/stev/.claude/CLAUDE.md', format: 'markdown', exists: false,
      content: '', sha: null, bytes: 0, editable: true, projected: false, truncated: false,
    })),
    http.put(RUTA_CONTENIDO, async ({ request }) => {
      recibido = await request.json() as typeof recibido;
      return HttpResponse.json({
        ok: true, state: 'applied', evidence: 'probe_write_ack',
        path: '/home/stev/.claude/CLAUDE.md', sha: SHA_NUEVO, bytes: 7,
      });
    }),
  );
  const { user, cajon } = await abrirFicheros();
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));
  const caja = await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i);
  await user.type(caja, '# nuevo');
  await user.click(within(cajon).getByRole('button', { name: /Guardar/i }));

  await waitFor(() => expect(recibido).toBeDefined());
  expect(recibido).toEqual({ content: '# nuevo', create_if_absent: true });
});

it('un contenido truncado se enseña pero nunca queda editable ni guardable', async () => {
  mapaDeKant([CLAUDE_MD]);
  server.use(http.get(RUTA_CONTENIDO, () => HttpResponse.json({
    tenant_id: 'Steven', alias: 'kant', kind: 'directive',
    path: '/home/stev/.claude/CLAUDE.md', format: 'markdown', exists: true,
    content: 'prefijo', sha: SHA_VIEJO, bytes: 900_000,
    editable: false, projected: false, truncated: true,
  })));
  const { user, cajon } = await abrirFicheros();
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));

  const caja = await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i);
  expect(caja).toHaveAttribute('readonly');
  expect(await within(cajon).findByRole('alert')).toHaveTextContent(/lectura está recortada/i);
  expect(within(cajon).getByRole('button', { name: /Guardar/i })).toBeDisabled();
});

it('un 2xx sin ACK completo conserva el borrador sucio y no afirma aplicado', async () => {
  mapaDeKant([CLAUDE_MD]);
  server.use(
    http.get(RUTA_CONTENIDO, () => HttpResponse.json({
      tenant_id: 'Steven', alias: 'kant', kind: 'directive',
      path: '/home/stev/.claude/CLAUDE.md', format: 'markdown', exists: true,
      content: 'viejo', sha: SHA_VIEJO, bytes: 5,
      editable: true, projected: false, truncated: false,
    })),
    http.put(RUTA_CONTENIDO, () => HttpResponse.json({ ok: true, path: '/home/stev/.claude/CLAUDE.md' })),
  );
  const { user, cajon } = await abrirFicheros();
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));
  const caja = await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i);
  await user.clear(caja);
  await user.type(caja, 'nuevo');
  await user.click(within(cajon).getByRole('button', { name: /Guardar/i }));

  expect(await within(cajon).findByText(/no confirmó la aplicación/i)).toBeInTheDocument();
  expect(caja).toHaveValue('nuevo');
  expect(within(cajon).getByRole('button', { name: /Guardar/i })).toBeEnabled();
  expect(within(cajon).queryByText(/Aplicado en/)).not.toBeInTheDocument();
});

/**
 * «No se miró» y «no tiene» se pintan igual de seguros y sólo uno es un hecho. Un gateway que no
 * publica la ruta NO puede convertirse en «este alias no tiene ficheros».
 */
it('un gateway que no publica la ruta no se pinta como «este alias no tiene ficheros»', async () => {
  server.use(http.get(RUTA_MAPA, () => HttpResponse.json({ error: 'Not Found' }, { status: 404 })));
  const { cajon } = await abrirFicheros();

  const vacio = await within(cajon).findByText(/no publica el mapa de ficheros/i);
  // El texto se parte en varios nodos dentro del mismo párrafo, así que se comprueba sobre el
  // párrafo entero: lo que importa es que las DOS frases estén, no en qué etiqueta cayó cada una.
  const parrafo = vacio.closest('p') as HTMLElement;
  expect(parrafo.textContent).toMatch(/no publica el mapa de ficheros/i);
  expect(parrafo.textContent).toMatch(/desde aquí no se ha mirado/i);
});

it('un 404 del manejador se conserva como alias ausente o denegado, no como ruta sin publicar', async () => {
  server.use(http.get(RUTA_MAPA, () => HttpResponse.json(
    { error: 'not_found', message: 'agent not found or not visible' }, { status: 404 },
  )));

  const { cajon } = await abrirFicheros();

  expect(await within(cajon).findByText(/no existe en ese tenant o no es visible/i))
    .toBeInTheDocument();
  expect(within(cajon).queryByText(/no publica el mapa de ficheros/i)).not.toBeInTheDocument();
});

it('cuando las rutas no están medidas, la cabecera lo advierte', async () => {
  mapaDeKant([CLAUDE_MD], {
    facts_source: 'database',
    caveat: 'Estas rutas están DEDUCIDAS del registro, no medidas dentro del contenedor.',
  });
  const { cajon } = await abrirFicheros();

  expect(await within(cajon).findByText(/DEDUCIDAS del registro/)).toBeInTheDocument();
});

it('sin config.write acreditado deja inspeccionar pero bloquea edición y PUT', async () => {
  mapaDeKant([CLAUDE_MD]);
  let puts = 0;
  server.use(
    http.get('http://localhost/v3/console/access', () => HttpResponse.json({ authenticated: true })),
    http.get(RUTA_CONTENIDO, () => HttpResponse.json({
      tenant_id: 'Steven', alias: 'kant', kind: 'directive',
      path: '/home/stev/.claude/CLAUDE.md', format: 'markdown',
      exists: true, content: '# visible\n', sha: SHA_VIEJO, bytes: 10,
      editable: true, projected: false, truncated: false,
    })),
    http.put(RUTA_CONTENIDO, () => {
      puts += 1;
      return HttpResponse.json({ error: 'forbidden' }, { status: 403 });
    }),
  );

  const { user, cajon } = await abrirFicheros();
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));

  const caja = await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i);
  expect(caja).toHaveAttribute('readonly');
  expect(within(cajon).getByText(/No se pudo acreditar config\.write/)).toBeInTheDocument();
  expect(within(cajon).getByRole('button', { name: /Guardar/i })).toBeDisabled();
  expect(puts).toBe(0);
});

/** El hueco declarado tiene que estar en la vista, no sólo en un comentario del código. */
it('la vista declara en castellano lo que todavía no hace', async () => {
  mapaDeKant([CLAUDE_MD]);
  const { cajon } = await abrirFicheros();

  const hueco = await within(cajon).findByLabelText(/Lo que esta vista todavía no hace/i);
  expect(within(hueco).getByText(/no se editan desde aquí/i)).toBeInTheDocument();
});
