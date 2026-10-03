import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RefreshButton } from './ui';

describe('RefreshButton', () => {
  it('keeps the loading state as the accessible name in compact mode', () => {
    const { rerender } = render(<RefreshButton compact onClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Actualizar' })).toHaveAttribute('title', 'Actualizar');

    rerender(<RefreshButton compact loading onClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Actualizando…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Actualizando…' })).toHaveAttribute('title', 'Actualizando…');
  });
});
