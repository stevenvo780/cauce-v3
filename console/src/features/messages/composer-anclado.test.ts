import { describe, expect, it } from 'vitest';
import { VAR_TOPE_MENSAJERIA } from './MessagesPage';
import { leerCss } from '../../test/leer-css';
import { bloqueMedia, declaraciones, sinComentarios, valor } from '../../test/css-parser';

const CSS = sinComentarios(leerCss('features/messages/messages.css'));
const MOBILE = '@media (max-width: 760px)';

function mobile(css: string, selector: string, property: string) {
  return valor(declaraciones(bloqueMedia(css, MOBILE), selector), property);
}
function defects(css: string) {
  const issues: string[] = [];
  const height = mobile(css, '.messenger-shell', 'height') ?? '';
  if (!height.includes(`var(${VAR_TOPE_MENSAJERIA}`)) issues.push('missing measured top');
  if (!height.includes('var(--nav-inferior-alto)')) issues.push('missing navigation space');
  if (!height.includes('safe-area-inset-bottom')) issues.push('missing safe area');
  if (mobile(css, '.messenger-thread', 'height') !== '100%') issues.push('unbounded thread');
  if (mobile(css, '.messenger-composer', 'position') !== 'static') issues.push('composer leaves flow');
  if (mobile(css, '.messenger-composer', 'overflow-y') !== 'auto') issues.push('expanded options cannot scroll');
  return issues;
}

describe('compositor dentro del hilo acotado', () => {
  it('reserva navegación y zona segura sin superponer el compositor', () => {
    expect(defects(CSS)).toEqual([]);
  });
  it.each([
    ['var(--messenger-tope, 120px)', '100px', 'missing measured top'],
    ['var(--nav-inferior-alto)', '0px', 'missing navigation space'],
    ['env(safe-area-inset-bottom, 0px)', '0px', 'missing safe area'],
    ['position: static;', 'position: fixed;', 'composer leaves flow'],
  ])('detecta la regresión %s', (before, after, expected) => {
    const broken = CSS.replaceAll(before, after);
    expect(broken).not.toBe(CSS);
    expect(defects(broken)).toContain(expected);
  });
  it('deja al hilo absorber el espacio y conserva el botón entero', () => {
    const scroll = declaraciones(CSS, '.messenger-thread-scroll');
    expect(valor(scroll, 'min-height')).toBe('0');
    expect(valor(scroll, 'overflow-y')).toBe('auto');
    expect(valor(declaraciones(CSS, '.messenger-composer'), 'flex')).toBe('none');
  });
  it('acota el escritorio con el mismo tope medido', () => {
    const desktop = bloqueMedia(CSS, '@media (min-width: 761px)');
    expect(valor(declaraciones(desktop, '.messenger-shell'), 'height')).toContain(`var(${VAR_TOPE_MENSAJERIA}`);
    expect(valor(declaraciones(desktop, '.messenger-thread'), 'overflow')).toBe('hidden');
  });
  it('el roster se sustituye por la conversación con navegación de vuelta', () => {
    expect(mobile(CSS, '.messenger-shell[data-conversacion="abierta"] .messenger-roster', 'display')).toBe('none');
    expect(mobile(CSS, '.chat-back', 'display')).toBe('grid');
  });
  it('solo oculta la bienvenida, nunca el aviso de agente desconocido', () => {
    expect(mobile(CSS, '.messenger-shell > .messenger-empty[data-state="welcome"]', 'display')).toBe('none');
    expect(mobile(CSS, '.messenger-empty[data-state="missing"]', 'overflow-y')).toBe('auto');
    expect(mobile(CSS, '.messenger-shell > .messenger-empty', 'display')).toBeUndefined();
  });
  it('el compositor expandido tiene un techo y puede desplazarse', () => {
    expect(mobile(CSS, '.messenger-composer', 'max-height')).toBe('55%');
    expect(mobile(CSS, '.messenger-delivery-detail[open]', 'overflow-y')).toBe('auto');
  });
});

it('el riel conserva rótulos en las herramientas y respeta la reducción de movimiento', () => {
  const css = sinComentarios(leerCss('styles.css'));
  expect(css).toContain('.app-shell[data-sidebar="rail"] .sidebar .tools-menu a span { display: block; }');
  const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
  expect(valor(declaraciones(bloqueMedia(reduced, '@media (prefers-reduced-motion: reduce)'), '.agent-avatar[data-working="true"] .agent-avatar-status'), 'animation')).toBe('none');
});
