import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseFinalText } from '../src/sdk/output-parser.js';

// ---------------------------------------------------------------------------
//
// THE CAUSE, with the raw output of all four turns in front of us, IS ONE SINGLE CHARACTER: the
// separator between key and value arrived as `>` instead of `:`. All four envelopes start literally
// `{"reply">"**…` and `JSON.parse` always dies at the same position 8. They were NOT truncated
// (`stopReason: "stop"`): all four close cleanly with
// `…,"notify":[],"status":"done","retryable":false,"artifacts":[]}`, and substituting that single
// character they parse perfectly —six keys, `status:"done"`, replies from 2,743 to 3,683 chars—.
// The model was `claude-opus-5[1m]` for `provider: claude-cli`, and the pattern `"reply">` appears
// 4 times in the WHOLE fleet, all four in argos. The `task_runs` from openclaw show `succeeded`
// with `terminal_summary=completed` and no error: the turn RAN FINE and died on parse.
//
// `rescataReply` already existed and did not rescue it because its mark was `/"reply"\s*:\s*"/u`,
// which requires the literal `:`. It also only covered the envelope truncated AFTER an intact
// `reply`; the parser was run case by case over the other broken envelope shapes (not from
// memory) and 20 more died in that same `throw`. They are all below, each with its own literal
//

const SOBRE = '"messages":[],"status":"done","retryable":false,"artifacts":[]';

// --- Family 0: THE ARGOS CASE. Corrupt separator between key and value ---------------------------

// LITERAL prefix of the raw delivery `c8fb53c6`, with its real closing. This test fails against the
// previous parser —`OpenClaw result contained a malformed JSON object`, `result` NULL— and passes
// with the patch.
const CRUDO_ARGOS_C8FB53C6 = '{"reply">"**12/12 con la relectura, en el entorno aislado y sin tocar producción: el frente queda cerrado y sin huecos.** Y lo mejor de esta entrega no son los doce verdes: es que **no te quedaste con el 10/10 que reportó heraclito ","messages":[],"notify":[],"status":"done","retryable":false,"artifacts":[]}';

test('el crudo real de argos c8fb53c6 se entrega entero, no se pierde el turno', () => {
  const salida = parseFinalText(CRUDO_ARGOS_C8FB53C6, 'OpenClaw result');
  assert.equal(salida.status, 'done');
  assert.match(salida.reply ?? '', /^\*\*12\/12 con la relectura/u);
  assert.match(salida.reply ?? '', /reportó heraclito/u);
  assert.deepEqual(salida.messages, []);
});

// `bea579a8` carried 2 legitimate `messages`. Since the envelope closes cleanly, the fix repairs
// the separator and revalidates the WHOLE envelope: rescuing only the text would have saved the
// reply and thrown away the two delegations, which is the same damage `recoverEmbeddedEnvelope`
// already documents.
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

// The tolerance width is ONE character and JSON structural chars are excluded. These are the false
// positives that decision buys, and they must keep falling to the honest floor instead of
// returning another field's text as if it were the reply.
test('la marca tolerante NO confunde un "reply" usado como VALOR ajeno', () => {
  // A comma as separator would return "cuerpo ajeno" as the agent's reply.
  assert.equal(parseFinalText('{"messages":[{"to":"reply","body":"cuerpo ajeno","x', 'X').status, 'failed');
  assert.equal(parseFinalText('{"artifacts":[{"name":"reply","uri":"memory://x","z', 'X').status, 'failed');
});

test('la marca tolerante NO rescata un valor de reply que no es texto', () => {
  // With two characters of tolerance, `:{` and `:[` would jump to the first text inside.
  for (const valor of ['null', '123', 'true', '{"texto":"hola"}', '["a","b"]']) {
    const salida = parseFinalText(`{"reply":${valor},"messages":[{"to":"kant","bo`, 'X');
    assert.equal(salida.status, 'failed', `no debio rescatar ${valor} como texto`);
  }
});

test('un separador AUSENTE no se adivina', () => {
  assert.equal(parseFinalText('{"reply""Ya revise el bridge.","messages":[{"to":"ka', 'X').status, 'failed');
});

test('reparar el separador NUNCA toca el texto de una respuesta', () => {
  // argos writes about Cauce keys daily: if the patch peeked inside the strings, this reply would
  // be silently altered.
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

// --- Family 1: RAW control characters inside the string ------------------------------------------
// The most likely of all, and the one with NO truncation at all: the model writes its JSON by
// hand and inserts the real newline instead of `\n`. The `reply` is COMPLETE and still the whole
// turn was lost. Here only the reply is not rescued: the envelope is repaired and recovered WHOLE.

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

// Repairing the WHOLE envelope —instead of rescuing only the `reply`— is what saves delegations:
// an intact `messages` reaches its destination instead of being discarded by a stray newline.
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

// --- Family 2: the cut lands mid-escape ---------------------------------------------------------
// Exact signature of a transport cut in the middle of a multibyte character. The broken tail —one
// character— is discarded instead of the whole turn.

test('un escape \\u cortado por la mitad no se lleva puesto el reply', () => {
  const salida = parseFinalText('{"reply":"Ya revise el caf\\u00e', 'OpenClaw result');
  assert.equal(salida.reply, 'Ya revise el caf');
});

test('una barra invertida legitima al final NO se recorta de mas', () => {
  // `"ruta C:\\"` is a valid, closed reply: if the trim were blind it would eat the backslash.
  const salida = parseFinalText(`{"reply":"ruta C:\\\\","messages":[`, 'OpenClaw result');
  assert.equal(salida.reply, 'ruta C:\\');
});

// --- Family 3: the code fence that does not close ------------------------------------------------
// `CODE_FENCE` is anchored with `$`, so an unclosed fence did not match: the candidate kept the
// ``` in front, stopped starting with `{`, and the whole envelope was published as plain text. The
// agent's owner read the raw JSON dump via Telegram instead of the reply —exactly the bug the
// fence exists to prevent.

test('valla ```json sin cerrar con el objeto truncado adentro: entrega el reply, no el volcado', () => {
  const crudo = '```json\n{"reply":"Ya revise el bridge y esta sano.","messages":[{"to":"arg';
  const salida = parseFinalText(crudo, 'OpenClaw result');
  assert.equal(salida.reply, 'Ya revise el bridge y esta sano.');
});

test('texto del modelo ANTES de la valla, con el objeto truncado adentro', () => {
  const crudo = 'Listo, aca va:\n\n```json\n{"reply":"Ya revise el bridge y esta sano.","messages":[{"to":"arg';
  assert.equal(parseFinalText(crudo, 'OpenClaw result').reply, 'Ya revise el bridge y esta sano.');
});

// --- Family 4: prose AFTER the final `}` --------------------------------------------------------
// This case did not die, but it lost delegations SILENTLY: the envelope was whole and valid, and
// the rescue kept only the `reply`. Same damage `recoverEmbeddedEnvelope` documents (39 delegations
// destroyed in six days). Now the full envelope is recovered.

test('prosa despues del } final: el sobre se recupera ENTERO, con sus delegaciones', () => {
  const crudo = '{"reply":"Delegado.","messages":[{"to":"kant","body":"mira el gateway"}],"status":"done","retryable":false,"artifacts":[]}\n\nAviso: ya le escribi a kant.';
  const salida = parseFinalText(crudo, 'OpenClaw result');
  assert.equal(salida.reply, 'Delegado.');
  assert.equal(salida.messages.length, 1);
  assert.equal(salida.messages[0]?.to, 'kant');
});

test('dos sobres pegados NO se adivinan: se cae al reply del primero, sin delegar', () => {
  // Ambiguity. `recoverEmbeddedEnvelope` refuses to pick, and the step below delivers the reply
  // with empty `messages`: better lose the delegation than dispatch work at random.
  const crudo = `{"reply":"primero",${SOBRE}}{"reply":"segundo",${SOBRE}}`;
  const salida = parseFinalText(crudo, 'OpenClaw result');
  assert.equal(salida.reply, 'primero');
  assert.deepEqual(salida.messages, []);
});

// --- Family 5: the FLOOR. With nothing rescuable, the turn stays alive --------------------------
// Before this was `throw`, and a throw leaves `deliveries.result` NULL: the asker gets NOTHING
// —no reply, no notice, no reason—. That is the state of argos's 4 turns today and the 5 on
// 31-jul. Now it degrades to "failed" WITH TEXT, the same move `validateDeliveryOutput` already
// made twice (janus's MISSING_FINAL_REPLY and openclaw's tool dump). It does not become "done":
// the turn truly produced no legible reply and metrics must keep counting it as the failure it was.

test('un sobre con "reply": null y el resto cortado degrada a failed con texto, no a result NULL', () => {
  const salida = parseFinalText('{"reply":null,"messages":[{"to":"kant","bo', 'OpenClaw result');
  assert.equal(salida.status, 'failed');
  assert.equal(salida.retryable, false);
  assert.match(salida.reply ?? '', /no quedo ni una linea de texto rescatable/u);
  // The envelope sample travels bounded inside the technical block: without it the diagnosis is
  // back to guessing which character broke the JSON.
  assert.match(salida.reply ?? '', /Empieza asi: \{"reply":null/u);
});

test('un sobre SIN reply, cortado mas adelante, tampoco deja la entrega sin result', () => {
  const salida = parseFinalText('{"messages":[{"to":"kant","body":"revisa el bridge"}],"status":"done","retry', 'OpenClaw result');
  assert.equal(salida.status, 'failed');
  // Accessories of a broken envelope are discarded ON PURPOSE: a half `messages` could dispatch
  // work to the wrong recipient. The delegation does NOT materialise.
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

// --- What does NOT change ----------------------------------------------------------------------

test('un sobre sin andamiaje entrega el turno Y le ensena al agente', () => {
  // El temor que justificaba el fallo duro era «ablandarlo oculta agentes que nunca aprenden el
  // formato». Se atiende sin perder el turno: se normaliza la ausencia Y se inyecta el aviso en la
  const salida = parseFinalText('{"reply":"hola"}', 'X');
  assert.equal(salida.status, 'done');
  assert.deepEqual(salida.messages, []);
  assert.match(String(salida.reply), /^hola/u);
  assert.match(String(salida.reply), /faltaba/u);
  assert.match(String(salida.reply), /los siete campos/u);
});

test('el andamiaje mal formado se normaliza; lo que puede hacer dano sigue siendo fallo duro', () => {
  const conRetryableRoto = parseFinalText('{"reply":"hola","retryable":"si"}', 'X');
  assert.equal(conRetryableRoto.reply?.startsWith('hola'), true,
    'el reply ES el trabajo: 27 turnos de 8 alias se perdieron enteros por andamiaje mal escrito');
  assert.equal(conRetryableRoto.retryable, false);
  const conStatusRoto = parseFinalText('{"reply":"hola","status":"ok"}', 'X');
  assert.equal(conStatusRoto.status, 'done',
    'un status fuera del contrato no puede costar el turno, solo dejar constancia');
  assert.throws(() => parseFinalText('{"reply":"hola","messages":{}}', 'X'), /'messages' must be an array/u,
    'messages sigue muriendo a proposito: una lista a medias podria despachar trabajo a quien no toca');
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
