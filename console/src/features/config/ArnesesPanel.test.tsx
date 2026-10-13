import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ArnesesPanel } from './ArnesesPanel';

it.each(['Grok', 'Muse'])('muestra el manual de %s con su workspace medido y el destino de edición', (label) => {
  render(<ArnesesPanel />);

  const item = screen.getByRole('heading', { name: label }).closest('li');
  if (!item) throw new Error(`no aparece la fila de ${label}`);
  const row = within(item);
  expect(row.getByText(`<WORKSPACE_${label.toUpperCase()}>/AGENTS.md`)).toBeInTheDocument();
  expect(row.getByText(/medido en el runtime/)).toBeInTheDocument();
  expect(row.getByText(/«Perfil y contexto».*workspace medido/)).toBeInTheDocument();
  expect(row.queryByRole('button')).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'OpenCode' })).not.toBeInTheDocument();
});
