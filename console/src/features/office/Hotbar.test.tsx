import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Hotbar, type HotbarSlot } from './Hotbar';

const slots: HotbarSlot[] = [
  { id: 'campus', kind: 'campus', name: 'Campus', hue: -1, people: 2, alerts: 0, works: false },
  { id: 'grupo:grp.a', kind: 'group', name: 'grp.a', hue: 40, people: 5, alerts: 2, works: false },
  { id: 'grupo:grp.b', kind: 'group', name: 'grp.b', hue: 200, people: 0, alerts: 0, works: true },
  { id: 'cafeteria', kind: 'cafe', name: 'Cafetería', hue: -1, people: 3, alerts: 0, works: false },
];

describe('Hotbar', () => {
  it('names every building with its people, its trouble and its key, and marks where you are', () => {
    render(<Hotbar slots={slots} current="grupo:grp.a" onGo={vi.fn()} />);
    const bar = screen.getByRole('toolbar', { name: 'Edificios del campus' });
    const buttons = within(bar).getAllByRole('button');
    expect(buttons).toHaveLength(4);
    expect(buttons[1]).toHaveAccessibleName('grp.a (estás acá): 5 agentes, 2 necesitan atención');
    expect(buttons[1]).toHaveAttribute('aria-current', 'location');
    expect(buttons[0]).not.toHaveAttribute('aria-current');
    expect(buttons[2]).toHaveAccessibleName(/en obra/);
    expect(buttons[3]).toHaveAccessibleName('Cafetería: 3 adentro');
    expect(buttons[0]).toHaveAttribute('title', 'Campus · tecla 1');
    expect(buttons.filter((button) => button.tabIndex === 0)).toEqual([buttons[1]]);
  });

  it('moves between slots with the arrows, Home and End, and goes where Enter or a click says', async () => {
    const onGo = vi.fn();
    const user = userEvent.setup();
    render(<Hotbar slots={slots} current="campus" onGo={onGo} />);
    const buttons = within(screen.getByRole('toolbar')).getAllByRole('button');
    buttons[0].focus();
    await user.keyboard('{ArrowRight}');
    expect(buttons[1]).toHaveFocus();
    await user.keyboard('{End}');
    expect(buttons[3]).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(buttons[0]).toHaveFocus();
    await user.keyboard('{ArrowLeft}{Enter}');
    expect(onGo).toHaveBeenLastCalledWith('cafeteria');
    await user.click(buttons[2]);
    expect(onGo).toHaveBeenLastCalledWith('grupo:grp.b');
  });

  it('keeps only the icon and the count on narrow screens, the full name stays for the screen reader', () => {
    render(<Hotbar slots={slots} current="campus" onGo={vi.fn()} compact />);
    const button = screen.getByRole('button', { name: /^grp\.a/ });
    expect(button).not.toHaveTextContent('grp.a');
    expect(button).toHaveTextContent('5');
  });
});
