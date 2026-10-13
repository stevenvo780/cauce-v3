import { screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { renderWithApi } from '../../test/render';
import { AuditPanel } from './AuditPanel';

vi.mock('../../api/use-resource', () => ({
  useResource: () => ({
    data: {
      items: [{
        event_id: '1', at: '2026-08-26T08:00:00.000Z', tenant_id: 'Steven', actor_alias: 'kant',
        action: 'audit.event.1', decision: 'allow', request_id: null, trace_id: 'trace-1',
        summary: JSON.stringify({ state: 'done' }),
      }],
      next_cursor: null,
    },
    error: new Error('auditoría caída'),
    loading: false,
    reload: () => Promise.resolve({ error: new Error('auditoría caída') }),
  }),
}));

it('una relectura fallida avisa y conserva los eventos ya cargados', () => {
  renderWithApi(<AuditPanel query="" onQuery={() => undefined} />);
  expect(screen.getByRole('alert')).toHaveTextContent(/No se pudo actualizar la auditoría: auditoría caída/u);
  expect(screen.getByText('audit.event.1')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Reintentar/u })).toBeInTheDocument();
});
