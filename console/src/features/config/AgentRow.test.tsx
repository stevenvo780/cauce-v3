import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ConfigurationSnapshot } from '../../api/types';
import { AgentRow } from './AgentRow';
import type { SettingsAgent } from './settings-model';

const agent: SettingsAgent = {
  key: '["A","w"]', tenantId: 'A', alias: 'w', name: 'Worker', registered: true,
  enabled: true, harness: 'codex', responsibility: undefined, groups: [],
};
const snapshot = {
  tenants: [{ id: 'A', display_name: 'Empresa A' }],
  agents: [{ tenant_id: 'A', alias: 'w', display_name: 'Worker', harness_id: 'codex', enabled: true }],
  memberships: [],
} as unknown as ConfigurationSnapshot;

it('opens from the tile and the kebab only: no duplicated strip on the card', () => {
  render(<ul><AgentRow agent={agent} snapshot={snapshot} hosts={[]} onOpen={vi.fn()} /></ul>);
  expect(screen.getByRole('button', { name: 'Abrir agente A/w' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Acciones de A/w' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Editar agente A/w' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Preparar agente A/w' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Eliminar agente A/w' })).not.toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Acciones visibles de A/w' })).not.toBeInTheDocument();
});
