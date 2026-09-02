/**
 * The single tab widget of the console: what its keyboard and its wiring must do.
 *
 * Five tab strips were written by hand and only one of them —the drawer's— had arrow keys. What
 * is asserted here is the behaviour every host inherits by using this one, not its wording.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { expect, it, vi } from 'vitest';
import { ViewTabs } from './ui';
import { useRovingTabs } from './use-roving-tabs';

type Id = 'uno' | 'dos' | 'tres';

const TABS: readonly { id: Id; label: string }[] = [
  { id: 'uno', label: 'Uno' },
  { id: 'dos', label: 'Dos' },
  { id: 'tres', label: 'Tres' },
];

function Barra({ onSelect, panelId }: {
  onSelect?: (id: Id) => void;
  panelId?: string;
}) {
  const [activa, setActiva] = useState<Id>('uno');
  return (
    <ViewTabs
      tabs={TABS}
      active={activa}
      onSelect={(id) => { setActiva(id); onSelect?.(id); }}
      label="Pestañas de prueba"
      panelId={panelId}
    />
  );
}

const pestana = (nombre: string) => screen.getByRole('tab', { name: nombre });

it('la flecha derecha avanza, selecciona y da la vuelta al llegar al final', async () => {
  const user = userEvent.setup();
  const elegido = vi.fn();
  render(<Barra onSelect={elegido} />);

  pestana('Uno').focus();
  await user.keyboard('{ArrowRight}');
  expect(pestana('Dos')).toHaveFocus();
  expect(pestana('Dos')).toHaveAttribute('aria-selected', 'true');

  await user.keyboard('{ArrowRight}{ArrowRight}');
  expect(pestana('Uno')).toHaveFocus();
  expect(elegido.mock.calls.map(([id]) => id)).toEqual(['dos', 'tres', 'uno']);
});

it('la flecha izquierda retrocede y da la vuelta al principio', async () => {
  const user = userEvent.setup();
  render(<Barra />);

  pestana('Uno').focus();
  await user.keyboard('{ArrowLeft}');
  expect(pestana('Tres')).toHaveFocus();
  expect(pestana('Tres')).toHaveAttribute('aria-selected', 'true');
});

it('Inicio y Fin saltan a los extremos', async () => {
  const user = userEvent.setup();
  render(<Barra />);

  pestana('Uno').focus();
  await user.keyboard('{End}');
  expect(pestana('Tres')).toHaveAttribute('aria-selected', 'true');
  expect(pestana('Tres')).toHaveFocus();

  await user.keyboard('{Home}');
  expect(pestana('Uno')).toHaveAttribute('aria-selected', 'true');
  expect(pestana('Uno')).toHaveFocus();
});

it('sólo la pestaña activa está en el orden de tabulación', async () => {
  const user = userEvent.setup();
  render(<Barra />);

  expect(pestana('Uno')).toHaveAttribute('tabindex', '0');
  expect(pestana('Dos')).toHaveAttribute('tabindex', '-1');
  expect(pestana('Tres')).toHaveAttribute('tabindex', '-1');

  await user.tab();
  expect(pestana('Uno')).toHaveFocus();
  await user.tab();
  expect(pestana('Dos')).not.toHaveFocus();
});

it('el clic elige la pestaña con su propio id', async () => {
  const user = userEvent.setup();
  const elegido = vi.fn();
  render(<Barra onSelect={elegido} />);

  await user.click(pestana('Tres'));
  expect(elegido).toHaveBeenCalledWith('tres');
  expect(pestana('Tres')).toHaveAttribute('aria-selected', 'true');
});

it('cada pestaña gobierna su propio panel, salvo que el anfitrión declare uno solo', () => {
  const { unmount } = render(<Barra />);
  expect(pestana('Uno')).toHaveAttribute('aria-controls', 'view-panel-uno');
  expect(pestana('Dos')).toHaveAttribute('aria-controls', 'view-panel-dos');
  unmount();

  render(<Barra panelId="cajon-panel" />);
  for (const tab of screen.getAllByRole('tab')) {
    expect(tab).toHaveAttribute('aria-controls', 'cajon-panel');
  }
});

it('un anfitrión con su propia tira hereda el mismo teclado desde el hook', async () => {
  const user = userEvent.setup();
  const movido = vi.fn();
  function Tira() {
    const [activa, setActiva] = useState(0);
    const roving = useRovingTabs(3, (index) => { setActiva(index); movido(index); });
    return (
      <nav role="tablist" aria-label="Sesiones abiertas">
        {[0, 1, 2].map((index) => (
          <button
            key={index}
            type="button"
            role="tab"
            aria-selected={activa === index}
            tabIndex={activa === index ? 0 : -1}
            ref={roving.tabRef(index)}
            onKeyDown={(event) => { roving.onKeyDown(event, index); }}
          >
            {`sesión ${String(index)}`}
          </button>
        ))}
      </nav>
    );
  }
  render(<Tira />);

  pestana('sesión 0').focus();
  await user.keyboard('{ArrowLeft}');
  expect(pestana('sesión 2')).toHaveFocus();
  expect(pestana('sesión 2')).toHaveAttribute('aria-selected', 'true');
  expect(pestana('sesión 0')).toHaveAttribute('tabindex', '-1');
  await user.keyboard('{Home}');
  expect(pestana('sesión 0')).toHaveFocus();
  expect(movido.mock.calls.map(([index]) => index)).toEqual([2, 0]);
});
