import { describe, expect, it } from 'vitest';
import { leerCss } from '../../test/leer-css';
import { reglasDe, valor } from '../../test/css-parser';

const fleet = reglasDe(leerCss('features/live/live-fleet.css'));
const graph = reglasDe(leerCss('features/live/live-hypergraph.css'));
function mobileValue(rules: typeof fleet, selector: string, property: string) {
  return rules.filter((rule) => rule.selector === selector
    && (!rule.media || rule.media.includes('max-width: 760px')))
    .map((rule) => valor(rule.cuerpo, property)).filter((value) => value !== undefined).at(-1);
}

describe('mobile fleet layout contracts', () => {
  it('keeps the alias search compact after the complete cascade', () => {
    expect(mobileValue(fleet, '.live-search input', 'width')).toBe('110px');
    expect(mobileValue(fleet, '.live-search input', 'min-width')).toBe('0');
    expect(mobileValue(fleet, '.live-search', 'flex')).toBe('0 1 auto');
  });
  it('keeps the verdict and toolbar compact without hiding controls', () => {
    expect(mobileValue(fleet, '.fleet-verdict-phrase', 'font-size')).toBe('24px');
    expect(mobileValue(fleet, '.live-toolbar', 'padding')).toBe('var(--space-2)');
  });
  it('gives the search field a visible keyboard focus', () => {
    expect(mobileValue(fleet, '.live-search:focus-within', 'outline')).toBe('2px solid var(--blue)');
  });
  it('contains horizontal graph panning without shrinking its readable canvas', () => {
    expect(mobileValue(graph, '.lhg-scroll', 'overflow-x')).toBe('auto');
    expect(mobileValue(graph, '.lhg-scroll', 'max-width')).toBe('100%');
    expect(mobileValue(graph, '.lhg-scroll', 'overscroll-behavior-x')).toBe('contain');
    expect(mobileValue(graph, '.lhg-svg', 'min-width')).toBe('860px');
    expect(mobileValue(graph, '.lhg-svg', 'max-height')).toBe('none');
  });
});
