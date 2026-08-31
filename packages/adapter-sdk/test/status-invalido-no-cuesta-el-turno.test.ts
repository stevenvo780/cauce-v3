import assert from "node:assert/strict";
import test from "node:test";
import { validateStructuredOutput } from "../src/sdk/output-parser.js";

test("un 'status' fuera del contrato no destruye el trabajo del turno", () => {
  const salida = validateStructuredOutput({
    reply: "publique pos-estado.vercel.app y restaure catalogo.humanizar.tech",
    messages: [
      { to: "heraclito", body: "tu fichero llego intacto y ya esta publicado" },
      { to: "argos", body: "tumbe catalogo.humanizar.tech unos minutos y lo restaure" },
    ],
    notify: "steven_dm",
    status: "ok",
    retryable: false,
  });
  assert.equal(salida.status, "done",
    "el status es andamiaje: 27 turnos de 8 alias se perdieron enteros por una palabra mal puesta");
  assert.equal(salida.messages.length, 2,
    "las delegaciones son el trabajo; antes se materializaban cero filas y nadie las recibia");
  assert.match(salida.reply ?? "", /'status' llego como "ok"/u,
    "el aviso va en el reply del propio agente: si no lo lee, repite el mismo error cada turno");
  assert.match(salida.reply ?? "", /no era una lista/u,
    "el aviso del status no puede tapar el del notify mal formado");
});

test("los valores invalidos que significan exito cierran en done", () => {
  for (const valor of ["ok", "partial", "success", "completed", null, true, 0]) {
    const salida = validateStructuredOutput({ reply: "trabajo hecho", status: valor });
    assert.equal(salida.status, "done",
      `'status' ${JSON.stringify(valor)} con reply util tiene que cerrar en done`);
  }
});

test("un valor invalido que declara fallo no se blanquea a done", () => {
  for (const valor of ["error", "failure", "timeout", "cancelled"]) {
    const salida = validateStructuredOutput({ reply: "no pude terminar", status: valor });
    assert.equal(salida.status, "failed",
      `rescatar el reply no puede convertir un "${valor}" declarado en un exito`);
  }
});

test("sin reply util no hay trabajo que rescatar y cae en failed", () => {
  assert.equal(validateStructuredOutput({ reply: "   ", status: "ok" }).status, "failed",
    "normalizar a done un turno vacio seria inventar un exito que nadie produjo");
});

test("un 'retryable' no booleano tampoco cuesta el turno", () => {
  const salida = validateStructuredOutput({ reply: "listo", status: "done", retryable: "no" });
  assert.equal(salida.retryable, false);
  assert.match(salida.reply ?? "", /'retryable' no era booleano/u,
    "mismo defecto gemelo una linea mas abajo: presencia mal formada mataba el turno igual");
});

test("un status del contrato pasa intacto y sin ruido", () => {
  for (const valor of ["done", "failed"] as const) {
    const salida = validateStructuredOutput({
      reply: "listo", status: valor, messages: [], retryable: valor === "failed",
    });
    assert.equal(salida.status, valor);
    assert.ok(!(salida.reply ?? "").includes("[Cauce]"),
      `"${valor}" es valido: anotar algo seria ruido en la respuesta que lee el destinatario`);
  }
});

test("el contrato NO se ablanda: sin 'reply' sigue costando el turno", () => {
  assert.throws(
    () => validateStructuredOutput({ status: "done", messages: [] }),
    /reply/u,
    "control negativo: 'reply' ES el trabajo y su ausencia tiene que seguir siendo error duro");
});
