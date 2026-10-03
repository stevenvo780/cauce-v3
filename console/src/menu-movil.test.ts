import { describe, expect, it } from 'vitest';
import { PRIMARY_NAV_IDS } from './nav';
import { leerCss } from './test/leer-css';
import { bloqueMedia, declaraciones, valor } from './test/css-parser';

const GLOBAL = leerCss('styles.css');
const MOBILE = '@media (max-width: 760px)';
const RESPONSIVE = leerCss('styles/responsive.css');
const SHELL = leerCss('styles/chat-shell.css');
const AUTH = leerCss('features/auth/auth.css');

function mobile(css: string, selector: string, property: string) {
  return valor(declaraciones(bloqueMedia(css, MOBILE), selector), property);
}
function defects(css: string) {
  const issues: string[] = [];
  if (mobile(css, '.sidebar nav ul', 'display') !== 'grid') issues.push('scrolling navigation');
  if (mobile(css, '.sidebar nav ul', 'grid-auto-rows') !== '48px') issues.push('invalid target height');
  if (mobile(css, '.sidebar nav a', 'min-height') !== '48px') issues.push('small touch target');
  if (mobile(css, '.sidebar nav a span', 'display') !== 'none') issues.push('visible mobile labels');
  if (mobile(css, '.sidebar nav a', 'min-width') !== '0') issues.push('automatic minimum width');
  return issues;
}

describe('navegación móvil compacta', () => {
  it('reserva una fila para iconos y 48px de objetivo táctil', () => {
    expect(defects(RESPONSIVE)).toEqual([]);
    const columns = mobile(RESPONSIVE, '.sidebar nav ul', 'grid-template-columns') ?? '';
    expect(Number(/repeat\(\s*(\d+)\s*,/.exec(columns)?.[1])).toBe(PRIMARY_NAV_IDS.length + 1);
    expect(GLOBAL).toMatch(/--nav-inferior-alto:\s*56px;/);
  });
  it.each([
    ['grid-auto-rows: 48px', 'grid-auto-rows: 32px', 'invalid target height'],
    ['min-height: 48px', 'min-height: 24px', 'small touch target'],
    ['.sidebar nav a span { display: none; }', '.sidebar nav a span { display: block; }', 'visible mobile labels'],
    ['.sidebar nav a { min-width: 0;', '.sidebar nav a { min-width: auto;', 'automatic minimum width'],
    ['.sidebar nav ul { display: grid; grid-template-columns:', '.sidebar nav ul { display: flex; grid-template-columns:', 'scrolling navigation'],
  ])('detecta la regresión %s', (before, after, expected) => {
    const broken = RESPONSIVE.replaceAll(before, after);
    expect(broken).not.toBe(RESPONSIVE);
    expect(defects(broken)).toContain(expected);
  });
  it('cuenta y herramientas conservan tamaño táctil sin recuperar los rótulos', () => {
    expect(mobile(SHELL, '.tools-trigger', 'height')).toBe('48px');
    expect(mobile(SHELL, '.tools-trigger', 'min-height')).toBe('48px');
    expect(mobile(AUTH, '.account-trigger', 'height')).toBe('48px');
    expect(mobile(AUTH, '.account-trigger', 'min-width')).toBe('48px');
    expect(mobile(SHELL, '.tools-trigger > span, .app-shell[data-sidebar="rail"] .tools-trigger > span', 'display')).toBe('none');
    expect(mobile(AUTH, '.account-name, .account-chevron', 'display')).toBe('none');
  });
  it('mantiene safe-area, foco visible y rótulos completos dentro de Herramientas', () => {
    expect(mobile(RESPONSIVE, '.sidebar', 'height')).toContain('env(safe-area-inset-bottom, 0px)');
    expect(mobile(RESPONSIVE, '.sidebar', 'padding-bottom')).toBe('env(safe-area-inset-bottom, 0px)');
    expect(mobile(SHELL, '.sidebar [data-navigation-label]:focus-visible', 'outline')).toBe('2px solid var(--mint)');
    expect(SHELL).toContain('.app-shell .sidebar .tools-menu a span, .app-shell[data-sidebar="rail"] .sidebar .tools-menu a span { display: block; }');
    expect(mobile(SHELL, '.app-shell .sidebar .tools-menu a', 'min-height')).toBe('44px');
  });
});
