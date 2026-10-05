import { screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, vi } from 'vitest';
import { ConfigPage } from './ConfigPage';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { recordChanges, servirConfig, type ChangeRequest } from './ConfigPage.test-helpers';

const contextDrafts = vi.hoisted(() => new Map<string, string>());

vi.mock('../live/AgentContextPanel', () => ({
  AgentContextPanel: ({ tenantId, alias, onDirtyChange }: { tenantId: string; alias: string; onDirtyChange: (dirty: boolean) => void }) => {
    const key = `${tenantId}/${alias}`;
    const [, render] = useState(0);
    return <div data-testid="canonical-context">{key}
      {contextDrafts.has(key) ? <p>Borrador guardado: {contextDrafts.get(key)}</p> : null}
      <button onClick={() => { contextDrafts.set(key, 'perfil pendiente'); render((revision) => revision + 1); onDirtyChange(true); }}>Editar borrador</button>
    </div>;
  },
}));

beforeEach(() => { contextDrafts.clear(); });

const snapshot = {
  revision: 4,
  agents: [
    { tenant_id: 'A', alias: 'same', display_name: 'Uno', harness_id: 'codex', enabled: true },
    { tenant_id: 'B', alias: 'same', display_name: 'Dos', enabled: false },
  ],
  memberships: [
    { tenant_id: 'A', alias: 'same', room_id: 'ops', enabled: true },
    { tenant_id: 'B', alias: 'same', room_id: 'team', enabled: false },
    { tenant_id: 'A', alias: 'member_only', room_id: 'ops', enabled: true },
  ],
  rooms: [{ tenant_id: 'A', id: 'ops', display_name: 'Operaciones' }],
  agent_profiles: [{ tenant_id: 'A', alias: 'same', role_summary: 'Revisar cambios' }],
};

it('abre en agentes y grupos sin exponer altas, JSON ni permisos como mandos cotidianos', async () => {
  servirConfig(() => snapshot);
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  renderWithApi(<ConfigPage />);
  expect(await screen.findByRole('heading', { name: 'Ajustes y altas', level: 1 })).toBeInTheDocument();
  const list = screen.getByRole('list', { name: 'Agentes configurados' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(3);
  expect(within(list).getAllByText('Operaciones')).toHaveLength(2);
  expect(within(list).getByText('Revisar cambios')).toBeInTheDocument();
  expect(within(list).getByText('Arnés declarado: codex')).toBeInTheDocument();
  expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Mutación JSON')).not.toBeInTheDocument();
  expect(screen.queryByTestId('canonical-context')).not.toBeInTheDocument();
  const memberOnly = screen.getByRole('button', { name: 'Abrir contexto de A/member_only' });
  expect(memberOnly).toBeDisabled();
  expect(screen.getByText(/Contexto no disponible.*solo aparece como miembro/i)).toBeVisible();
  expect(memberOnly).toHaveAttribute('aria-describedby', expect.stringContaining('context-unavailable'));
  expect(changes).toEqual([]);
});

it('abre la autoridad canónica con identidad completa y vuelve sin descartar el borrador', async () => {
  servirConfig(() => snapshot);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await user.click(await screen.findByRole('button', { name: 'Abrir contexto de A/same' }));
  expect(screen.getByTestId('canonical-context')).toHaveTextContent('A/same');
  expect(screen.getByRole('heading', { name: 'Uno · Contexto' })).toHaveFocus();
  expect(screen.queryByRole('list', { name: 'Agentes configurados' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Editar borrador' }));
  await user.click(screen.getByRole('button', { name: 'Volver y conservar borrador' }));
  expect(screen.getByRole('button', { name: 'Abrir contexto de A/same' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Abrir contexto de B/same' }));
  expect(screen.getByTestId('canonical-context')).toHaveTextContent('B/same');
});

it.each([false, true])('recupera foco y conserva el borrador si desaparece el agente y vuelve en otra lectura (membresías conservadas: %s)', async (retainMemberships) => {
  let current = snapshot;
  servirConfig(() => current);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await user.click(await screen.findByRole('button', { name: 'Abrir contexto de A/same' }));
  await user.click(screen.getByRole('button', { name: 'Editar borrador' }));
  expect(screen.getByText('Borrador guardado: perfil pendiente')).toBeInTheDocument();

  current = { ...snapshot, agents: [], memberships: retainMemberships ? snapshot.memberships : [] };
  await user.click(screen.getByRole('button', { name: 'Actualizar' }));
  const recovery = await screen.findByRole('button', { name: 'Volver al inventario y conservar borrador' });
  expect(await screen.findByRole('alert')).toHaveTextContent(/borrador sigue conservado/);
  await waitFor(() => { expect(recovery).toHaveFocus(); });
  await user.click(recovery);
  expect(screen.getByRole('searchbox')).toHaveFocus();
  expect(screen.queryByTestId('canonical-context')).not.toBeInTheDocument();

  current = snapshot;
  await user.click(screen.getByRole('button', { name: 'Actualizar' }));
  await user.click(await screen.findByRole('button', { name: 'Abrir contexto de A/same' }));
  expect(screen.getByText('Borrador guardado: perfil pendiente')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Uno · Contexto' })).toHaveFocus();
});

it('filtra por grupos sin alterar el inventario y abre administración sólo a pedido', async () => {
  servirConfig(() => snapshot);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await user.type(await screen.findByRole('searchbox'), 'team');
  expect(screen.getByRole('list', { name: 'Agentes configurados' })).toHaveTextContent('B / same');
  expect(screen.queryByRole('button', { name: 'Abrir contexto de A/same' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Administración avanzada' }));
  expect(await screen.findByRole('tablist', { name: 'Áreas de configuración' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Volver a agentes y contexto' }));
  expect(await screen.findByRole('heading', { name: 'Agentes y contexto' })).toBeInTheDocument();
});

it('distingue inventario incompleto, grupos desconocidos y arnés sin publicar', async () => {
  servirConfig(() => ({ agents: [{ tenant_id: 'A', alias: 'one' }] }));
  renderWithApi(<ConfigPage />);
  expect(await screen.findByText('Grupos desconocidos')).toBeInTheDocument();
  expect(screen.getByText('Arnés declarado: desconocido')).toBeInTheDocument();
  expect(screen.queryByText(/todos tienen acceso/i)).not.toBeInTheDocument();
});

it('un refresco fallido declara obsoleta la lectura y no inventa un inventario nuevo', async () => {
  servirConfig(() => snapshot);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await screen.findByRole('list', { name: 'Agentes configurados' });
  server.use(http.get('*/v3/console/config', () => HttpResponse.json({ error: 'internal' }, { status: 500 })));
  await user.click(screen.getByRole('button', { name: 'Actualizar' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/última lectura válida/);
  expect(screen.getByRole('button', { name: 'Abrir contexto de A/same' })).toBeInTheDocument();
});

it('mantiene los controles avanzados bloqueados cuando el permiso es desconocido', async () => {
  server.use(http.get('*/v3/console/access', () => HttpResponse.json({ error: 'internal' }, { status: 500 })));
  const changes: ChangeRequest[] = [];
  recordChanges(changes);
  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await user.click(await screen.findByRole('button', { name: 'Administración avanzada' }));
  await waitFor(() => { expect(screen.getByRole('button', { name: /^Crear$/ })).toBeDisabled(); });
  for (const control of screen.getAllByRole('switch')) expect(control).toBeDisabled();
  expect(changes).toEqual([]);
});
