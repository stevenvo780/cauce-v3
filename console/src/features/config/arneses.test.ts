import { describe, expect, it } from 'vitest';
import {
  ARNESES_REALES, DONDE_SE_ESCRIBE_EL_ROL_DECLARADO,
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
 * (services/gateway/src/console/agent-documents/catalog.ts:317): claude, codex y openclaw tienen documento
 * resuelto; todo lo demás —hermes incluido— cae al `default` y devuelve lista vacía. Si el gateway
 * aprende un arnés nuevo, esta prueba se pone roja y obliga a decidir qué se enseña, en vez de
 * dejar una fila muda.
 */

const JUEGO_CERRADO = ['claude', 'codex', 'openclaw', 'hermes'] as const;

describe('la tabla de arneses reales', () => {
  it('cubre el juego cerrado que el gateway sabe resolver, más el que no resuelve ninguno', () => {
    expect(ARNESES_REALES.map((arnes) => arnes.id).sort()).toEqual([...JUEGO_CERRADO].sort());
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
    expect(ARNESES_REALES.filter((arnes) => arnes.directiva.trim() === '').map((arnes) => arnes.id)).toEqual(['hermes']);
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

  it('la frase de cierre cita la cadena entera del rol declarado y manda a donde SÍ se escribe', () => {
    expect(DONDE_SE_ESCRIBE_EL_ROL_DECLARADO).toMatch(/role_brief/);
    expect(DONDE_SE_ESCRIBE_EL_ROL_DECLARADO).toMatch(/selfRoleFromProfile/);
    expect(DONDE_SE_ESCRIBE_EL_ROL_DECLARADO).toMatch(/self_role/);
    expect(DONDE_SE_ESCRIBE_EL_ROL_DECLARADO).toMatch(/«Perfil»/);
    expect(DONDE_SE_ESCRIBE_EL_ROL_DECLARADO).toMatch(/sólo lectura/);
  });

  it('CONTROL NEGATIVO — la frase no vuelve a prometer que el rol se escribe en esta pantalla', () => {
    expect(DONDE_SE_ESCRIBE_EL_ROL_DECLARADO)
      .not.toMatch(/se escribe desde acá|se edita desde acá|se escribe acá|lo único de esta lista/i);
  });
});
