import { describe, expect, it } from 'vitest';
import {
  ARNESES_REALES, LO_QUE_AJUSTES_GOBIERNA, arnesesSinDirectivaPropia, faltantesDelJuegoCerrado,
} from './arneses';

/**
 * **La tabla de cómo funciona cada arnés DE VERDAD.**
 *
 * Existe porque «Ajustes y altas» ofrecía tocar `agents.harness_id` como si de esa columna saliera
 * el programa que corre el bot, y no sale de ahí (ver `campos-inertes.ts`). La pregunta que el
 * operador tiene delante —«¿dónde se cambia lo que este bot lee?»— sólo se puede contestar por
 * arnés, y la respuesta es distinta en los cuatro.
 *
 * El juego es CERRADO y sale de `resolveAgentDocuments()`
 * (services/gateway/src/console/agent-documents.ts:127): claude, codex y openclaw tienen documento
 * resuelto; todo lo demás —hermes incluido— cae al `default` y devuelve lista vacía. Si el gateway
 * aprende un arnés nuevo, esta prueba se pone roja y obliga a decidir qué se enseña, en vez de
 * dejar una fila muda.
 */

const JUEGO_CERRADO = ['claude', 'codex', 'openclaw', 'hermes'] as const;

describe('la tabla de arneses reales', () => {
  it('cubre el juego cerrado que el gateway sabe resolver, más el que no resuelve ninguno', () => {
    expect(faltantesDelJuegoCerrado(ARNESES_REALES, JUEGO_CERRADO)).toEqual([]);
    expect(ARNESES_REALES.map((arnes) => arnes.id).sort()).toEqual([...JUEGO_CERRADO].sort());
  });

  /**
   * CONTROL NEGATIVO POR MUTACIÓN: se le quita hermes a la tabla y se exige que lo señale. Hermes
   * es justo el que se olvida —no lee ningún fichero de instrucciones, así que no tiene fila que
   * escribir— y olvidarlo dejaría a su dueño creyendo que la pantalla no sabe nada de él.
   */
  it('señala un arnés que falta', () => {
    const rota = ARNESES_REALES.filter((arnes) => arnes.id !== 'hermes');
    expect(faltantesDelJuegoCerrado(rota, JUEGO_CERRADO)).toEqual(['hermes']);
  });

  it('el que lee algo dice DÓNDE, y ninguno repite la ruta de otro', () => {
    const donde = ARNESES_REALES.map((arnes) => arnes.directiva);
    expect(new Set(donde).size, 'dos arneses no pueden leer exactamente lo mismo').toBe(donde.length);
    for (const arnes of ARNESES_REALES) {
      expect(arnes.label.trim().length, `${arnes.id} no tiene rótulo`).toBeGreaterThan(0);
      expect(arnes.detalle.trim().length, `${arnes.id} no explica su ruta`).toBeGreaterThan(0);
      // La ruta vacía es un dato, no un hueco: significa «no lee ninguno», y lo comprueba el aserto
      // de hermes de más abajo. Lo que no puede pasar es que una ruta declarada esté a medias.
      if (arnes.directiva !== '') expect(arnes.directiva.trim()).toBe(arnes.directiva);
    }
  });

  it('hermes es el único que no lee ningún documento de instrucciones', () => {
    expect(arnesesSinDirectivaPropia(ARNESES_REALES)).toEqual(['hermes']);
  });

  /**
   * Lo importante de toda la tabla: NINGUNO de esos ficheros se toca desde «Ajustes y altas».
   * Prometer lo contrario mandaría a un operador a buscar acá un editor que vive en otra pantalla.
   */
  it('ninguna fila se declara editable desde esta pantalla, y todas dicen dónde sí se toca', () => {
    for (const arnes of ARNESES_REALES) {
      expect(arnes.editableDesdeAjustes, `${arnes.id} se declara editable acá`).toBe(false);
      expect(arnes.dondeSeToca.trim().length, `${arnes.id} no dice dónde se toca`).toBeGreaterThan(0);
    }
  });

  it('la frase de lo que esta pantalla SÍ gobierna cita la cadena entera del rol declarado', () => {
    expect(LO_QUE_AJUSTES_GOBIERNA).toMatch(/role_brief/);
    expect(LO_QUE_AJUSTES_GOBIERNA).toMatch(/repository\.ts:1821/);
    expect(LO_QUE_AJUSTES_GOBIERNA).toMatch(/self_role/);
  });
});
