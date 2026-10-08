import { describe, expect, it } from 'vitest';
import { accessoryRows, type Accessory } from './accessories';
import { accessoryOf, fleetLook } from './looks';
import { CHAR_H, CHAR_W } from './sprites';

describe('fleet look', () => {
  it('reads the style, the hue and a pixel icon glyph, and ignores a glyph that is only text', () => {
    expect(fleetLook({ glyph: 'px:robot', hue: 200, style: 'aurora' })).toEqual({ hue: 200, style: 'aurora', icon: 'robot' });
    expect(fleetLook({ glyph: '🦊', hue: null, style: 'pulse' })).toEqual({ hue: null, style: 'pulse', icon: null });
    expect(fleetLook({ glyph: 'px:Not A Name' }).icon).toBeNull();
  });

  it('falls back to the plain orb for a missing or unknown style, so the agent is never hidden', () => {
    expect(fleetLook({}).style).toBe('orb');
    expect(fleetLook({ style: 'hologram' }).style).toBe('orb');
  });

  it('gives aurora a scarf, pulse headphones, pixel a cap and the orb nothing', () => {
    expect(accessoryOf('aurora')).toBe('scarf');
    expect(accessoryOf('pulse')).toBe('headphones');
    expect(accessoryOf('pixel')).toBe('cap');
    expect(accessoryOf('orb')).toBeNull();
  });
});

describe('accessories', () => {
  const accessories: Accessory[] = ['scarf', 'headphones', 'cap'];
  const facings = ['down', 'up', 'left', 'right'] as const;

  it('every accessory is a full character-sized map using only its own keys', () => {
    for (const accessory of accessories) for (const facing of facings) {
      const rows = accessoryRows(accessory, facing);
      expect(rows).toHaveLength(CHAR_H);
      for (const row of rows) {
        expect(row).toHaveLength(CHAR_W);
        expect(row).toMatch(/^[.aAD]*$/);
      }
      expect(rows.join('')).toMatch(/[aA]/);
    }
  });

  it('left is the mirror of right, so the accessory turns with the character', () => {
    for (const accessory of accessories) {
      expect(accessoryRows(accessory, 'left')).toEqual(accessoryRows(accessory, 'right').map((row) => Array.from(row).reverse().join('')));
    }
  });
});
