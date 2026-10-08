import { describe, expect, it } from 'vitest';
import { fitText, textWidth } from './pixel-font';

describe('pixel font', () => {
  it('measures four columns per letter minus the trailing gap', () => {
    expect(textWidth('GRP', 1)).toBe(11);
    expect(textWidth('GRP', 2)).toBe(22);
    expect(textWidth('', 2)).toBe(0);
  });

  it('prefers the largest scale that fits and cuts with a dot when none does', () => {
    expect(fitText('SIN GRUPO', 80, 2)).toEqual({ text: 'SIN GRUPO', scale: 2 });
    expect(fitText('SIN GRUPO', 40, 2).scale).toBe(1);
    const cut = fitText('grupo-muy-largo-de-verdad', 40, 2);
    expect(cut.text.endsWith('.')).toBe(true);
    expect(textWidth(cut.text, 1)).toBeLessThanOrEqual(40);
  });
});
