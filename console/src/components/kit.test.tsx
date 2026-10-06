import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { Kpi, SectionCard } from './kit';

describe('Kpi', () => {
  it('is a plain figure without a handler and a toggle button with one', async () => {
    const onPress = vi.fn();
    const { rerender } = render(<Kpi label="Pendientes" value={4} tone="warning" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Pendientes').closest('article')).toHaveAttribute('data-tone', 'warning');

    rerender(<Kpi label="Pendientes" value={4} onPress={onPress} pressed />);
    const button = screen.getByRole('button', { name: /pendientes/i });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    await userEvent.setup().click(button);
    expect(onPress).toHaveBeenCalledOnce();
  });

  it('says "sin dato" for a figure the server did not send, never 0', () => {
    render(<Kpi label="DLQ" value={null} />);
    expect(screen.getByText('DLQ').parentElement).not.toHaveTextContent('0');
  });
});

describe('SectionCard', () => {
  it('titles the card with an h2 unless told a deeper level', () => {
    render(<><SectionCard title="Uno">a</SectionCard><SectionCard title="Dos" level={3}>b</SectionCard></>);
    expect(screen.getByRole('heading', { level: 2, name: 'Uno' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Dos' })).toBeInTheDocument();
  });
});
