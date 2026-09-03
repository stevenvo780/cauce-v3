import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { mockActivity } from '../../mocks/data';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { LiveFleetPage } from './LiveFleetPage';

/**
 * WHAT WAS WRITTEN AND NOT YET SAVED DOES NOT DISAPPEAR ON ITS OWN.
 *
 * The draft used to live inside the editor, which the drawer unmounts on every tab change and the
 * accordion unmounts on every fold: half a manual rewritten by hand vanished with no warning and
 * with nothing to blame. It now lives on the page, indexed by alias and document kind, exactly
 * like the profile one.
 */

const SHA = 'a'.repeat(64);
const rutaMapa = (alias: string) =>
  `http://localhost/v3/console/tenants/Steven/agents/${alias}/documents`;
const rutaContenido = (alias: string, kind: string) =>
  `http://localhost/v3/console/tenants/Steven/agents/${alias}/documents/${kind}/content`;

const CLAUDE_MD = {
  kind: 'directive', category: 'manual', label: 'CLAUDE.md (manual del sitio)',
  path: '/home/stev/.claude/CLAUDE.md', format: 'markdown', readable: true, editable: true,
};

const IDENTIDAD = {
  kind: 'identity', category: 'profile', label: 'Identidad (IDENTITY.md)',
  path: '/home/stev/workspace/IDENTITY.md', format: 'markdown', readable: true, editable: false,
  reason: 'Es parte de los campos canónicos: se cambia desde Contexto.',
};

function contenido(alias: string, texto: string) {
  return {
    tenant_id: 'Steven', alias, kind: 'directive', path: '/home/stev/.claude/CLAUDE.md',
    format: 'markdown', exists: true, content: texto, sha: SHA,
    bytes: new TextEncoder().encode(texto).byteLength,
    editable: true, projected: false, truncated: false,
  };
}

function mapaDe(alias: string, items: unknown[]) {
  server.use(http.get(rutaMapa(alias), () => HttpResponse.json({
    tenant_id: 'Steven', alias, facts_source: 'measured', harness: 'claude',
    home: '/home/stev', items,
  })));
}

beforeEach(() => {
  window.history.replaceState({}, '', '/live');
  server.use(http.get('http://localhost/v3/console/activity', () => HttpResponse.json(mockActivity())));
});

async function abrirContextoDe(alias: string) {
  const user = userEvent.setup();
  renderWithApi(<LiveFleetPage />);
  await screen.findByLabelText('Veredicto de la flota');
  await user.click(await screen.findByRole('row', { name: new RegExp(alias, 'i') }));
  const cajon = await screen.findByRole('dialog', { name: new RegExp(`detalle de ${alias}`, 'i') });
  await user.click(within(cajon).getByRole('tab', { name: 'Contexto' }));
  return { user, cajon };
}

async function escribirBorrador(user: ReturnType<typeof userEvent.setup>, cajon: HTMLElement) {
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));
  const caja = await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i);
  await user.clear(caja);
  await user.type(caja, 'lo que estaba escribiendo');
  return caja;
}

it('el borrador sobrevive a cambiar de pestaña y volver', async () => {
  mapaDe('kant', [CLAUDE_MD]);
  server.use(http.get(rutaContenido('kant', 'directive'), () => HttpResponse.json(contenido('kant', '# viejo\n'))));
  const { user, cajon } = await abrirContextoDe('kant');
  await escribirBorrador(user, cajon);

  await user.click(within(cajon).getByRole('tab', { name: 'Entregas' }));
  await user.click(within(cajon).getByRole('tab', { name: 'Contexto' }));
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));

  expect(await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i))
    .toHaveValue('lo que estaba escribiendo');
});

it('plegar el acordeón no borra lo escrito, y la fila cerrada lo avisa', async () => {
  mapaDe('kant', [CLAUDE_MD]);
  server.use(http.get(rutaContenido('kant', 'directive'), () => HttpResponse.json(contenido('kant', '# viejo\n'))));
  const { user, cajon } = await abrirContextoDe('kant');
  await escribirBorrador(user, cajon);

  await user.click(within(cajon).getByText('CLAUDE.md (manual del sitio)'));
  expect(within(cajon).queryByLabelText(/Contenido de CLAUDE\.md/i)).not.toBeInTheDocument();
  expect(within(cajon).getByText('borrador sin guardar')).toBeInTheDocument();

  await user.click(within(cajon).getByText('CLAUDE.md (manual del sitio)'));
  expect(await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i))
    .toHaveValue('lo que estaba escribiendo');
});

it('inspeccionar otro fichero no se lleva por delante el borrador del manual en Contexto', async () => {
  mapaDe('kant', [CLAUDE_MD, IDENTIDAD]);
  server.use(
    http.get(rutaContenido('kant', 'directive'), () => HttpResponse.json(contenido('kant', '# viejo\n'))),
    http.get(rutaContenido('kant', 'identity'), () => HttpResponse.json({
      tenant_id: 'Steven', alias: 'kant', kind: 'identity',
      path: '/home/stev/workspace/IDENTITY.md', format: 'markdown', exists: true,
      content: '# identidad\n', sha: 'b'.repeat(64), bytes: 12,
      editable: false, projected: false, truncated: false,
    })),
  );
  const { user, cajon } = await abrirContextoDe('kant');
  await escribirBorrador(user, cajon);

  await user.click(within(cajon).getByRole('tab', { name: 'Ficheros' }));
  await user.click(within(cajon).getByText('Identidad (IDENTITY.md)'));
  expect(await within(cajon).findByLabelText(/Contenido de Identidad/i)).toHaveValue('# identidad\n');

  await user.click(within(cajon).getByRole('tab', { name: 'Contexto' }));
  await user.click(within(cajon).getByText('CLAUDE.md (manual del sitio)'));
  expect(await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i))
    .toHaveValue('lo que estaba escribiendo');
});

it('cada alias tiene su propio borrador: cambiar de agente no lo mezcla ni lo pierde', async () => {
  mapaDe('kant', [CLAUDE_MD]);
  mapaDe('zeus', [CLAUDE_MD]);
  server.use(
    http.get(rutaContenido('kant', 'directive'), () => HttpResponse.json(contenido('kant', '# viejo\n'))),
    http.get(rutaContenido('zeus', 'directive'), () => HttpResponse.json(contenido('zeus', '# el de zeus\n'))),
  );
  const { user, cajon } = await abrirContextoDe('kant');
  await escribirBorrador(user, cajon);

  await user.click(screen.getByRole('row', { name: /zeus/i }));
  const cajonZeus = await screen.findByRole('dialog', { name: /detalle de zeus/i });
  await user.click(within(cajonZeus).getByRole('tab', { name: 'Contexto' }));
  await user.click(await within(cajonZeus).findByText('CLAUDE.md (manual del sitio)'));
  expect(await within(cajonZeus).findByLabelText(/Contenido de CLAUDE\.md/i)).toHaveValue('# el de zeus\n');

  await user.click(screen.getByRole('row', { name: /kant/i }));
  const cajonKant = await screen.findByRole('dialog', { name: /detalle de kant/i });
  await user.click(within(cajonKant).getByRole('tab', { name: 'Contexto' }));
  await user.click(await within(cajonKant).findByText('CLAUDE.md (manual del sitio)'));
  expect(await within(cajonKant).findByLabelText(/Contenido de CLAUDE\.md/i))
    .toHaveValue('lo que estaba escribiendo');
});

it('«Descartar y releer» sí tira el borrador, que es lo que el operador pidió', async () => {
  mapaDe('kant', [CLAUDE_MD]);
  server.use(http.get(rutaContenido('kant', 'directive'), () => HttpResponse.json(contenido('kant', '# viejo\n'))));
  const { user, cajon } = await abrirContextoDe('kant');
  await escribirBorrador(user, cajon);

  await user.click(within(cajon).getByRole('button', { name: /Descartar y releer/i }));

  await waitFor(async () => {
    expect(await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i)).toHaveValue('# viejo\n');
  });
  expect(within(cajon).queryByText('borrador sin guardar')).not.toBeInTheDocument();
});

it('guardar cierra el borrador: al volver se ve lo aplicado y ningún aviso pendiente', async () => {
  mapaDe('kant', [CLAUDE_MD]);
  let guardado: string | undefined;
  server.use(
    http.get(rutaContenido('kant', 'directive'), () => HttpResponse.json(
      contenido('kant', guardado ?? '# viejo\n'),
    )),
    http.put(rutaContenido('kant', 'directive'), async ({ request }) => {
      const cuerpo = await request.json() as { content: string };
      guardado = cuerpo.content;
      return HttpResponse.json({
        ok: true, state: 'written_pending_session', evidence: 'probe_write_ack',
        path: '/home/stev/.claude/CLAUDE.md', sha: 'c'.repeat(64),
        bytes: new TextEncoder().encode(cuerpo.content).byteLength,
      }, { status: 202 });
    }),
  );
  const { user, cajon } = await abrirContextoDe('kant');
  await escribirBorrador(user, cajon);
  await user.type(within(cajon).getByLabelText(/Motivo del guardado/i), 'reescribo el manual');
  await user.click(within(cajon).getByRole('button', { name: /^Guardar$/i }));

  expect(await within(cajon).findByText(/Escrito en/)).toBeInTheDocument();
  expect(within(cajon).queryByText(/Aplicado en/)).not.toBeInTheDocument();
  await user.click(within(cajon).getByRole('tab', { name: 'Entregas' }));
  await user.click(within(cajon).getByRole('tab', { name: 'Contexto' }));

  expect(await within(cajon).findByText('CLAUDE.md (manual del sitio)')).toBeInTheDocument();
  expect(within(cajon).queryByText('borrador sin guardar')).not.toBeInTheDocument();
  await user.click(within(cajon).getByText('CLAUDE.md (manual del sitio)'));
  expect(await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i))
    .toHaveValue('lo que estaba escribiendo');
});

it('volver a abrir el fichero no pisa el borrador con la relectura del disco', async () => {
  mapaDe('kant', [CLAUDE_MD]);
  let lecturas = 0;
  server.use(http.get(rutaContenido('kant', 'directive'), () => {
    lecturas += 1;
    return HttpResponse.json(contenido('kant', '# viejo\n'));
  }));
  const { user, cajon } = await abrirContextoDe('kant');
  await escribirBorrador(user, cajon);

  await user.click(within(cajon).getByText('CLAUDE.md (manual del sitio)'));
  await user.click(within(cajon).getByText('CLAUDE.md (manual del sitio)'));

  const caja = await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i);
  await waitFor(() => { expect(lecturas).toBe(2); });
  expect(caja).toHaveValue('lo que estaba escribiendo');
});

it('el borrador guarda con la huella del texto del que nació, no con la de la última lectura', async () => {
  mapaDe('kant', [CLAUDE_MD]);
  let shaServido = SHA;
  let enviado: { expected_sha?: string } | undefined;
  server.use(
    http.get(rutaContenido('kant', 'directive'), () => HttpResponse.json({
      ...contenido('kant', '# viejo\n'), sha: shaServido,
    })),
    http.put(rutaContenido('kant', 'directive'), async ({ request }) => {
      enviado = await request.json() as { expected_sha?: string };
      return HttpResponse.json(
        { error: 'conflict', message: 'el fichero cambió desde que se abrió; hay que releerlo' },
        { status: 409 },
      );
    }),
  );
  const { user, cajon } = await abrirContextoDe('kant');
  await escribirBorrador(user, cajon);

  // Someone else writes the file while the operator was on another tab.
  await user.click(within(cajon).getByRole('tab', { name: 'Entregas' }));
  shaServido = 'd'.repeat(64);
  await user.click(within(cajon).getByRole('tab', { name: 'Contexto' }));
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));
  await user.type(within(cajon).getByLabelText(/Motivo del guardado/i), 'reescribo el manual');
  await user.click(await within(cajon).findByRole('button', { name: /^Guardar$/i }));

  await waitFor(() => { expect(enviado).toBeDefined(); });
  expect(enviado?.expected_sha).toBe(SHA);
  expect(await within(cajon).findByText(/cambió mientras lo editabas/i)).toBeInTheDocument();
});
