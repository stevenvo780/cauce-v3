import { describe, expect, it } from 'vitest';
import { leerCss } from '../../test/leer-css';

/**
 * QUE EL AVISO MÁS IMPORTANTE DE LA VISTA SE PUEDA LEER TAMBIÉN SOBRE PAPEL BLANCO.
 *
 * Esto no es una precaución teórica: se midió con Chrome sobre la consola en modo mock, a 1500 px
 * y con `prefers-color-scheme: light`. Sin el bloque de modo claro, el recuadro que explica «no
 * hay camino hasta el disco de este agente» salía a **1,36:1** de contraste —rosa pálido sobre
 * rosa pálido, o sea invisible—, y con él sale a **7,44:1**.
 *
 * Y era justo el peor sitio donde podía pasar. Ese recuadro es la ÚNICA explicación de por qué el
 * editor no trae contenido; si no se ve, la pantalla queda como una lista de ficheros que no se
 * abren, sin una sola palabra, que es exactamente la clase de «hueco mudo» que este trabajo venía
 * a quitar. Un aviso ilegible es peor que ninguno: ocupa el sitio del que sí se leería.
 *
 * jsdom no tiene layout ni color calculado, así que —igual que `styles.legibilidad.test.ts`— esto
 * comprueba la HOJA como texto. Es lo barato que atrapa la regresión, y lleva su control negativo
 * por mutación: se le da de comer una hoja sin el bloque y se exige que la marque.
 */

const HOJA = 'features/live/live.css';

/** Devuelve el contenido de TODOS los `@media (prefers-color-scheme: light)` de la hoja. */
export function bloquesDeModoClaro(css: string): string {
  const bloques: string[] = [];
  const marca = '@media (prefers-color-scheme: light)';
  let desde = css.indexOf(marca);
  while (desde !== -1) {
    const abre = css.indexOf('{', desde);
    let nivel = 0;
    let i = abre;
    for (; i < css.length; i += 1) {
      if (css[i] === '{') nivel += 1;
      else if (css[i] === '}') {
        nivel -= 1;
        if (nivel === 0) break;
      }
    }
    bloques.push(css.slice(abre + 1, i));
    desde = css.indexOf(marca, i);
  }
  return bloques.join('\n');
}

/**
 * Clases del editor de ficheros que pintan color y fondo con un hex fijo en vez de con tokens del
 * tema. Cada una de ellas TIENE que redefinirse en modo claro, porque un hex de tema oscuro no se
 * adapta solo.
 */
const CON_COLOR_FIJO = ['.ficheros-caveat', '.ficheros-aviso', '.ficheros-fallo'];

describe('los avisos del editor de ficheros se leen en los dos temas', () => {
  it('cada recuadro con color fijo tiene su redefinición en modo claro', () => {
    const claro = bloquesDeModoClaro(leerCss(HOJA));
    for (const clase of CON_COLOR_FIJO) {
      expect(claro, `${clase} no se redefine en modo claro`).toContain(clase);
    }
  });

  /**
   * EL CONTROL NEGATIVO. Sin esto, la prueba de arriba pasaría igual con una función que
   * devolviera la hoja entera —o cualquier cosa que contenga esos nombres—, y no probaría nada.
   */
  it('una hoja SIN el bloque de modo claro se marca como rota', () => {
    const rota = '.ficheros-fallo { color: #ffb7bc; }\n@media (max-width: 600px) { .x { color: red; } }';
    const claro = bloquesDeModoClaro(rota);
    expect(claro).not.toContain('.ficheros-fallo');
  });

  it('el extractor devuelve el contenido del bloque y no la hoja entera', () => {
    const hoja = '.fuera { color: red; }\n@media (prefers-color-scheme: light) { .dentro { color: blue; } }';
    const claro = bloquesDeModoClaro(hoja);
    expect(claro).toContain('.dentro');
    expect(claro).not.toContain('.fuera');
  });

  /** Las llaves anidadas no pueden cortar el bloque antes de tiempo. */
  it('el extractor sobrevive a reglas anidadas dentro del bloque', () => {
    const hoja = '@media (prefers-color-scheme: light) { .a { color: blue; } .b { color: green; } }\n.despues { color: red; }';
    const claro = bloquesDeModoClaro(hoja);
    expect(claro).toContain('.b');
    expect(claro).not.toContain('.despues');
  });
});
