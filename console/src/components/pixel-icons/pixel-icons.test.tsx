import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { isPixelIconRef, PIXEL_ICON_PREFIX } from '../../api/client/agent-preferences-client';
import { PIXEL_ICON_CATEGORIES, PIXEL_ICON_NAMES } from './catalog';
import { crispIconSize } from './icon-size';
import { loadablePixelIconNames, pixelIconLoader } from './loaders';
import { PixelIcon } from './PixelIcon';
import { svgToPathData } from './svg-shapes';

describe('curated pixel icons', () => {
  it('has no duplicates and every name fits a px: reference', () => {
    expect(new Set(PIXEL_ICON_NAMES).size).toBe(PIXEL_ICON_NAMES.length);
    expect(PIXEL_ICON_NAMES.length).toBeGreaterThanOrEqual(150);
    for (const name of PIXEL_ICON_NAMES) expect(isPixelIconRef(`${PIXEL_ICON_PREFIX}${name}`), name).toBe(true);
    for (const category of PIXEL_ICON_CATEGORIES) expect(category.names.length).toBeGreaterThan(0);
  });

  it('resolves every curated name to a package file and loads nothing else', () => {
    expect([...loadablePixelIconNames()].sort()).toEqual([...PIXEL_ICON_NAMES].sort());
  });

  it('turns every curated svg into safe path data', async () => {
    for (const name of PIXEL_ICON_NAMES) {
      const load = pixelIconLoader(name);
      if (!load) throw new Error(`missing loader for ${name}`);
      expect(svgToPathData(await load()), name).toMatch(/^[MmHhVvLlZz0-9\s.,-]+$/);
    }
  });
});

describe('svgToPathData', () => {
  it('keeps path and rect geometry and drops everything else', () => {
    const svg = '<svg><script>alert(1)</script><path onload="x()" d="M0 0h2v2z"/><rect x="1" y="2" width="3" height="4" onclick="x()"/><image href="x"/></svg>';
    expect(svgToPathData(svg)).toBe('M0 0h2v2zM1 2h3v4h-3z');
  });

  it('refuses path data that is not plain geometry', () => {
    expect(svgToPathData('<path d="M0 0 url(javascript:x)"/>')).toBeNull();
    expect(svgToPathData('<svg></svg>')).toBeNull();
  });
});

describe('PixelIcon', () => {
  it('draws the lazily loaded icon at an integer size', async () => {
    const { container } = render(<PixelIcon name="robot" size={19.4} />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('19');
    expect(svg?.getAttribute('shape-rendering')).toBe('crispEdges');
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 50); }); });
    expect(container.querySelector('path')?.getAttribute('d')).toContain('M5 7h14v2H5z');
  });

  it('stays empty for an unknown name', async () => {
    const { container } = render(<PixelIcon name="not-an-icon" />);
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('path')).toBeNull();
  });
});

describe('crispIconSize', () => {
  it('snaps to whole grid multiples from one grid up and rounds below it', () => {
    expect([10.4, 19.2, 23.6, 24, 28.8, 33.6, 38.4, 57.6].map(crispIconSize)).toEqual([10, 19, 24, 24, 24, 24, 48, 48]);
  });
});
