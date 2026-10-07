import { act, render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { characterPalette, hslHex } from '../features/office/palette';
import { AgentOrb } from './AgentOrb';
import { AgentPreferencesContext, type AgentPreferencesValue } from './agent-actions/preferences-context';
import { bloomOrb } from './orb-bloom';

const noop = () => undefined;
function withLooks(appearances: AgentPreferencesValue['appearances']): AgentPreferencesValue {
  return {
    status: 'ready', favorites: new Set(), appearances, pending: new Set(), toggleFavorite: noop,
    saveAppearance: () => Promise.reject(new Error('no')), resetAppearance: () => Promise.resolve(), reload: () => Promise.resolve(),
    customize: noop, notify: noop,
  };
}
const kratos = { tenant_id: 'Miguel', alias: 'kratos', glyph: '🦉', hue: 200, style: 'pixel' as const, revision: 1, updated_at: '', updated_by: 'x' };

it('draws the agent with the look the fleet chose, wherever the orb is', () => {
  const { container } = render(
    <AgentPreferencesContext.Provider value={withLooks(new Map([['Miguel/kratos', kratos]]))}>
      <AgentOrb seed="Miguel/kratos" size={40} />
      <AgentOrb seed="Steven/argos" size={40} />
    </AgentPreferencesContext.Provider>,
  );
  const [custom, plain] = Array.from(container.querySelectorAll<HTMLElement>('.agent-orb'));
  expect(custom).toHaveAttribute('data-style', 'pixel');
  expect(custom).toHaveTextContent('🦉');
  expect(custom.style.getPropertyValue('--h1')).toBe('200');
  expect(plain).toHaveAttribute('data-style', 'orb');
  expect(plain.querySelector('.agent-orb-glyph')).toBeNull();
});

it('outside the shell the orb falls back to the seeded default', () => {
  const { container } = render(<AgentOrb seed="Miguel/kratos" />);
  expect(container.querySelector('.agent-orb')).toHaveAttribute('data-style', 'orb');
});

it('blooms every orb of the agent that just answered, and only those', () => {
  const { container } = render(<><AgentOrb seed="Steven/argos" /><AgentOrb seed="Steven/argos" /><AgentOrb seed="Miguel/kratos" /></>);
  act(() => { bloomOrb('Steven/argos', 'sparkle'); });
  const blooms = container.querySelectorAll('.agent-orb-bloom[data-kind="sparkle"]');
  expect(blooms).toHaveLength(2);
});

it('dresses the office character in the chosen hue', () => {
  const chosen = characterPalette('Miguel/kratos', false, 200);
  expect(chosen.t).toBe(hslHex(200, 62, 56));
  expect(characterPalette('Miguel/kratos', false).t).not.toBe(chosen.t);
  expect(characterPalette('Miguel/kratos', false, null)).toEqual(characterPalette('Miguel/kratos', false));
});

it('draws a px: glyph as an inline pixel icon, never as text', async () => {
  const look = { ...kratos, glyph: 'px:robot' };
  const { container } = render(
    <AgentPreferencesContext.Provider value={withLooks(new Map([['Miguel/kratos', look]]))}>
      <AgentOrb seed="Miguel/kratos" size={40} />
    </AgentPreferencesContext.Provider>,
  );
  const glyph = container.querySelector('.agent-orb-glyph');
  expect(glyph).not.toHaveTextContent('px:');
  expect(glyph?.querySelector('svg.pixel-icon')?.getAttribute('width')).toBe('24');
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 50); }); });
  expect(glyph?.querySelector('path')).not.toBeNull();
});
