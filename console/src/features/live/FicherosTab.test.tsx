import { waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { abrirContexto as abrirPagina } from './context-test-utils';
import { MENSAJES_DE_APLICACION } from './perfil';

/**
 * The file editor is tested FROM the context page, because half the task is WHERE it lives: a loose
 * component test passes just as well with the section detached from the page, which is the state all
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
    harness: 'claude', home: '/home/dev', items, ...extra,
  })));
}

const CLAUDE_MD = {
  kind: 'directive',
  label: 'CLAUDE.md (manual del sitio)',
  path: '/home/dev/.claude/CLAUDE.md',
  format: 'markdown',
  readable: true,
  editable: true,
};

const MCP_CERRADO = {
  kind: 'mcp',
  label: 'Servidores MCP',
  path: '/home/dev/.claude.json',
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
  reason: 'Es parte de los campos canónicos: se cambia desde Perfil y se aplica como un lote.',
};

beforeEach(() => {
  window.history.replaceState({}, '', '/live');
});

async function abrirFicheros() {
  return abrirPagina('ficheros');
}

async function abrirContexto() {
  return abrirPagina('ficheros');
}

async function motivar(
  user: ReturnType<typeof userEvent.setup>,
  cajon: HTMLElement,
  texto = 'ajusto el manual de este alias',
) {
  await user.type(within(cajon).getByLabelText(/Motivo del guardado/i), texto);
}

/**
 * A lock without an explanation is what makes someone ask by Telegram to unlock something
 * that is closed on purpose. The reason is shown ALWAYS, without expanding anything.
 */
it('lo no servido dice por qué y no finge ser desplegable ni hace GET', async () => {
  const PROMPTS_DIRECTORIO = {
    kind: 'prompts', category: 'configuration', label: 'Subagentes (~/.claude/agents)',
    path: '/home/dev/.claude/agents', format: 'markdown', readable: false, editable: false,
    reason: 'Es un directorio; solo se lista, no se sirve como si fuera un fichero.',
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
  expect(within(fila as HTMLElement).getByText('Servidores MCP').closest('[aria-expanded]')).toBeNull();

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

it('abre el fichero, lo edita y lo guarda mandando la huella de lo que abrió', async () => {
  mapaDeKant([CLAUDE_MD]);
  let recibido: { content?: string; expected_sha?: string } | undefined;
  server.use(
    http.get(RUTA_CONTENIDO, () => HttpResponse.json({
      tenant_id: 'Steven', alias: 'kant', kind: 'directive',
      path: '/home/dev/.claude/CLAUDE.md', format: 'markdown',
      exists: true, content: '# manual viejo\n', sha: SHA_VIEJO,
      bytes: 15, editable: true, projected: false, truncated: false,
    })),
    http.put(RUTA_CONTENIDO, async ({ request }) => {
      recibido = await request.json() as { content?: string; expected_sha?: string };
      return HttpResponse.json({
        ok: true,
        state: 'applied',
        evidence: 'probe_write_ack',
        path: '/home/dev/.claude/CLAUDE.md',
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
      path: '/home/dev/.claude/CLAUDE.md', format: 'markdown',
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
        path: '/home/dev/.claude/CLAUDE.md',
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

it('si el fichero cambió mientras se editaba, lo dice y no finge que guardó', async () => {
  mapaDeKant([CLAUDE_MD]);
  server.use(
    http.get(RUTA_CONTENIDO, () => HttpResponse.json({
      tenant_id: 'Steven', alias: 'kant', kind: 'directive',
      path: '/home/dev/.claude/CLAUDE.md', format: 'markdown',
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

  expect(await within(cajon).findByText(/Alguien cambió este dato mientras lo editabas/i)).toBeInTheDocument();
  expect(within(cajon).queryByText(/Aplicado en/)).not.toBeInTheDocument();
  expect(caja).toHaveValue('lo mio');
  const conflicto = within(cajon).getByRole('group', { name: 'Conflicto de versión' });
  expect(conflicto).toHaveTextContent('original');
  await user.click(within(conflicto).getByRole('button', { name: 'Releer y reintentar con mis cambios' }));
  expect(await within(cajon).findByText(/Tu borrador quedó sobre la versión actual/i)).toBeInTheDocument();
  expect(caja).toHaveValue('lo mio');
});

it('un conflicto con el bloque canónico conserva el borrador y dirige a sus campos', async () => {
  mapaDeKant([CLAUDE_MD]);
  server.use(
    http.get(RUTA_CONTENIDO, () => HttpResponse.json({
      tenant_id: 'Steven', alias: 'kant', kind: 'directive',
      path: '/home/dev/.claude/CLAUDE.md', format: 'markdown',
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

  expect(await within(cajon).findByText(/bloque canónico se edita en Perfil/i)).toBeInTheDocument();
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
      path: '/home/dev/.claude/CLAUDE.md', format: 'markdown', exists: false,
      content: '', sha: null, bytes: 0, editable: true, projected: false, truncated: false,
    })),
    http.put(RUTA_CONTENIDO, async ({ request }) => {
      recibido = await request.json() as typeof recibido;
      return HttpResponse.json({
        ok: true, state: 'applied', evidence: 'probe_write_ack',
        path: '/home/dev/.claude/CLAUDE.md', sha: SHA_NUEVO, bytes: 7,
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
    path: '/home/dev/.claude/CLAUDE.md', format: 'markdown', exists: true,
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
      path: '/home/dev/.claude/CLAUDE.md', format: 'markdown', exists: true,
      content: 'viejo', sha: SHA_VIEJO, bytes: 5,
      editable: true, projected: false, truncated: false,
    })),
    http.put(RUTA_CONTENIDO, () => HttpResponse.json({ ok: true, path: '/home/dev/.claude/CLAUDE.md' })),
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

it('sin config.write acreditado deja inspeccionar pero bloquea edición y PUT', async () => {
  mapaDeKant([CLAUDE_MD]);
  let puts = 0;
  server.use(
    http.get('http://localhost/v3/console/access', () => HttpResponse.json({ authenticated: true })),
    http.get(RUTA_CONTENIDO, () => HttpResponse.json({
      tenant_id: 'Steven', alias: 'kant', kind: 'directive',
      path: '/home/dev/.claude/CLAUDE.md', format: 'markdown',
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
