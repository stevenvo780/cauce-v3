import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { ConfirmDialog, FormDialog, Kpi } from './ops-kit';

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

describe('ConfirmDialog', () => {
  it('cancels on Escape unless a request is in flight', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <ConfirmDialog open title="Cancelar" confirmLabel="Sí" onConfirm={() => undefined} onCancel={onCancel} />,
    );
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledOnce();

    rerender(<ConfirmDialog open busy title="Cancelar" confirmLabel="Sí" onConfirm={() => undefined} onCancel={onCancel} />);
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Sí' })).toBeDisabled();
  });

  it('keeps the confirm button inert until the caller says it can be pressed', () => {
    render(<ConfirmDialog open title="Cerrar" confirmLabel="Cerrar sin replay" confirmDisabled onConfirm={() => undefined} onCancel={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Cerrar sin replay' })).toBeDisabled();
  });
});

describe('FormDialog', () => {
  it('stays open while busy and closes otherwise', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<FormDialog open busy title="Alta" onClose={onClose}>campos</FormDialog>);
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();

    rerender(<FormDialog open title="Alta" onClose={onClose}>campos</FormDialog>);
    await user.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
