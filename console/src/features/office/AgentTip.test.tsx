import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { AgentTip } from './AgentTip';
import type { OfficeAgent } from './office-agent';

it('muestra los nombres de los grupos secundarios, no sus claves', () => {
  const agent = {
    id: 'Miguel/kratos', name: 'kratos', state: 'idle', reason: 'En espera', delegatesTo: [],
    team: { id: '["Miguel","grp.miguel"]', label: 'Miguel' }, groups: ['["Miguel","grp.extra"]'], groupLabels: ['Extra', 'Infra'],
  } as OfficeAgent;
  render(<AgentTip agent={agent} />);

  expect(screen.getByText(/también en Extra, Infra/u)).toBeVisible();
  expect(screen.queryByText(/\[/u)).toBeNull();
});
