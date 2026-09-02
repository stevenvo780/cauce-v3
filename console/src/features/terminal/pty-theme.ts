import type { PtyEntry } from './pty-types';

/**
 * Color palette for terminal emulation with ANSI support over a dark background.
 */
export const TEMA_TERMINAL = {
  background: '#0a0e16',
  foreground: '#d8e4f7',
  cursor: '#7ce7c5',
  cursorAccent: '#0a0e16',
  selectionBackground: '#2c5468',
} as const;

/**
 * The monospaced family of the terminal.
 */
export const FUENTE_TERMINAL =
  "ui-monospace, 'SFMono-Regular', 'JetBrains Mono', Menlo, Consolas, 'Liberation Mono', monospace";

export const COLUMNAS_MINIMAS = 80;
export const CUERPO_BASE = 13;
export const CUERPO_MINIMO = 10;

let detachedHolder: HTMLDivElement | undefined;

export function holder(): HTMLDivElement {
  if (!detachedHolder) {
    detachedHolder = document.createElement('div');
    detachedHolder.className = 'pty-detached-holder';
    detachedHolder.setAttribute('aria-hidden', 'true');
    document.body.appendChild(detachedHolder);
  }
  return detachedHolder;
}

export function pintarPiel(entry: PtyEntry): void {
  const estilo = entry.container.style;
  estilo.setProperty('--pty-fuente', FUENTE_TERMINAL);
  estilo.setProperty('--pty-cuerpo', `${String(entry.terminal.options.fontSize ?? CUERPO_BASE)}px`);
  estilo.setProperty('--pty-tinta', TEMA_TERMINAL.foreground);
  estilo.setProperty('--pty-fondo', TEMA_TERMINAL.background);
  estilo.setProperty('--pty-cursor', TEMA_TERMINAL.cursor);
  estilo.setProperty('--pty-cursor-tinta', TEMA_TERMINAL.cursorAccent);
  estilo.setProperty('--pty-seleccion', TEMA_TERMINAL.selectionBackground);
}

let documentoSinEstilos: Document | undefined;

export function documentoQueNiegaLosEstilos(): Document {
  documentoSinEstilos ??= new Proxy(document, {
    get(real, propiedad) {
      if (propiedad === 'createElement') {
        return (etiqueta: string, opciones?: ElementCreationOptions) => (
          etiqueta.toLowerCase() === 'style'
            ? real.createElement('template')
            : real.createElement(etiqueta, opciones)
        );
      }
      const valor = Reflect.get(real, propiedad, real) as unknown;
      return typeof valor === 'function' ? (valor as (...args: unknown[]) => unknown).bind(real) : valor;
    },
  });
  return documentoSinEstilos;
}
