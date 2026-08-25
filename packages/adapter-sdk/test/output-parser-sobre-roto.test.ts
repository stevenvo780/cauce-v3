import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseFinalText } from '../src/sdk/output-parser.js';

// ---------------------------------------------------------------------------
// BUG MEDIDO: `argos` perdio 4 turnos ENTEROS el 2026-08-15 (y 5 el 31-jul) con
// `last_error = "OpenClaw result contained a malformed JSON object"` y `deliveries.result = NULL`.
// Los cuatro eran entregas de tipo `agent.response`: el agente hizo el trabajo, escribio la
// respuesta, y el parser la descarto COMPLETA porque un caracter del sobre no era JSON valido.
// Era el unico alias de la flota con ese error en 7 dias.
//
// LA CAUSA, ya con la salida cruda de los cuatro turnos delante, ES UN SOLO CARACTER: el separador
// entre la clave y el valor llego como `>` en vez de `:`. Los cuatro sobres empiezan literalmente
// `{"reply">"**…` y `JSON.parse` muere siempre en la misma posicion 8. NO estaban truncados
// (`stopReason: "stop"`): los cuatro cierran limpio en
// `…,"notify":[],"status":"done","retryable":false,"artifacts":[]}`, y sustituyendo ese unico
// caracter parsean perfecto —seis claves, `status:"done"`, replies de 2.743 a 3.683 caracteres—.
// El modelo era `claude-opus-5[1m]` por `provider: claude-cli`, y el patron `"reply">` aparece 4
// veces en TODA la flota, las cuatro en argos. Los `task_runs` de openclaw figuran `succeeded` con
// `terminal_summary=completed` y sin error: el turno CORRIO BIEN y murio al parsearse.
//
// `rescataReply` ya existia y no lo rescataba porque su marca era `/"reply"\s*:\s*"/u` y exige el
// `:` literal. Ademas solo cubria el sobre cortado DESPUES de un `reply` intacto; se corrio el
// parser caso por caso sobre las otras formas de sobre roto (no de memoria) y 20 mas morian en ese
// mismo `throw`. Estan todas abajo, cada una con su ejemplo literal medido.
//
// Principio rector: LA RESPUESTA ES EL TRABAJO. Ningun campo accesorio mal formado puede costar un
// turno entero; se descarta la parte mala y el turno queda vivo.
// ---------------------------------------------------------------------------

const SOBRE = '"messages":[],"status":"done","retryable":false,"artifacts":[]';

// --- Familia 0: EL CASO DE ARGOS. Separador corrupto entre la clave y el valor -------------------

// Prefijo LITERAL del crudo de la entrega `c8fb53c6`, con su cierre real. Este test falla contra el
// parser anterior —`OpenClaw result contained a malformed JSON object`, `result` NULL— y pasa con
// el parche.
const CRUDO_ARGOS_C8FB53C6 = '{"reply">"**12/12 con la relectura, en el entorno aislado y sin tocar producción: el frente queda cerrado y sin huecos.** Y lo mejor de esta entrega no son los doce verdes: es que **no te quedaste con el 10/10 que reportó heraclito ","messages":[],"notify":[],"status":"done","retryable":false,"artifacts":[]}';

test('el crudo real de argos c8fb53c6 se entrega entero, no se pierde el turno', () => {
  const salida = parseFinalText(CRUDO_ARGOS_C8FB53C6, 'OpenClaw result');
  assert.equal(salida.status, 'done');
  assert.match(salida.reply ?? '', /^\*\*12\/12 con la relectura/u);
  assert.match(salida.reply ?? '', /reportó heraclito/u);
  assert.deepEqual(salida.messages, []);
});

// `bea579a8` traia 2 `messages` legitimos. Como el sobre cierra bien, el arreglo repara el
// separador y revalida el sobre ENTERO: rescatar solo el texto habria salvado la respuesta y tirado
// las dos delegaciones, que es el mismo dano que ya documenta `recoverEmbeddedEnvelope`.
test('un sobre de argos con delegaciones las conserva: se repara y se revalida entero', () => {
  const crudo = '{"reply">"El GO ya esta dado.","messages":[{"to":"kant","body":"segui con el despliegue"},{"to":"zeus","body":"mira el limite de salida"}],"notify":[],"status":"done","retryable":false,"artifacts":[]}';
  const salida = parseFinalText(crudo, 'OpenClaw result');
  assert.equal(salida.status, 'done');
  assert.equal(salida.messages.length, 2);
  assert.deepEqual(salida.messages.map((mensaje) => mensaje.to), ['kant', 'zeus']);
});

test('el separador corrupto en cualquier otra clave del sobre tampoco cuesta el turno', () => {
  const crudo = '{"reply":"ok","messages":[],"notify":[],"status">"done","retryable":false,"artifacts":[]}';
  assert.equal(parseFinalText(crudo, 'OpenClaw result').reply, 'ok');
});

test('el separador corrupto tolera los espacios que JSON ya permitia', () => {
  assert.equal(parseFinalText(`{"reply" > "Ya revise.",${SOBRE}}`, 'X').reply, 'Ya revise.');
});

// El ancho de la tolerancia es de UN caracter y se excluyen los estructurales de JSON. Estos son
// los falsos positivos que esa decision compra, y tienen que seguir cayendo al piso honesto en vez
// de devolver el texto de otro campo como si fuera la respuesta.
test('la marca tolerante NO confunde un "reply" usado como VALOR ajeno', () => {
  // Una coma como separador devolveria "cuerpo ajeno" como respuesta del agente.
  assert.equal(parseFinalText('{"messages":[{"to":"reply","body":"cuerpo ajeno","x', 'X').status, 'failed');
  assert.equal(parseFinalText('{"artifacts":[{"name":"reply","uri":"memory://x","z', 'X').status, 'failed');
});

test('la marca tolerante NO rescata un valor de reply que no es texto', () => {
  // Con dos caracteres de tolerancia, `:{` y `:[` saltarian al primer texto de adentro.
  for (const valor of ['null', '123', 'true', '{"texto":"hola"}', '["a","b"]']) {
    const salida = parseFinalText(`{"reply":${valor},"messages":[{"to":"kant","bo`, 'X');
    assert.equal(salida.status, 'failed', `no debio rescatar ${valor} como texto`);
  }
});

test('un separador AUSENTE no se adivina', () => {
  assert.equal(parseFinalText('{"reply""Ya revise el bridge.","messages":[{"to":"ka', 'X').status, 'failed');
});

test('reparar el separador NUNCA toca el texto de una respuesta', () => {
  // argos escribe sobre las claves de Cauce a diario: si el remiendo mirara dentro de las cadenas,
  // este reply quedaria alterado en silencio.
  const crudo = `{"reply">"Revise el campo \\"status\\" y el \\"reply\\", y usa {\\"a\\": 1} como ejemplo.",${SOBRE}}`;
  assert.equal(
    parseFinalText(crudo, 'X').reply,
    'Revise el campo "status" y el "reply", y usa {"a": 1} como ejemplo.',
  );
});

test('dos separadores corruptos no se reparan por intuicion ni materializan mensajes', () => {
  const crudo = '{"reply">"Respuesta salvada.","messages":[{"to":"kant","body":"no debe salir"}],"status">"done","retryable":false,"artifacts":[]}';
  const salida = parseFinalText(crudo, 'X');
  assert.equal(salida.reply, 'Respuesta salvada.');
  assert.deepEqual(salida.messages, []);
});

test('un sobre reparable cuyo mensaje no revalida conserva el reply pero no el efecto', () => {
  const crudo = '{"reply">"Respuesta salvada.","messages":[{"to":"NO-ES-ALIAS","body":"no debe salir"}],"status":"done","retryable":false,"artifacts":[]}';
  const salida = parseFinalText(crudo, 'X');
  assert.equal(salida.reply, 'Respuesta salvada.');
  assert.deepEqual(salida.messages, []);
});

test('dos claves reply dentro del mismo sobre roto son ambiguas y fallan cerrado', () => {
  const salida = parseFinalText('{"reply":"uno","reply":"dos","messages":[', 'X');
  assert.equal(salida.status, 'failed');
  assert.deepEqual(salida.messages, []);
});

// --- Familia 1: caracteres de control CRUDOS dentro de la cadena --------------------------------
// La mas probable de todas, y la que no tiene NADA de truncamiento: el modelo escribe su JSON a
// mano y mete el salto de linea real en vez de `\n`. El `reply` esta COMPLETO y aun asi se perdia
// el turno entero. Aca no se rescata solo el reply: se repara el sobre y se recupera ENTERO.

test('un salto de linea REAL sin escapar ya no cuesta el turno: se repara el sobre entero', () => {
  const crudo = `{"reply":"Primera linea\nSegunda linea",${SOBRE}}`;
  const salida = parseFinalText(crudo, 'OpenClaw result');
  assert.equal(salida.reply, 'Primera linea\nSegunda linea');
  assert.equal(salida.status, 'done');
});

test('un tabulador REAL sin escapar tampoco', () => {
  assert.equal(
    parseFinalText(`{"reply":"Columna1\tColumna2",${SOBRE}}`, 'OpenClaw result').reply,
    'Columna1\tColumna2',
  );
});

test('un caracter de control invisible dentro del reply tampoco', () => {
  assert.equal(
    parseFinalText(`{"reply":"Ya revise\u0007 el bridge",${SOBRE}}`, 'OpenClaw result').reply,
    'Ya revise\u0007 el bridge',
  );
});

// Reparar el sobre ENTERO —en vez de rescatar solo el `reply`— es lo que salva las delegaciones:
// un `messages` intacto llega a su destino en lugar de descartarse por un salto de linea.
test('al reparar los controles crudos sobreviven las delegaciones, no solo el reply', () => {
  const crudo = '{"reply":"Delegado.\nYa le escribi.","messages":[{"to":"kant","body":"mira el gateway"}],"status":"done","retryable":false,"artifacts":[]}';
  const salida = parseFinalText(crudo, 'OpenClaw result');
  assert.equal(salida.messages.length, 1);
  assert.equal(salida.messages[0]?.to, 'kant');
});

test('salto de linea real Y corte dentro del reply: se entrega lo que alcanzo a escribir', () => {
  const salida = parseFinalText('{"reply":"Primera linea\nSegunda li', 'OpenClaw result');
  assert.equal(salida.reply, 'Primera linea\nSegunda li');
});

// --- Familia 2: el corte cae a mitad de un escape ------------------------------------------------
// Firma exacta de un corte de transporte a mitad de caracter multibyte. Se descarta la cola rota
// —un caracter— en vez del turno entero.

test('un escape \\u cortado por la mitad no se lleva puesto el reply', () => {
  const salida = parseFinalText('{"reply":"Ya revise el caf\\u00e', 'OpenClaw result');
  assert.equal(salida.reply, 'Ya revise el caf');
});

test('una barra invertida legitima al final NO se recorta de mas', () => {
  // `"ruta C:\\"` es un reply valido y cerrado: si el recorte fuera ciego se comeria la barra.
  const salida = parseFinalText(`{"reply":"ruta C:\\\\","messages":[`, 'OpenClaw result');
  assert.equal(salida.reply, 'ruta C:\\');
});

// --- Familia 3: la valla de codigo que no cierra ------------------------------------------------
// `CODE_FENCE` esta anclada con `$`, asi que una valla sin cerrar no casaba: el candidato se
// quedaba con los ``` delante, dejaba de empezar por `{`, y el sobre entero se publicaba como
// texto plano. El dueno del agente leia por Telegram el volcado crudo del JSON en vez de la
// respuesta — que es justo el bug que la valla existe para evitar.

test('valla ```json sin cerrar con el objeto truncado adentro: entrega el reply, no el volcado', () => {
  const crudo = '```json\n{"reply":"Ya revise el bridge y esta sano.","messages":[{"to":"arg';
  const salida = parseFinalText(crudo, 'OpenClaw result');
  assert.equal(salida.reply, 'Ya revise el bridge y esta sano.');
});

test('texto del modelo ANTES de la valla, con el objeto truncado adentro', () => {
  const crudo = 'Listo, aca va:\n\n```json\n{"reply":"Ya revise el bridge y esta sano.","messages":[{"to":"arg';
  assert.equal(parseFinalText(crudo, 'OpenClaw result').reply, 'Ya revise el bridge y esta sano.');
});

// --- Familia 4: prosa DESPUES del `}` final -----------------------------------------------------
// Este caso no moria, pero perdia las delegaciones EN SILENCIO: el sobre estaba entero y valido, y
// el rescate se quedaba solo con el `reply`. Es el mismo dano que documenta `recoverEmbeddedEnvelope`
// (39 delegaciones destruidas en seis dias). Ahora se recupera el sobre completo.

test('prosa despues del } final: el sobre se recupera ENTERO, con sus delegaciones', () => {
  const crudo = '{"reply":"Delegado.","messages":[{"to":"kant","body":"mira el gateway"}],"status":"done","retryable":false,"artifacts":[]}\n\nAviso: ya le escribi a kant.';
  const salida = parseFinalText(crudo, 'OpenClaw result');
  assert.equal(salida.reply, 'Delegado.');
  assert.equal(salida.messages.length, 1);
  assert.equal(salida.messages[0]?.to, 'kant');
});

test('dos sobres pegados NO se adivinan: se cae al reply del primero, sin delegar', () => {
  // Ambiguedad. `recoverEmbeddedEnvelope` se niega a elegir, y el peldano de abajo entrega la
  // respuesta con `messages` vacio: mejor perder la delegacion que despachar trabajo al azar.
  const crudo = `{"reply":"primero",${SOBRE}}{"reply":"segundo",${SOBRE}}`;
  const salida = parseFinalText(crudo, 'OpenClaw result');
  assert.equal(salida.reply, 'primero');
  assert.deepEqual(salida.messages, []);
});

// --- Familia 5: el PISO. Sin nada rescatable, el turno sigue vivo -------------------------------
// CONTRATO CAMBIADO A PROPOSITO el 2026-08-15. Antes esto era `throw`, y un throw deja
// `deliveries.result` en NULL: quien pregunto no recibe NADA —ni respuesta, ni aviso, ni motivo—.
// Asi estan los 4 turnos de argos de hoy y los 5 del 31-jul. Ahora degrada a "failed" CON TEXTO,
// que es el mismo movimiento que `validateDeliveryOutput` ya hizo dos veces (el MISSING_FINAL_REPLY
// de janus y el volcado de herramienta de openclaw). No se convierte en "done": el turno de verdad
// no produjo respuesta legible y las metricas tienen que seguir contandolo como el fracaso que fue.

test('un sobre con "reply": null y el resto cortado degrada a failed con texto, no a result NULL', () => {
  const salida = parseFinalText('{"reply":null,"messages":[{"to":"kant","bo', 'OpenClaw result');
  assert.equal(salida.status, 'failed');
  assert.equal(salida.retryable, false);
  assert.match(salida.reply ?? '', /no quedo ni una linea de texto rescatable/u);
  // La muestra del sobre viaja acotada en el bloque tecnico: sin ella el diagnostico vuelve a ser
  // adivinar que caracter rompio el JSON.
  assert.match(salida.reply ?? '', /Empieza asi: \{"reply":null/u);
});

test('un sobre SIN reply, cortado mas adelante, tampoco deja la entrega sin result', () => {
  const salida = parseFinalText('{"messages":[{"to":"kant","body":"revisa el bridge"}],"status":"done","retry', 'OpenClaw result');
  assert.equal(salida.status, 'failed');
  // Los accesorios de un sobre roto se descartan A PROPOSITO: un `messages` a medias podria
  // despachar trabajo a quien no corresponde. La delegacion NO se materializa.
  assert.deepEqual(salida.messages, []);
});

test('comillas tipograficas: el sobre es ilegible entero y aun asi el turno responde algo', () => {
  const salida = parseFinalText('{\u201creply\u201d:\u201cYa revise el bridge\u201d}', 'OpenClaw result');
  assert.equal(salida.status, 'failed');
  assert.equal(salida.retryable, false);
});

test('un reply que no es texto (numero, objeto) tampoco tumba el turno', () => {
  assert.equal(parseFinalText('{"reply":123,"messages":[{"to":"kant","bo', 'X').status, 'failed');
  assert.equal(parseFinalText('{"reply":{"text":"hola"},"messages":[{"to":"kant","bo', 'X').status, 'failed');
});

test('un reply vacio o solo con espacios cae al piso, no al throw', () => {
  assert.equal(parseFinalText('{"reply":"   ","messages":[{"to":"arg', 'X').status, 'failed');
  assert.equal(parseFinalText('{"reply":"","messages":[{"to":"arg', 'X').status, 'failed');
});

// --- Lo que NO cambia --------------------------------------------------------------------------

test('un objeto BIEN formado que incumple el esquema sigue siendo fallo duro', () => {
  // Aca el agente declaro un sobre COMPLETO y le faltan campos: no es un corte de transporte, es un
  // contrato incumplido, y ablandarlo esconderia agentes que no aprenden el formato.
  assert.throws(() => parseFinalText('{"reply":"hola"}', 'X'), /missing 'messages'/u);
});

test('una respuesta en prosa sigue siendo una respuesta en prosa', () => {
  assert.match(String(parseFinalText('Ya revise el bridge y esta sano.', 'X').reply), /bridge/u);
  assert.equal(parseFinalText('Ya revise el bridge.', 'X').status, 'done');
});

test('el camino feliz no se toca', () => {
  const salida = parseFinalText(`{"reply":"directo",${SOBRE}}`, 'X');
  assert.equal(salida.reply, 'directo');
  assert.equal(salida.status, 'done');
});
