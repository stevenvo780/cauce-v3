import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { mockActivity } from '../../mocks/data';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { LiveFleetPage } from './LiveFleetPage';
import { MENSAJES_DE_APLICACION } from './perfil';

/**
 * The file editor is tested FROM the live page, because half the task is WHERE it lives: a loose
 * component test passes just as well with the tab detached from the drawer, which is the state all
 * this comes from — `agent-documents.ts` lived a day with its HTTP surface at zero.
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
  reason: 'Es parte de los campos canónicos: se cambia desde Contexto y se aplica como un lote.',
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
  const cajon = await screen.findByRole('dialog', { name: /detalle de kant/i });
  await user.click(within(cajon).getByRole('tab', { name: 'Ficheros' }));
  return { user, cajon };
}

async function abrirContexto() {
  const user = userEvent.setup();
  renderWithApi(<LiveFleetPage />);
  await screen.findByLabelText('Veredicto de la flota');
  await user.click(await screen.findByRole('row', { name: /kant/i }));
  const cajon = await screen.findByRole('dialog', { name: /detalle de kant/i });
  await user.click(within(cajon).getByRole('tab', { name: 'Contexto' }));
  return { user, cajon };
}

async function motivar(
  user: ReturnType<typeof userEvent.setup>,
  cajon: HTMLElement,
  texto = 'ajusto el manual de este alias',
) {
  await user.type(within(cajon).getByLabelText(/Motivo del guardado/i), texto);
}

it('la pestaña existe en el cajón y enseña el mapa de ficheros del alias', async () => {
  mapaDeKant([CLAUDE_MD, MCP_CERRADO]);
  const { cajon } = await abrirFicheros();

  expect(await within(cajon).findByText('CLAUDE.md (manual del sitio)')).toBeInTheDocument();
  expect(within(cajon).getByText('/home/stev/.claude/CLAUDE.md')).toBeInTheDocument();
  expect(window.location.pathname).toBe('/live');
});

/**
 * A lock without an explanation is what makes someone ask by Telegram to unlock something
 * that is closed on purpose. The reason is shown ALWAYS, without expanding anything.
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

  // Scoped to the ROW: the "declared gap" in the footer also talks about OAuth, and a plain
  // search would find both. What must be tested is that the reason travels attached to the file.
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
  expect(within(cajon).queryByRole('button', { name: /^Guardar$/i })).not.toBeInTheDocument();

  await user.click(within(cajon).getByText('Identidad (IDENTITY.md)'));
  const perfil = await within(cajon).findByLabelText('Contenido de Identidad (IDENTITY.md)');
  expect(perfil).toHaveValue('# identidad\n');
  expect(perfil).toHaveAttribute('readonly');
  expect(within(cajon).queryByRole('button', { name: /^Guardar$/i })).not.toBeInTheDocument();
  expect(puts).toBe(0);
});

it('un 200 malformado se muestra como fallo verificable, nunca como ausencia', async () => {
  mapaDeKant([IDENTIDAD_DE_PERFIL]);
  server.use(http.get(rutaContenido('identity'), () => HttpResponse.json({
    tenant_id: 'Steven', alias: 'kant', kind: 'identity',
    path: '/home/claw/workspace/IDENTITY.md', format: 'markdown', exists: true,
    // No content/sha/bytes: a client without validation confused it with an empty document.
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

  const { user, cajon } = await abrirContexto();
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));

  const caja = await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i);
  expect(caja).toHaveValue('# manual viejo\n');

  await user.clear(caja);
  await user.type(caja, '# nuevo');
  await motivar(user, cajon);
  await user.click(within(cajon).getByRole('button', { name: /^Guardar$/i }));

  await waitFor(() => { expect(recibido).toBeDefined(); });
  expect(recibido?.content).toBe('# nuevo');
  // The fingerprint of what was opened TRAVELS. Without it two people step on each other silently.
  expect(recibido?.expected_sha).toBe(SHA_VIEJO);
  expect(await within(cajon).findByText(/Aplicado en/)).toBeInTheDocument();
  expect(within(cajon).getByText(/ACK de escritura/)).toBeInTheDocument();
});

/**
 * THE CASE THAT DECIDES IF THIS SCREEN IS HONEST. With no relay the gateway answers 503, and an
 * empty box with a save button would read as "this agent has no manual" and save a blank over it.
 */
/**
 * THE 202 IS A SAVE. Painting it as a failure showed a successful save in red, left `servido` with
 * the old fingerprint and made the obvious retry answer 409 against a SHA no longer on disk.
 */
it('un 202 written_pending_session guarda, lo dice sin fingir aplicación y deja reintentar', async () => {
  mapaDeKant([CLAUDE_MD]);
  const enviados: { content?: string; expected_sha?: string }[] = [];
  let enDisco = { texto: '# manual viejo\n', sha: SHA_VIEJO };
  server.use(
    http.get(RUTA_CONTENIDO, () => HttpResponse.json({
      tenant_id: 'Steven', alias: 'kant', kind: 'directive',
      path: '/home/stev/.claude/CLAUDE.md', format: 'markdown',
      exists: true, content: enDisco.texto, sha: enDisco.sha,
      bytes: new TextEncoder().encode(enDisco.texto).byteLength,
      editable: true, projected: false, truncated: false,
    })),
    http.put(RUTA_CONTENIDO, async ({ request }) => {
      const cuerpo = await request.json() as { content: string; expected_sha?: string };
      enviados.push(cuerpo);
      if (cuerpo.expected_sha !== enDisco.sha) {
        return HttpResponse.json(
          { error: 'conflict', message: 'el fichero cambió desde que se abrió; hay que releerlo' },
          { status: 409 },
        );
      }
      enDisco = { texto: cuerpo.content, sha: SHA_NUEVO };
      return HttpResponse.json({
        ok: true,
        state: 'written_pending_session',
        evidence: 'probe_write_ack',
        path: '/home/stev/.claude/CLAUDE.md',
        sha: SHA_NUEVO,
        bytes: new TextEncoder().encode(cuerpo.content).byteLength,
      }, { status: 202 });
    }),
  );

  const { user, cajon } = await abrirContexto();
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));
  const caja = await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i);
  await user.clear(caja);
  await user.type(caja, '# nuevo');
  await motivar(user, cajon);
  await user.click(within(cajon).getByRole('button', { name: /^Guardar$/i }));

  expect(await within(cajon).findByText(/Escrito en .*bytes/)).toBeInTheDocument();
  expect(cajon.textContent).toContain(MENSAJES_DE_APLICACION.written_pending_session);
  expect(within(cajon).queryByText(/Aplicado en/)).not.toBeInTheDocument();
  expect(within(cajon).queryByText(/no confirmó la escritura/)).not.toBeInTheDocument();

  expect(within(cajon).queryByText('borrador sin guardar')).not.toBeInTheDocument();
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));
  const reabierta = await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i);
  await waitFor(() => { expect(reabierta).toHaveValue('# nuevo'); });
  expect(within(cajon).getByRole('button', { name: /^Guardar$/i })).toBeDisabled();

  await user.type(reabierta, ' otra vez');
  await motivar(user, cajon);
  await user.click(within(cajon).getByRole('button', { name: /^Guardar$/i }));

  await waitFor(() => { expect(enviados).toHaveLength(2); });
  // El reintento no choca: viaja la huella que devolvió la escritura, no la que ya no existe.
  expect(enviados[1]?.expected_sha).toBe(SHA_NUEVO);
  expect(enviados[1]?.content).toBe('# nuevo otra vez');
  expect(within(cajon).queryByText(/Alguien lo cambió mientras lo editabas/))
    .not.toBeInTheDocument();
});

it('cuando no hay canal hasta el agente lo DICE, y no enseña una caja vacía', async () => {
  mapaDeKant([CLAUDE_MD]);
  server.use(http.get(RUTA_CONTENIDO, () => HttpResponse.json(
    { error: 'no_channel', message: 'La consola no tiene todavía ningún camino hasta el disco de este agente.' },
    { status: 503 },
  )));

  const { user, cajon } = await abrirContexto();
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));

  expect(await within(cajon).findByText('Todavía no hay camino hasta el disco de este agente'))
    .toBeInTheDocument();
  expect(within(cajon).getByText(/La consola no tiene todavía ningún camino/)).toBeInTheDocument();
  // And there is nowhere to write and nothing to save.
  expect(within(cajon).queryByLabelText(/Contenido de CLAUDE\.md/i)).not.toBeInTheDocument();
  expect(within(cajon).queryByRole('button', { name: /^Guardar$/i })).not.toBeInTheDocument();
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

  const { user, cajon } = await abrirContexto();
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));
  const caja = await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i);
  await user.clear(caja);
  await user.type(caja, 'lo mio');
  await motivar(user, cajon);
  await user.click(within(cajon).getByRole('button', { name: /^Guardar$/i }));

  expect(await within(cajon).findByText(/cambió mientras lo editabas/i)).toBeInTheDocument();
  expect(within(cajon).queryByText(/Aplicado en/)).not.toBeInTheDocument();
});

it('un conflicto con el bloque canónico conserva el borrador y dirige a sus campos', async () => {
  mapaDeKant([CLAUDE_MD]);
  server.use(
    http.get(RUTA_CONTENIDO, () => HttpResponse.json({
      tenant_id: 'Steven', alias: 'kant', kind: 'directive',
      path: '/home/stev/.claude/CLAUDE.md', format: 'markdown',
      exists: true, content: 'original', sha: SHA_VIEJO, bytes: 8,
      editable: true, projected: false, truncated: false,
    })),
    http.put(RUTA_CONTENIDO, () => HttpResponse.json({
      error: 'managed_context_conflict',
      message: 'el texto invade un bloque gobernado por el perfil',
    }, { status: 409 })),
  );

  const { user, cajon } = await abrirContexto();
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));
  const caja = await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i);
  await user.clear(caja);
  await user.type(caja, 'mi manual');
  await motivar(user, cajon);
  await user.click(within(cajon).getByRole('button', { name: /^Guardar$/i }));

  expect(await within(cajon).findByText(/bloque canónico se edita en Contexto/i)).toBeInTheDocument();
  expect(within(cajon).getByText(/manual conserva el borrador/i)).toBeInTheDocument();
  expect(caja).toHaveValue('mi manual');
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
  const { user, cajon } = await abrirContexto();
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));
  const caja = await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i);
  await user.type(caja, '# nuevo');
  await motivar(user, cajon);
  await user.click(within(cajon).getByRole('button', { name: /^Guardar$/i }));

  await waitFor(() => { expect(recibido).toBeDefined(); });
  expect(recibido).toEqual({
    content: '# nuevo', reason: 'ajusto el manual de este alias', create_if_absent: true,
  });
});

it('un contenido truncado se enseña pero nunca queda editable ni guardable', async () => {
  mapaDeKant([CLAUDE_MD]);
  server.use(http.get(RUTA_CONTENIDO, () => HttpResponse.json({
    tenant_id: 'Steven', alias: 'kant', kind: 'directive',
    path: '/home/stev/.claude/CLAUDE.md', format: 'markdown', exists: true,
    content: 'prefijo', sha: SHA_VIEJO, bytes: 900_000,
    editable: false, projected: false, truncated: true,
  })));
  const { user, cajon } = await abrirContexto();
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));

  const caja = await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i);
  expect(caja).toHaveAttribute('readonly');
  expect(await within(cajon).findByText(/Esta lectura está recortada/i)).toBeInTheDocument();
  expect(within(cajon).getByRole('button', { name: /^Guardar$/i })).toBeDisabled();
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
  const { user, cajon } = await abrirContexto();
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));
  const caja = await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i);
  await user.clear(caja);
  await user.type(caja, 'nuevo');
  await motivar(user, cajon);
  await user.click(within(cajon).getByRole('button', { name: /^Guardar$/i }));

  expect(await within(cajon).findByText(/no confirmó la escritura/i)).toBeInTheDocument();
  expect(caja).toHaveValue('nuevo');
  expect(within(cajon).getByRole('button', { name: /^Guardar$/i })).toBeEnabled();
  expect(within(cajon).queryByText(/Aplicado en/)).not.toBeInTheDocument();
});

/**
 * "Not looked at" and "doesn't have" are painted equally safely and only one is a fact. A
 * gateway that does not publish the route CANNOT become "this alias has no files".
 */
it('un gateway que no publica la ruta no se pinta como «este alias no tiene ficheros»', async () => {
  server.use(http.get(RUTA_MAPA, () => HttpResponse.json({ error: 'Not Found' }, { status: 404 })));
  const { cajon } = await abrirFicheros();

  const vacio = await within(cajon).findByText(/no publica el mapa de ficheros/i);
  // Checked on the whole paragraph: what matters is that BOTH sentences are there.
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

  const { user, cajon } = await abrirContexto();
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));

  const caja = await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i);
  expect(caja).toHaveAttribute('readonly');
  expect(within(cajon).getByText(/No se pudo acreditar config\.write/)).toBeInTheDocument();
  expect(within(cajon).queryByRole('button', { name: /^Guardar$/i })).not.toBeInTheDocument();
  expect(puts).toBe(0);
});

/** The declared gap must be on the view, not only in a code comment. */
it('la vista declara en castellano lo que todavía no hace', async () => {
  mapaDeKant([CLAUDE_MD]);
  const { cajon } = await abrirFicheros();

  const hueco = await within(cajon).findByLabelText(/Lo que esta vista todavía no hace/i);
  expect(within(hueco).getByText(/no se editan desde aquí/i)).toBeInTheDocument();
});

it('un 413 al guardar dice el tope y NO se lleva por delante lo escrito', async () => {
  mapaDeKant([CLAUDE_MD]);
  server.use(
    http.get(RUTA_CONTENIDO, () => HttpResponse.json({
      tenant_id: 'Steven', alias: 'kant', kind: 'directive',
      path: '/home/stev/.claude/CLAUDE.md', format: 'markdown',
      exists: true, content: 'corto', sha: SHA_VIEJO, bytes: 5,
      editable: true, projected: false, truncated: false,
    })),
    http.put(RUTA_CONTENIDO, () => HttpResponse.json(
      { error: 'too_large', message: 'el contenido se pasa del tope de 256 KiB' }, { status: 413 },
    )),
  );

  const { user, cajon } = await abrirContexto();
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));
  const caja = await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i);
  await user.clear(caja);
  await user.type(caja, 'lo que no cabe');
  await motivar(user, cajon);
  await user.click(within(cajon).getByRole('button', { name: /^Guardar$/i }));

  expect(await within(cajon).findByText(/El fichero pasa del tope/)).toBeInTheDocument();
  expect(within(cajon).getByText(/se pasa del tope de 256 KiB/)).toBeInTheDocument();
  expect(caja).toHaveValue('lo que no cabe');
  expect(within(cajon).queryByText(/Aplicado en/)).not.toBeInTheDocument();
});

it('un 403 de la política de rutas se explica como decisión, no como avería', async () => {
  mapaDeKant([CLAUDE_MD]);
  server.use(
    http.get(RUTA_CONTENIDO, () => HttpResponse.json({
      tenant_id: 'Steven', alias: 'kant', kind: 'directive',
      path: '/home/stev/.claude/CLAUDE.md', format: 'markdown',
      exists: true, content: 'corto', sha: SHA_VIEJO, bytes: 5,
      editable: true, projected: false, truncated: false,
    })),
    http.put(RUTA_CONTENIDO, () => HttpResponse.json(
      { error: 'forbidden', message: 'esa ruta mezcla configuración con credenciales' }, { status: 403 },
    )),
  );

  const { user, cajon } = await abrirContexto();
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));
  const caja = await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i);
  await user.clear(caja);
  await user.type(caja, 'mio');
  await motivar(user, cajon);
  await user.click(within(cajon).getByRole('button', { name: /^Guardar$/i }));

  expect(await within(cajon).findByText(/no se sirve por esta vía/)).toBeInTheDocument();
  expect(within(cajon).getByText(/mezcla configuración con credenciales/)).toBeInTheDocument();
  expect(caja).toHaveValue('mio');
});

it('una ruta sin medir se distingue de un fichero que no está', async () => {
  mapaDeKant([CLAUDE_MD]);
  server.use(http.get(RUTA_CONTENIDO, () => HttpResponse.json(
    { error: 'facts_not_measured', message: 'nadie midió qué arnés corre este alias' }, { status: 409 },
  )));

  const { user, cajon } = await abrirContexto();
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));

  expect(await within(cajon).findByText(/no está medida/)).toBeInTheDocument();
  expect(within(cajon).getByText(/nadie midió qué arnés corre este alias/)).toBeInTheDocument();
  expect(within(cajon).queryByLabelText(/Contenido de CLAUDE\.md/i)).not.toBeInTheDocument();
});

it('el visor de un fichero que no está lo dice y deja volver a comprobarlo', async () => {
  mapaDeKant([IDENTIDAD_DE_PERFIL]);
  let existe = false;
  server.use(http.get(rutaContenido('identity'), () => HttpResponse.json({
    tenant_id: 'Steven', alias: 'kant', kind: 'identity',
    path: '/home/claw/workspace/IDENTITY.md', format: 'markdown',
    exists: existe, content: existe ? '# identidad\n' : '',
    sha: existe ? SHA_NUEVO : null, bytes: existe ? 12 : 0,
    editable: false, projected: false, truncated: false,
  })));

  const { user, cajon } = await abrirFicheros();
  await user.click(await within(cajon).findByText('Identidad (IDENTITY.md)'));

  expect(await within(cajon).findByText(/todavía no existe/)).toBeInTheDocument();
  expect(within(cajon).queryByLabelText(/Contenido de Identidad/i)).not.toBeInTheDocument();

  existe = true;
  await user.click(within(cajon).getByRole('button', { name: /Volver a comprobar/i }));

  expect(await within(cajon).findByLabelText(/Contenido de Identidad/i)).toHaveValue('# identidad\n');
});

it('el visor avisa de que lo recortado es un prefijo, y no ofrece guardarlo', async () => {
  mapaDeKant([IDENTIDAD_DE_PERFIL]);
  server.use(http.get(rutaContenido('identity'), () => HttpResponse.json({
    tenant_id: 'Steven', alias: 'kant', kind: 'identity',
    path: '/home/claw/workspace/IDENTITY.md', format: 'markdown', exists: true,
    content: 'prefijo', sha: SHA_NUEVO, bytes: 900_000,
    editable: false, projected: false, truncated: true,
  })));

  const { user, cajon } = await abrirFicheros();
  await user.click(await within(cajon).findByText('Identidad (IDENTITY.md)'));

  expect(await within(cajon).findByRole('alert')).toHaveTextContent(/lectura está recortada/i);
  expect(within(cajon).getByLabelText(/Contenido de Identidad/i)).toHaveAttribute('readonly');
  expect(within(cajon).getByText(/prefijo recortado/)).toBeInTheDocument();
  expect(within(cajon).queryByRole('button', { name: /^Guardar$/i })).not.toBeInTheDocument();
});

it('un 202 del manual pinta el mismo aviso de sesión sin adoptar que el perfil', async () => {
  mapaDeKant([CLAUDE_MD]);
  server.use(
    http.get(RUTA_CONTENIDO, () => HttpResponse.json({
      tenant_id: 'Steven', alias: 'kant', kind: 'directive',
      path: '/home/stev/.claude/CLAUDE.md', format: 'markdown',
      exists: true, content: '# manual viejo\n', sha: SHA_VIEJO, bytes: 15,
      editable: true, projected: false, truncated: false,
    })),
    http.put(RUTA_CONTENIDO, () => HttpResponse.json({
      ok: true, state: 'written_pending_session', evidence: 'probe_write_ack',
      path: '/home/stev/.claude/CLAUDE.md', sha: SHA_NUEVO, bytes: 7,
    }, { status: 202 })),
  );

  const { user, cajon } = await abrirContexto();
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));
  const caja = await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i);
  await user.clear(caja);
  await user.type(caja, '# nuevo');
  await motivar(user, cajon);
  await user.click(within(cajon).getByRole('button', { name: /^Guardar$/i }));

  const aviso = await within(cajon).findByText(/Sesión sin adoptar todavía/i);
  expect(aviso).toHaveTextContent(MENSAJES_DE_APLICACION.written_pending_session);
});

it('CONTROL NEGATIVO: un guardado aplicado no pinta el aviso de sesión sin adoptar', async () => {
  mapaDeKant([CLAUDE_MD]);
  server.use(
    http.get(RUTA_CONTENIDO, () => HttpResponse.json({
      tenant_id: 'Steven', alias: 'kant', kind: 'directive',
      path: '/home/stev/.claude/CLAUDE.md', format: 'markdown',
      exists: true, content: '# manual viejo\n', sha: SHA_VIEJO, bytes: 15,
      editable: true, projected: false, truncated: false,
    })),
    http.put(RUTA_CONTENIDO, () => HttpResponse.json({
      ok: true, state: 'applied', evidence: 'probe_write_ack',
      path: '/home/stev/.claude/CLAUDE.md', sha: SHA_NUEVO, bytes: 7,
    })),
  );

  const { user, cajon } = await abrirContexto();
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));
  const caja = await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i);
  await user.clear(caja);
  await user.type(caja, '# nuevo');
  await motivar(user, cajon);
  await user.click(within(cajon).getByRole('button', { name: /^Guardar$/i }));

  expect(await within(cajon).findByText(/Aplicado en/)).toBeInTheDocument();
  expect(within(cajon).queryByText(/Sesión sin adoptar todavía/i)).not.toBeInTheDocument();
});
