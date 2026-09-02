import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLAVE_TEMA, TEMAS } from './components/ThemeControl';

const leer = (ruta: string) => readFileSync(resolve(process.cwd(), ruta), 'utf8');
const bootstrap = leer('public/tema.js');

function ejecutar(): void {
  const script = document.createElement('script');
  script.textContent = bootstrap;
  document.head.appendChild(script);
  script.remove();
}

function metaDeTema(esquema: string): HTMLMetaElement {
  const meta = document.createElement('meta');
  meta.name = 'theme-color';
  meta.media = `(prefers-color-scheme: ${esquema})`;
  document.head.appendChild(meta);
  return meta;
}

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.head.replaceChildren();
  window.localStorage.removeItem(CLAVE_TEMA);
});

describe('el arranque de tema que corre antes del paquete', () => {
  it('no es un bloque en línea: la CSP de la consola es script-src self', () => {
    const html = leer('index.html');

    expect(html).toContain('<script src="/tema.js"></script>');
    expect(html.replace(/<script [^>]*src="[^"]*"[^>]*><\/script>/g, '')).not.toContain('<script');
  });

  it('lee exactamente la clave del control y ninguna otra', () => {
    const claves = [...bootstrap.matchAll(/'([^']*)'/g)]
      .map(([, valor]) => valor)
      .filter((valor) => valor.startsWith('cauce.'));

    expect(claves).toEqual([CLAVE_TEMA]);
    expect(bootstrap).toContain('getItem(');
  });

  it('conoce los mismos tres temas que el control', () => {
    const mapa = /ATRIBUTO = \{([^}]*)\}/.exec(bootstrap);
    expect(mapa).not.toBeNull();

    const nombres = [...(mapa?.[1] ?? '').matchAll(/(\w+):/g)].map(([, nombre]) => nombre);

    expect([...nombres].sort()).toEqual([...TEMAS].sort());
  });

  it.each([['claro', 'light'], ['oscuro', 'dark']])('«%s» estampa data-theme="%s"', (tema, valor) => {
    window.localStorage.setItem(CLAVE_TEMA, tema);
    const clara = metaDeTema('light');
    const oscura = metaDeTema('dark');

    ejecutar();

    expect(document.documentElement.getAttribute('data-theme')).toBe(valor);
    expect(clara.media).toBe(valor === 'light' ? 'all' : 'not all');
    expect(oscura.media).toBe(valor === 'dark' ? 'all' : 'not all');
  });

  it.each(['sistema', ''])('«%s» no estampa nada: decide prefers-color-scheme', (tema) => {
    if (tema) window.localStorage.setItem(CLAVE_TEMA, tema);
    const clara = metaDeTema('light');

    ejecutar();

    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(clara.media).toBe('(prefers-color-scheme: light)');
  });

  it('un valor ajeno al mapa no puede colarse como atributo', () => {
    window.localStorage.setItem(CLAVE_TEMA, 'toString');

    ejecutar();

    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});
