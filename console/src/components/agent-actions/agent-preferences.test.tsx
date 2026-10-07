import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { useEffect, type ReactNode } from 'react';
import { beforeEach, expect, it } from 'vitest';
import { ConsoleAccessProvider } from '../../api/console-access';
import { server } from '../../mocks/server';
import { AgentList } from '../../shell/AgentList';
import { FleetProvider } from '../../shell/fleet';
import { declaredPtyTargets } from '../../test/pty-targets';
import { renderWithApi } from '../../test/render';
import { AgentPreferencesProvider } from './AgentPreferencesProvider';
import { useAgentPreferences } from './preferences-context';

const ALL_PERMISSIONS = ['message.publish', 'config.write'];
const look = (revision: number, glyph: string) => ({
  tenant_id: 'Steven', alias: 'argos', glyph, hue: 200, style: 'aurora', revision, updated_at: '2026-10-06T00:00:00Z', updated_by: 'Miguel:iza',
});

function renderShell(children: ReactNode = <AgentList routeId="messages" />) {
  return renderWithApi(
    <ConsoleAccessProvider><FleetProvider><AgentPreferencesProvider>{children}</AgentPreferencesProvider></FleetProvider></ConsoleAccessProvider>,
  );
}

function grant(permissions: string[]) {
  server.use(http.get('*/v3/console/access', () => HttpResponse.json({ subject: 'Steven:kant', roles: ['operator'], permissions })));
}

async function rowLink(list: string, alias: string) {
  return within(await screen.findByRole('list', { name: list })).findByRole('link', { name: new RegExp(`^${alias}\\b`) });
}

beforeEach(() => {
  window.history.pushState({}, '', '/messages');
  grant(ALL_PERMISSIONS);
  server.use(
    http.get('*/v3/console/agent-preferences', () => HttpResponse.json({ favorites: [], appearances: [] })),
    declaredPtyTargets(['Steven', 'argos'], ['Miguel', 'kratos']),
  );
});

it('pins a favorite at once and rolls it back, with a notice, when the server refuses', async () => {
  const user = userEvent.setup();
  server.use(http.put('*/v3/console/favorites/:tenant/:alias', async () => {
    await delay(120);
    return HttpResponse.json({ error: 'favorite_limit_reached', message: 'tope de 200 favoritos' }, { status: 409 });
  }));
  renderShell();
  await rowLink('Agentes', 'argos');

  await user.click(await screen.findByRole('button', { name: 'Agregar a argos a favoritos' }));
  expect(await rowLink('Agentes favoritos', 'argos')).toBeInTheDocument();
  expect(within(screen.getByRole('list', { name: 'Agentes' })).queryByRole('link', { name: /^argos\b/ })).toBeNull();

  expect(await screen.findByText(/No se pudo agregar a argos a favoritos: tope de 200 favoritos/)).toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'Agentes favoritos' })).toBeNull();
  expect(await rowLink('Agentes', 'argos')).toBeInTheDocument();
});

it('keeps a confirmed favorite pinned and removes it from the same menu', async () => {
  const user = userEvent.setup();
  const writes: string[] = [];
  server.use(
    http.put('*/v3/console/favorites/:tenant/:alias', ({ params }) => { writes.push(`PUT ${String(params.alias)}`); return new HttpResponse(null, { status: 204 }); }),
    http.delete('*/v3/console/favorites/:tenant/:alias', ({ params }) => { writes.push(`DELETE ${String(params.alias)}`); return new HttpResponse(null, { status: 204 }); }),
  );
  renderShell();
  await rowLink('Agentes', 'kratos');

  await user.click(screen.getByRole('button', { name: 'Acciones de kratos' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Agregar a favoritos' }));
  expect(await rowLink('Agentes favoritos', 'kratos')).toBeInTheDocument();
  await waitFor(() => { expect(writes).toEqual(['PUT kratos']); });

  await user.click(screen.getByRole('button', { name: 'Acciones de kratos' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Quitar de favoritos' }));
  await waitFor(() => { expect(screen.queryByRole('list', { name: 'Agentes favoritos' })).toBeNull(); });
  await waitFor(() => { expect(writes).toEqual(['PUT kratos', 'DELETE kratos']); });
});

it.each([
  ['Shift+F10', { key: 'F10', shiftKey: true }],
  ['la tecla de menú', { key: 'ContextMenu' }],
])('%s opens the agent menu on the focused row', async (_name, key) => {
  renderShell();
  const link = await rowLink('Agentes', 'argos');
  link.focus();
  fireEvent.keyDown(link, key);

  const menu = await screen.findByRole('menu');
  expect(within(menu).getByRole('menuitem', { name: 'Abrir chat' })).toHaveAttribute('href', '/messages/Steven/argos');
  expect(within(menu).getByRole('menuitem', { name: 'Abrir TUI' })).toHaveAttribute('href', '/terminal/Steven/argos?modo=tui');
  expect(within(menu).getByRole('menuitem', { name: 'Ver en la oficina' })).toBeInTheDocument();
  expect(within(menu).getByRole('menuitem', { name: 'Copiar alias' })).toBeInTheDocument();
});

it('a right click opens the same list as the kebab', async () => {
  renderShell();
  fireEvent.contextMenu(await rowLink('Agentes', 'kratos'), { clientX: 40, clientY: 40 });
  const menu = await screen.findByRole('menu');
  expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
    'Abrir chat', 'Abrir TUI', 'Abrir terminal', 'Ver en la oficina', 'Perfil y contexto',
    'Personalizar icono…', 'Agregar a favoritos', 'Copiar alias',
  ]);
});

it('without config.write the icon cannot be customised, and the menu says why', async () => {
  const user = userEvent.setup();
  grant(['message.publish']);
  renderShell();
  await rowLink('Agentes', 'argos');

  await user.click(screen.getByRole('button', { name: 'Acciones de argos' }));
  const item = await screen.findByRole('menuitem', { name: /Personalizar icono/ });
  await waitFor(() => { expect(item).toHaveAttribute('aria-disabled', 'true'); });
  expect(item).toHaveTextContent('Tu cuenta no tiene config.write');
});

it('a revision conflict reloads the server copy, keeps the draft and saves on top of the new revision', async () => {
  const user = userEvent.setup();
  let reads = 0;
  const expected: unknown[] = [];
  server.use(
    http.get('*/v3/console/agent-preferences', () => {
      reads += 1;
      return HttpResponse.json({ favorites: [], appearances: [reads === 1 ? look(1, '🐙') : look(2, '🐢')] });
    }),
    http.put('*/v3/console/agents/:tenant/:alias/appearance', async ({ request }) => {
      const body = await request.json() as { expected_revision: number; glyph: string; hue: number; style: string };
      expected.push(body.expected_revision);
      if (body.expected_revision === 1) {
        return HttpResponse.json({ error: 'revision_conflict', message: 'stale', current_revision: 2 }, { status: 409 });
      }
      return HttpResponse.json({ ...look(3, body.glyph), hue: body.hue, style: body.style });
    }),
  );
  renderShell();
  await rowLink('Agentes', 'argos');

  await user.click(screen.getByRole('button', { name: 'Acciones de argos' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Personalizar icono…' }));
  const dialog = await screen.findByRole('dialog', { name: 'Personalizar icono de argos' });
  await user.click(within(dialog).getByRole('button', { name: 'Icono 🦊' }));
  await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

  expect(await within(dialog).findByText(/Otra persona cambió este icono/)).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Icono 🦊' })).toHaveAttribute('aria-pressed', 'true');
  expect(within(dialog).getByText('En el servidor')).toBeInTheDocument();

  await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
  expect(expected).toEqual([1, 2]);
  expect(await screen.findByText('Listo: argos estrena look.')).toBeInTheDocument();
});

it('the dialog lets anyone try looks but only saves with config.write', async () => {
  const user = userEvent.setup();
  grant(['message.publish']);
  renderShell(<><AgentList routeId="messages" /><OpenDialog /></>);
  const dialog = await screen.findByRole('dialog', { name: 'Personalizar icono de argos' });
  await user.click(within(dialog).getByRole('button', { name: 'Pulso' }));
  expect(within(dialog).getByRole('img', { name: 'Vista previa del icono de argos' })).toHaveAttribute('data-style', 'pulse');
  expect(within(dialog).getByRole('note')).toHaveTextContent('no tiene config.write');
  expect(within(dialog).getByRole('button', { name: 'Guardar' })).toBeDisabled();
});

it('says why the TUI cannot open when the PTY inventory has no destination for the agent', async () => {
  const user = userEvent.setup();
  server.use(declaredPtyTargets(['Miguel', 'kratos']));
  renderShell();
  await rowLink('Agentes', 'argos');

  await user.click(screen.getByRole('button', { name: 'Acciones de argos' }));
  await waitFor(() => { expect(screen.getByRole('menuitem', { name: /Abrir TUI/ })).toHaveAttribute('aria-disabled', 'true'); });
  const tui = screen.getByRole('menuitem', { name: /Abrir TUI/ });
  expect(tui).not.toHaveAttribute('href');
  expect(tui).toHaveTextContent('no declaró una terminal');
});

it('a long press opens the menu and swallows the release, so the row link is not followed', async () => {
  renderShell();
  const link = await rowLink('Agentes', 'argos');
  const trigger = link.parentElement;
  if (!trigger) throw new Error('row without trigger');
  fireEvent.touchStart(link, { touches: [{ clientX: 20, clientY: 20 }] });
  expect(await screen.findByRole('menu', {}, { timeout: 2_000 })).toBeInTheDocument();
  const release = new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [] });
  link.dispatchEvent(release);
  expect(release.defaultPrevented).toBe(true);

  const later = new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [] });
  fireEvent.touchStart(link, { touches: [{ clientX: 20, clientY: 20 }] });
  link.dispatchEvent(later);
  expect(later.defaultPrevented).toBe(false);
});

it('favoriting from the keyboard keeps focus on the star after the row changes section', async () => {
  const user = userEvent.setup();
  server.use(http.put('*/v3/console/favorites/:tenant/:alias', () => new HttpResponse(null, { status: 204 })));
  window.history.pushState({}, '', '/messages/Steven/argos');
  renderShell(<AgentList routeId="messages" activeId="Steven:argos" />);
  await rowLink('Agentes', 'argos');

  screen.getByRole('button', { name: 'Agregar a argos a favoritos' }).focus();
  await user.keyboard('{Enter}');
  const star = await screen.findByRole('button', { name: 'Quitar a argos de favoritos' });
  await waitFor(() => { expect(star).toHaveFocus(); });
});

it('only the active row puts its star and kebab in the tab order', async () => {
  renderShell(<AgentList routeId="messages" activeId="Steven:argos" />);
  await rowLink('Agentes', 'kratos');
  expect(screen.getByRole('button', { name: 'Acciones de kratos' })).toHaveAttribute('tabindex', '-1');
  expect(screen.getByRole('button', { name: 'Acciones de argos' })).not.toHaveAttribute('tabindex', '-1');
});

it('a new favorite unfolds the collapsed section instead of hiding the row', async () => {
  const user = userEvent.setup();
  server.use(
    http.get('*/v3/console/agent-preferences', () => HttpResponse.json({ favorites: [{ tenant_id: 'Steven', alias: 'argos', created_at: '2026-10-06T00:00:00Z' }], appearances: [] })),
    http.put('*/v3/console/favorites/:tenant/:alias', () => new HttpResponse(null, { status: 204 })),
  );
  renderShell();
  await rowLink('Agentes favoritos', 'argos');
  await user.click(screen.getByRole('button', { name: /Favoritos/ }));
  expect(within(screen.getByRole('list', { name: 'Agentes favoritos' })).queryByRole('link')).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Agregar a kratos a favoritos' }));
  expect(await rowLink('Agentes favoritos', 'kratos')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Favoritos/ })).toHaveAttribute('aria-expanded', 'true');
});

it('closing with a dirty draft asks first, and resetting a saved look needs a confirmation', async () => {
  const user = userEvent.setup();
  const deletes: string[] = [];
  server.use(
    http.get('*/v3/console/agent-preferences', () => HttpResponse.json({ favorites: [], appearances: [look(4, '🐙')] })),
    http.delete('*/v3/console/agents/:tenant/:alias/appearance', ({ request }) => {
      deletes.push(new URL(request.url).search);
      return HttpResponse.json({ error: 'boom', message: 'Internal Server Error' }, { status: 500 });
    }),
  );
  renderShell(<><AgentList routeId="messages" /><OpenDialog /></>);
  const dialog = await screen.findByRole('dialog', { name: 'Personalizar icono de argos' });
  await user.click(within(dialog).getByRole('button', { name: 'Icono 🦊' }));
  await user.keyboard('{Escape}');
  expect(within(dialog).getByText('¿Descartar los cambios sin guardar?')).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Seguir editando' }));
  expect(within(dialog).getByRole('button', { name: 'Icono 🦊' })).toHaveAttribute('aria-pressed', 'true');

  await user.click(within(dialog).getByRole('button', { name: /Restablecer/ }));
  expect(deletes).toEqual([]);
  expect(within(dialog).getByText(/¿Borrar el look guardado de argos\?/)).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Restablecer' }));
  expect(await within(dialog).findByText(/No se restableció/)).toBeInTheDocument();
  expect(deletes).toEqual(['?expected_revision=4']);

  await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
  await user.click(within(dialog).getByRole('button', { name: 'Descartar' }));
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
});

function OpenDialog() {
  const preferences = useAgentPreferences();
  const ready = preferences?.status === 'ready';
  const customize = preferences?.customize;
  useEffect(() => { if (ready) customize?.({ tenantId: 'Steven', alias: 'argos' }); }, [ready, customize]);
  return null;
}
