import { describe, expect, it } from 'vitest';
import { paletteCommands } from './palette-commands';

const agents = [{ tenantId: 'Miguel', alias: 'kratos' }, { tenantId: 'Steven', alias: 'argos' }, { tenantId: 'Steven', alias: 'kant' }];

describe('command palette', () => {
  it('an empty query offers the favorite chats first, then the sections', () => {
    const list = paletteCommands(agents, new Set(['Steven/argos']), '');
    expect(list[0]).toMatchObject({ label: 'argos', href: '/messages/Steven/argos' });
    expect(list.some((command) => command.href === '/live')).toBe(true);
    expect(list.some((command) => command.label === 'kratos')).toBe(false);
  });

  it('a query lists every action of the matching agents, prefix matches first', () => {
    const list = paletteCommands(agents, undefined, 'ka');
    expect(list[0]).toMatchObject({ label: 'kant', href: '/messages/Steven/kant' });
    expect(list.map((command) => command.href)).toContain('/terminal/Steven/kant?modo=tui');
    expect(paletteCommands(agents, undefined, 'oficina')[0]).toMatchObject({ href: '/live' });
  });
});
