import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TeamLegend } from './TeamLegend';

const teams = [
  { id: 'grp.isa', label: 'grp.isa', hue: 10, count: 1 },
  { id: 'grp.miguel', label: 'grp.miguel', hue: 120, count: 3 },
];

describe('TeamLegend', () => {
  it('lists every team with its headcount and flies to the one clicked', async () => {
    const onGo = vi.fn();
    render(<TeamLegend teams={teams} defaultOpen onGo={onGo} />);
    const target = screen.getByRole('button', { name: /grp\.miguel/ });
    expect(target).toHaveTextContent('3');
    await userEvent.click(target);
    expect(onGo).toHaveBeenCalledWith('grp.miguel');
  });

  it('starts collapsed when asked to and opens from the toggle', async () => {
    render(<TeamLegend teams={teams} defaultOpen={false} onGo={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /grp\.isa/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Grupos/ }));
    expect(screen.getByRole('button', { name: /grp\.isa/ })).toBeInTheDocument();
  });
});
