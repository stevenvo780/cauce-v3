import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/styles/theme.css'), 'utf8');

function tokens(block: string): Map<string, string> {
  return new Map(Array.from(block.matchAll(/--c-([\w-]+):\s*oklch\(([^)]+)\)/g), ([, name, value]) => [name, value]));
}

function blockAfter(marker: string): string {
  const start = css.indexOf(marker);
  expect(start, marker).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < css.length; index++) {
    if (css[index] === '{') depth++;
    if (css[index] === '}' && --depth === 0) return css.slice(open + 1, index);
  }
  throw new Error(`unterminated block after ${marker}`);
}

function luminance(oklch: string): number {
  const [l, c, h] = oklch.split('/')[0].trim().split(/\s+/).map(Number);
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const lp = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mp = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sp = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const r = clamp(4.0767416621 * lp - 3.3077115913 * mp + 0.2309699292 * sp);
  const g = clamp(-1.2684380046 * lp + 2.6097574011 * mp - 0.3413193965 * sp);
  const bl = clamp(-0.0041960863 * lp - 0.7034186147 * mp + 1.707614701 * sp);
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}

function ratio(foreground: string, background: string): number {
  const [hi, lo] = [luminance(foreground), luminance(background)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/* Every text/background pairing the components actually paint. */
const PAIRS: [string, string][] = [
  ['fg', 'canvas'], ['fg', 'surface'], ['fg-2', 'surface'], ['muted', 'canvas'], ['muted', 'surface'],
  ['muted', 'subtle'], ['muted', 'muted-bg'], ['brand-ink', 'brand-soft'], ['brand-ink', 'surface'],
  ['on-brand', 'brand'], ['ok-ink', 'ok-soft'], ['info-ink', 'info-soft'], ['warn-ink', 'warn-soft'],
  ['danger-ink', 'danger-soft'], ['violet-ink', 'violet-soft'], ['danger-ink', 'surface'],
  ['warn-ink', 'surface'], ['ok-ink', 'surface'],
];

const THEMES = {
  light: tokens(blockAfter(':root {')),
  'dark (system)': tokens(blockAfter("  :root:not([data-theme='light']) {")),
  'dark (forced)': tokens(blockAfter(":root[data-theme='dark']")),
};

describe('brand palette', () => {
  it('declares the same tokens in the three theme paths', () => {
    const names = [...THEMES.light.keys()].sort();
    expect(names.length).toBeGreaterThan(20);
    expect([...THEMES['dark (system)'].keys()].sort()).toEqual(names);
    expect([...THEMES['dark (forced)'].keys()].sort()).toEqual(names);
    expect([...THEMES['dark (forced)'].entries()]).toEqual([...THEMES['dark (system)'].entries()]);
  });

  it.each(Object.entries(THEMES))('meets WCAG AA for every text pairing in %s', (_, theme) => {
    for (const [fg, bg] of PAIRS) {
      expect(ratio(theme.get(fg)!, theme.get(bg)!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
