import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import type { AgentDocumentKind } from '../../api/types';
import { mockActivity } from '../../mocks/data';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { FicherosTab, type BorradorDeFichero } from './FicherosTab';
import { LiveFleetPage } from './LiveFleetPage';

/**
 * EVERY SAVE OF A GOVERNANCE FILE CARRIES A REASON A PERSON TYPED FOR IT. The gateway refuses a
 * body without one (400) and refuses a session with nobody behind it (403), so this suite watches
 * the field itself: never prefilled, never reused, and both refusals said in Spanish with what to
 * do next instead of the vocabulary the reads speak.
 */

const RUTA_MAPA = 'http://localhost/v3/console/tenants/Steven/agents/kant/documents';
const RUTA_CONTENIDO =
  'http://localhost/v3/console/tenants/Steven/agents/kant/documents/directive/content';
const SHA_VIEJO = 'a'.repeat(64);
const SHA_NUEVO = 'b'.repeat(64);

const CLAUDE_MD = {
  kind: 'directive', category: 'manual', label: 'CLAUDE.md (manual del sitio)',
  path: '/home/stev/.claude/CLAUDE.md', format: 'markdown', readable: true, editable: true,
};

function mapaDeKant(items: unknown[]) {
  server.use(http.get(RUTA_MAPA, () => HttpResponse.json({
    tenant_id: 'Steven', alias: 'kant', facts_source: 'measured',
    harness: 'claude', home: '/home/stev', items,
  })));
}

beforeEach(() => {
  window.history.replaceState({}, '', '/live');
  server.use(http.get('http://localhost/v3/console/activity', () => HttpResponse.json(mockActivity())));
});

async function abrirContexto() {
  const user = userEvent.setup();
  renderWithApi(<LiveFleetPage />);
  await screen.findByLabelText('Veredicto de la flota');
  await user.click(await screen.findByRole('row', { name: /kant/i }));
  const cajon = await screen.findByRole('dialog', { name: /detalle de kant/i });
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

function contenidoServido(texto: string) {
  return {
    tenant_id: 'Steven', alias: 'kant', kind: 'directive',
    path: '/home/stev/.claude/CLAUDE.md', format: 'markdown',
    exists: true, content: texto, sha: SHA_VIEJO,
    bytes: new TextEncoder().encode(texto).byteLength,
    editable: true, projected: false, truncated: false,
  };
}

function servidoEditable(extra: Record<string, unknown> = {}) {
  return {
    tenant_id: 'Steven', alias: 'kant', kind: 'directive',
    path: '/home/stev/.claude/CLAUDE.md', format: 'markdown',
    exists: true, content: '# manual viejo\n', sha: SHA_VIEJO, bytes: 15,
    editable: true, projected: false, truncated: false, ...extra,
  };
}

it('sin un motivo escrito a mano no hay Guardar, y el campo nunca viene relleno', async () => {
  mapaDeKant([CLAUDE_MD]);
  let puts = 0;
  server.use(
    http.get(RUTA_CONTENIDO, () => HttpResponse.json(servidoEditable())),
    http.put(RUTA_CONTENIDO, () => {
      puts += 1;
      return HttpResponse.json({ error: 'unexpected_put' }, { status: 500 });
    }),
  );

  const { user, cajon } = await abrirContexto();
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));
  const caja = await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i);
  await user.clear(caja);
  await user.type(caja, '# nuevo');

  const motivo = within(cajon).getByLabelText(/Motivo del guardado/i);
  expect(motivo).toHaveValue('');
  expect(within(cajon).getByRole('button', { name: /^Guardar$/i })).toBeDisabled();

  await user.type(motivo, 'corto');
  expect(within(cajon).getByText(/necesita al menos 8 caracteres/i)).toBeInTheDocument();
  expect(within(cajon).getByRole('button', { name: /^Guardar$/i })).toBeDisabled();

  await user.type(motivo, ' pero ya no lo es');
  expect(within(cajon).getByRole('button', { name: /^Guardar$/i })).toBeEnabled();
  expect(puts).toBe(0);
});

it('el motivo viaja en el cuerpo y el campo se vacía tras el guardado', async () => {
  mapaDeKant([CLAUDE_MD]);
  let recibido: { reason?: string; content?: string } | undefined;
  server.use(
    http.get(RUTA_CONTENIDO, () => HttpResponse.json(servidoEditable())),
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
  await user.clear(caja);
  await user.type(caja, '# nuevo');
  await user.type(within(cajon).getByLabelText(/Motivo del guardado/i), '  corrijo la ruta del repo  ');
  await user.click(within(cajon).getByRole('button', { name: /^Guardar$/i }));

  await waitFor(() => { expect(recibido).toBeDefined(); });
  expect(recibido?.reason).toBe('corrijo la ruta del repo');
  expect(await within(cajon).findByText(/Aplicado en/)).toBeInTheDocument();
  // The reason belongs to THAT save: reopening the file never brings the previous one back.
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));
  expect(await within(cajon).findByLabelText(/Motivo del guardado/i)).toHaveValue('');
});

it('mientras el guardado está en vuelo, el motivo no se puede tocar', async () => {
  mapaDeKant([CLAUDE_MD]);
  let soltar: (() => void) | undefined;
  server.use(
    http.get(RUTA_CONTENIDO, () => HttpResponse.json(servidoEditable())),
    http.put(RUTA_CONTENIDO, async () => {
      await new Promise<void>((resolve) => { soltar = resolve; });
      return HttpResponse.json({
        ok: true, state: 'applied', evidence: 'probe_write_ack',
        path: '/home/stev/.claude/CLAUDE.md', sha: SHA_NUEVO, bytes: 7,
      });
    }),
  );

  const { user, cajon } = await abrirContexto();
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));
  const caja = await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i);
  await user.clear(caja);
  await user.type(caja, '# nuevo');
  await user.type(within(cajon).getByLabelText(/Motivo del guardado/i), 'corrijo la ruta del repo');
  await user.click(within(cajon).getByRole('button', { name: /^Guardar$/i }));

  await waitFor(() => {
    expect(within(cajon).getByLabelText(/Motivo del guardado/i)).toBeDisabled();
  });
  soltar?.();
  expect(await within(cajon).findByText(/Aplicado en/)).toBeInTheDocument();
});

it('una sesión sin persona detrás lo dice en castellano y no pierde texto ni motivo', async () => {
  mapaDeKant([CLAUDE_MD]);
  server.use(
    http.get(RUTA_CONTENIDO, () => HttpResponse.json(servidoEditable())),
    http.put(RUTA_CONTENIDO, () => HttpResponse.json({
      error: 'forbidden',
      reason: 'writable_requires_attribution',
      message: 'escribir la gobernanza de un alias exige una persona con nombre',
    }, { status: 403 })),
  );

  const { user, cajon } = await abrirContexto();
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));
  const caja = await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i);
  await user.clear(caja);
  await user.type(caja, '# nuevo');
  await user.type(within(cajon).getByLabelText(/Motivo del guardado/i), 'corrijo la ruta del repo');
  await user.click(within(cajon).getByRole('button', { name: /^Guardar$/i }));

  expect(await within(cajon).findByText(/no acredita a la persona que escribe/i)).toBeInTheDocument();
  expect(within(cajon).getByText(/identidad de operador/i)).toBeInTheDocument();
  expect(within(cajon).queryByText(/no se sirve por esta vía/)).not.toBeInTheDocument();
  expect(caja).toHaveValue('# nuevo');
  expect(within(cajon).getByLabelText(/Motivo del guardado/i)).toHaveValue('corrijo la ruta del repo');
});

it('un 400 de la admisión dice el rango del motivo y qué hacer', async () => {
  mapaDeKant([CLAUDE_MD]);
  server.use(
    http.get(RUTA_CONTENIDO, () => HttpResponse.json(servidoEditable())),
    http.put(RUTA_CONTENIDO, () => HttpResponse.json({
      error: 'invalid_input',
      message: '`reason` tiene que ser un motivo escrito a mano de entre 8 y 280 caracteres',
    }, { status: 400 })),
  );

  const { user, cajon } = await abrirContexto();
  await user.click(await within(cajon).findByText('CLAUDE.md (manual del sitio)'));
  const caja = await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i);
  await user.clear(caja);
  await user.type(caja, '# nuevo');
  await user.type(within(cajon).getByLabelText(/Motivo del guardado/i), 'corrijo la ruta del repo');
  await user.click(within(cajon).getByRole('button', { name: /^Guardar$/i }));

  expect(await within(cajon).findByText(/La auditoría no admitió este guardado/i)).toBeInTheDocument();
  expect(within(cajon).getByText(/entre 8 y 280 caracteres/)).toBeInTheDocument();
  expect(within(cajon).queryByText(/No se pudo leer el fichero/)).not.toBeInTheDocument();
  expect(caja).toHaveValue('# nuevo');
});

/**
 * The live page remounts this tab after a save, which would hide a reason kept in state. Mounted by
 * a parent that only holds the draft, the reason still has to be gone: reusing it would file the
 * sentence typed for the previous change as the explanation of the next one.
 */
function PadreQueNoRemonta() {
  const [borradores, setBorradores] = useState<
    Partial<Record<AgentDocumentKind, BorradorDeFichero>>
  >({});
  return (
    <FicherosTab
      tenantId="Steven"
      alias="kant"
      mode="manual-editor"
      borradores={borradores}
      onBorrador={(kind, borrador) => {
        setBorradores((previo) => ({ ...previo, [kind]: borrador }));
      }}
      configWritePermission="allowed"
    />
  );
}

it('un padre que no remonta tampoco reutiliza el motivo del guardado anterior', async () => {
  mapaDeKant([CLAUDE_MD]);
  const cuerpos: { reason?: string }[] = [];
  server.use(
    http.get(RUTA_CONTENIDO, () => HttpResponse.json(servidoEditable())),
    http.put(RUTA_CONTENIDO, async ({ request }) => {
      cuerpos.push(await request.json() as { reason?: string });
      return HttpResponse.json({
        ok: true, state: 'applied', evidence: 'probe_write_ack',
        path: '/home/stev/.claude/CLAUDE.md', sha: SHA_NUEVO, bytes: 7,
      });
    }),
  );

  const user = userEvent.setup();
  renderWithApi(<PadreQueNoRemonta />);
  await user.click(await screen.findByText('CLAUDE.md (manual del sitio)'));
  const caja = await screen.findByLabelText(/Contenido de CLAUDE\.md/i);
  await user.clear(caja);
  await user.type(caja, '# nuevo');
  await user.type(screen.getByLabelText(/Motivo del guardado/i), 'corrijo la ruta del repo');
  await user.click(screen.getByRole('button', { name: /^Guardar$/i }));

  await waitFor(() => { expect(cuerpos).toHaveLength(1); });
  expect(cuerpos[0]?.reason).toBe('corrijo la ruta del repo');
  expect(await screen.findByText(/Aplicado en/)).toBeInTheDocument();
  expect(screen.getByLabelText(/Motivo del guardado/i)).toHaveValue('');
});

/**
 * The draft is the operator's text and survives; the reason is not part of it. A reason kept
 * across folds would end up sent for a save it was not typed for, and the audit row would read
 * a sentence about the previous change.
 */
it('el motivo no viaja con el borrador: vuelve vacío aunque el texto siga escrito', async () => {
  mapaDeKant([CLAUDE_MD]);
  server.use(http.get(RUTA_CONTENIDO, () => HttpResponse.json(contenidoServido('# viejo\n'))));
  const { user, cajon } = await abrirContexto();
  await escribirBorrador(user, cajon);
  await user.type(within(cajon).getByLabelText(/Motivo del guardado/i), 'lo que iba a escribir');

  await user.click(within(cajon).getByText('CLAUDE.md (manual del sitio)'));
  await user.click(within(cajon).getByText('CLAUDE.md (manual del sitio)'));

  expect(await within(cajon).findByLabelText(/Contenido de CLAUDE\.md/i))
    .toHaveValue('lo que estaba escribiendo');
  expect(within(cajon).getByLabelText(/Motivo del guardado/i)).toHaveValue('');
  expect(within(cajon).getByRole('button', { name: /^Guardar$/i })).toBeDisabled();
});
