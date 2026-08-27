import { describe, expect, it } from 'vitest';
import { leerCss } from '../test/leer-css';

/**
 * Las pestañas inactivas eran invisibles en tema claro. 
 * 1280x900, sobre /accounts y /observability.**
 *
 * `.view-tabs` declara su fondo con un azul de noche fijo (`rgb(13 20 34 / 60%)`) y no tenía
 * override para `prefers-color-scheme: light`. Sobre la página clara queda un gris pizarra
 * (105,110,120); el texto de una pestaña inactiva es `--muted` (87,103,124). Contraste medido:
 * **1,13:1**. No es «poco contraste», es que no se ven.
 *
 * Lo que costaba: en /accounts esconde «Inventario» y «Asignaciones» —dos tercios de la vista, y
 * la mitad que sigue sirviendo cuando el recolector de cuotas está caído— y en /observability
 * esconde «Auditoría». Un operador que no ve la pestaña no sabe que la vista tiene más.
 *
 * Se comprueba sobre la hoja porque acá no hay servidor X: jsdom no resuelve `@media` ni calcula
 * contraste. Después del arreglo, medido en el navegador: inactivas **5,13:1**, activa 16,35:1.
 */
const HOJA = leerCss('styles.css');

/** Cuerpos de todos los `@media (prefers-color-scheme: light)`, contando llaves. */
function bloquesClaros(css: string): string[] {
  const salida: string[] = [];
  const patron = /@media\s*\(\s*prefers-color-scheme:\s*light\s*\)\s*\{/g;
  for (let coincidencia = patron.exec(css); coincidencia; coincidencia = patron.exec(css)) {
    let profundidad = 1;
    let i = coincidencia.index + coincidencia[0].length;
    const desde = i;
    while (i < css.length && profundidad > 0) {
      if (css[i] === '{') profundidad += 1;
      if (css[i] === '}') profundidad -= 1;
      i += 1;
    }
    salida.push(css.slice(desde, i - 1));
  }
  return salida;
}

function declaracion(css: string, selector: string, propiedad: string): string | undefined {
  const patron = new RegExp(`(^|[},])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const bloque = patron.exec(css.replace(/\/\*[\s\S]*?\*\//g, ' '));
  if (!bloque) return undefined;
  return new RegExp(`(?:^|;)\\s*${propiedad}\\s*:\\s*([^;]+)`).exec(bloque[2])?.[1].trim();
}

describe('la barra de pestañas se ve en tema claro', () => {
  const claros = bloquesClaros(HOJA);

  it('hay al menos un bloque de tema claro donde mirar', () => {
    expect(claros.length).toBeGreaterThan(0);
  });

  it('.view-tabs repinta su fondo en claro en vez de dejar el azul de noche', () => {
    const fondos = claros.map((bloque) => declaracion(bloque, '.view-tabs', 'background')).filter(Boolean);
    expect(fondos).not.toHaveLength(0);
    // Y lo que pone es un token del tema, no otro color oscuro escrito a mano.
    expect(fondos[0]).toMatch(/var\(--surface/);
  });

  it('la pestaña ACTIVA sigue distinguiéndose de la barra en claro', () => {
    const activa = claros
      .map((bloque) => declaracion(bloque, ".view-tab[aria-selected='true']", 'background'))
      .filter(Boolean);
    expect(activa).not.toHaveLength(0);
    expect(activa[0]).not.toBe(declaracion(claros.join('\n'), '.view-tabs', 'background'));
  });

  it('el contador de la pestaña deja de ser blanco sobre blanco', () => {
    const badge = claros.map((bloque) => declaracion(bloque, '.view-tab-badge', 'background')).filter(Boolean);
    expect(badge).not.toHaveLength(0);
    expect(badge[0]).not.toMatch(/255\s+255\s+255/);
  });

  /**
   * CONTROL NEGATIVO del guardia: se le da de comer la hoja exactamente como estaba cuando se
   * midió el 1,13:1 y se exige que no encuentre nada. Un comprobador que aprueba cualquier cosa
   * es peor que no tenerlo.
   */
  it('con la hoja anterior —sin override claro— no encontraría ningún fondo', () => {
    const anterior = `
      .view-tabs { background: rgb(13 20 34 / 60%); }
      @media (prefers-color-scheme: light) {
        :root { --surface: #ffffff; }
        .badge-offline { border-color: #ccd4de; }
      }
    `;
    const bloques = bloquesClaros(anterior);
    expect(bloques).toHaveLength(1);
    expect(declaracion(bloques[0], '.view-tabs', 'background')).toBeUndefined();
    // Y el azul de noche seguía siendo la única declaración de la barra.
    expect(declaracion(anterior, '.view-tabs', 'background')).toBe('rgb(13 20 34 / 60%)');
  });
});
