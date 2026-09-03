import assert from "node:assert/strict";
import test from "node:test";
import {
  FILE_ONLY_REPLY,
  FILE_ONLY_UNDELIVERED_REPLY,
  MAX_RELAY_ARTIFACTS_PER_MESSAGE,
  MAX_RELAY_ARTIFACTS_TOTAL,
  MAX_RELAY_ARTIFACT_TOTAL_BYTES,
  MAX_RELAY_ARTIFACT_URI_CHARACTERS,
  NO_REPLY_WRITTEN_REPLY,
  dataUriPayloadBytes,
  hasDeliverableArtifact,
  newRelayArtifactBudget,
  parseRelayArtifacts,
  reviseFileOnlyOutcome,
} from "../src/sdk/output-parser/relay-artifacts.js";
import {
  MAX_RELAY_AGGREGATE_BYTES,
  MAX_RELAY_BODY_BYTES,
  validateDeliveryOutput,
  validateStructuredOutput,
} from "../src/sdk/output-parser/contract.js";
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_RELAY_ARTIFACTS_TOTAL as PROTOCOL_RELAY_ARTIFACTS_TOTAL,
} from "@cauce/protocol";
import type { OutputArtifact, StructuredOutput } from "../src/sdk/types.js";

/**
 * El borde de delegación transporta ficheros con los MISMOS topes del protocolo que la salida al
 * origen. Lo que esta suite mide es el efecto: qué entra, qué se cae sin ruido, y —sobre todo—
 * que un adjunto de 10 MB viajando junto a un mensaje no mueve ni un byte la contabilidad del
 * texto, que es la que decide si el turno se pierde.
 */

const DIEZ_MB_BASE64 = `${"A".repeat(13_333_334)}==`;
const DIEZ_MB_DATA_URI = `data:application/pdf;base64,${DIEZ_MB_BASE64}`;

function pdf(name: string): Record<string, unknown> {
  return { name, uri: "data:application/pdf;base64,QUJD" };
}

test("un artifact bien formado sobrevive con sus cuatro campos y sin claves inventadas", () => {
  const artifacts = parseRelayArtifacts([{
    name: "informe.pdf",
    uri: "data:application/pdf;base64,QUJD",
    media_type: "application/pdf",
    sha256: "a".repeat(64),
    ruta_local: "/home/dev/informe.pdf",
  }], 0, newRelayArtifactBudget());

  assert.deepEqual(artifacts, [{
    name: "informe.pdf",
    uri: "data:application/pdf;base64,QUJD",
    media_type: "application/pdf",
    sha256: "a".repeat(64),
  }]);
});

test("media_type y sha256 ausentes quedan ausentes, no en undefined", () => {
  const artifacts = parseRelayArtifacts([pdf("a.pdf")], 0, newRelayArtifactBudget());
  assert.deepEqual(Object.keys(artifacts[0] ?? {}).sort(), ["name", "uri"]);
});

test("una entrada malformada se descarta, jamás tira: un adjunto no puede costar el turno", () => {
  const budget = newRelayArtifactBudget();
  const malas: unknown[] = [
    null,
    "informe.pdf",
    ["informe.pdf"],
    { uri: "data:application/pdf;base64,QUJD" },
    { name: "", uri: "data:application/pdf;base64,QUJD" },
    { name: "../../etc/passwd", uri: "data:application/pdf;base64,QUJD" },
    { name: "sub/dir.pdf", uri: "data:application/pdf;base64,QUJD" },
    { name: "informe.pdf" },
    { name: "informe.pdf", uri: "" },
    { name: "informe.pdf", uri: "   " },
    { name: "informe.pdf", uri: 42 },
    { name: "informe.pdf", uri: "data:x", media_type: "image/png; base64" },
    { name: "informe.pdf", uri: "data:x", media_type: 7 },
    { name: "informe.pdf", uri: "data:x", sha256: "no-es-un-digest" },
    { name: "informe.pdf", uri: "data:x", sha256: "A".repeat(64) },
  ];
  for (const mala of malas) {
    assert.deepEqual(parseRelayArtifacts([mala], 0, budget), [], JSON.stringify(mala));
  }
  assert.deepEqual(parseRelayArtifacts("no es una lista", 0, budget), []);
  assert.deepEqual(parseRelayArtifacts(undefined, 0, budget), []);
});

test("el descarte es silencioso para el turno, pero queda anotado por índice de mensaje", () => {
  const budget = newRelayArtifactBudget();
  parseRelayArtifacts([pdf("bueno.pdf")], 0, budget);
  parseRelayArtifacts([{ name: "malo" }], 3, budget);
  assert.deepEqual(budget.dropped, [3]);
});

test("un uri por encima del tope de caracteres se descarta sin decodificar nada", () => {
  const gigante = `data:application/pdf;base64,${"A".repeat(MAX_RELAY_ARTIFACT_URI_CHARACTERS)}`;
  assert.ok(gigante.length > MAX_RELAY_ARTIFACT_URI_CHARACTERS);
  const artifacts = parseRelayArtifacts(
    [{ name: "gigante.pdf", uri: gigante }],
    0,
    newRelayArtifactBudget(),
  );
  assert.deepEqual(artifacts, []);
  assert.equal(MAX_RELAY_ARTIFACT_URI_CHARACTERS > DIEZ_MB_DATA_URI.length, true,
    "el tope tiene que dejar pasar un adjunto de 10 MB ya en base64");
});

test("el tope por mensaje corta en el quinto, y el mensaje siguiente arranca con su propio cupo", () => {
  const budget = newRelayArtifactBudget();
  const seis = Array.from({ length: 6 }, (_, index) => pdf(`lote-${String(index)}.pdf`));
  const primero = parseRelayArtifacts(seis, 0, budget);
  assert.equal(primero.length, MAX_RELAY_ARTIFACTS_PER_MESSAGE);
  assert.equal(primero[0]?.name, "lote-0.pdf");
  const segundo = parseRelayArtifacts(seis, 1, budget);
  assert.equal(segundo.length, MAX_RELAY_ARTIFACTS_PER_MESSAGE);
  assert.equal(budget.count, MAX_RELAY_ARTIFACTS_TOTAL);
});

test("el tope total del turno corta aunque cada mensaje respete el suyo", () => {
  const budget = newRelayArtifactBudget();
  const cuatro = Array.from({ length: 4 }, (_, index) => pdf(`x-${String(index)}.pdf`));
  let entregados = 0;
  for (let index = 0; index < 5; index += 1) {
    entregados += parseRelayArtifacts(cuatro, index, budget).length;
  }
  assert.equal(entregados, MAX_RELAY_ARTIFACTS_TOTAL);
  assert.equal(budget.count, MAX_RELAY_ARTIFACTS_TOTAL);
});

test("el presupuesto de bytes se mide sobre el payload, no sobre los caracteres del uri", () => {
  assert.equal(dataUriPayloadBytes(DIEZ_MB_DATA_URI), 10_000_000);
  assert.equal(dataUriPayloadBytes("data:application/pdf;base64,QUJD"), 3);
  assert.equal(dataUriPayloadBytes("data:text/plain,hola"), 4);

  const budget = newRelayArtifactBudget();
  assert.equal(parseRelayArtifacts([{ name: "a.pdf", uri: DIEZ_MB_DATA_URI }], 0, budget).length, 1);
  assert.equal(budget.bytes, MAX_RELAY_ARTIFACT_TOTAL_BYTES);
  assert.deepEqual(parseRelayArtifacts([{ name: "b.pdf", uri: DIEZ_MB_DATA_URI }], 1, budget), [],
    "dos adjuntos de 10 MB no caben en el agregado del turno");
});

test("el tope total del turno es el del protocolo, no un número escrito a mano acá", () => {
  assert.equal(MAX_RELAY_ARTIFACTS_TOTAL, PROTOCOL_RELAY_ARTIFACTS_TOTAL);
  assert.equal(MAX_RELAY_ARTIFACTS_TOTAL, 2 * MAX_ATTACHMENTS_PER_MESSAGE,
    "si el protocolo sube el cupo por mensaje, el del turno sube con él");
});

test("«entregable» lo decide el protocolo: un esquema suelto no alcanza", () => {
  assert.equal(hasDeliverableArtifact([{ name: "a.pdf", uri: " data:application/pdf;base64,QUJD" }]), true);
  assert.equal(hasDeliverableArtifact([{ name: "a.pdf", uri: "https://cauce/informe.pdf" }]), true);
  // CONTROL NEGATIVO del review: los dos uri que compraban un "done" sin fichero ninguno.
  assert.equal(hasDeliverableArtifact([{ name: "a.pdf", uri: "data:x" }]), false);
  assert.equal(hasDeliverableArtifact([{ name: "a.pdf", uri: "https:not-a-url" }]), false);
  assert.equal(hasDeliverableArtifact([{ name: "a.pdf", uri: "data:application/pdf;base64," }]), false);
  assert.equal(hasDeliverableArtifact([{ name: "a.pdf", uri: "data:text/plain,hola" }]), false);
  assert.equal(hasDeliverableArtifact([{ name: "a.pdf", uri: "https://" }]), false);
  assert.equal(hasDeliverableArtifact([{ name: "a.pdf", uri: "file:///home/dev/informe.pdf" }]), false);
  assert.equal(hasDeliverableArtifact([{ name: "a.pdf", uri: "http://127.0.0.1/informe.pdf" }]), false);
  assert.equal(hasDeliverableArtifact([{ name: "a.pdf", uri: "cauce:not-sent" }]), false);
  assert.equal(hasDeliverableArtifact([{ name: "a.pdf", uri: "/home/dev/informe.pdf" }]), false);
  assert.equal(hasDeliverableArtifact([]), false);
  assert.equal(hasDeliverableArtifact(undefined), false);
  assert.equal(hasDeliverableArtifact([
    { name: "a.pdf", uri: "file:///x" },
    { name: "b.pdf", uri: "data:application/pdf;base64,QUJD" },
  ]), true);
});

test("un adjunto de 10 MB viajando en un mensaje no mueve la contabilidad de bytes del texto", () => {
  assert.equal(MAX_RELAY_BODY_BYTES, 64 * 1024);
  assert.equal(MAX_RELAY_AGGREGATE_BYTES, 256 * 1024);

  const body = "x".repeat(MAX_RELAY_BODY_BYTES);
  const cuatro = Array.from({ length: 4 }, () => ({ to: "socrates", body }));
  const conAdjunto = cuatro.map((message) => ({
    ...message,
    artifacts: [{ name: "informe.pdf", uri: DIEZ_MB_DATA_URI }],
  }));

  const sobre = {
    reply: "listo", notify: [], status: "done", retryable: false, artifacts: [],
  };
  const limpio = validateStructuredOutput({ ...sobre, messages: cuatro });
  const cargado = validateStructuredOutput({ ...sobre, messages: conAdjunto });
  assert.equal(limpio.messages.length, 4);
  assert.equal(cargado.messages.length, 4);
  assert.equal(cargado.messages[0]?.artifacts?.[0]?.uri.length, DIEZ_MB_DATA_URI.length);

  const quinto = [...cuatro, { to: "seneca", body }];
  assert.throws(() => validateStructuredOutput({ ...sobre, messages: quinto }), /aggregate UTF-8 byte limit/u);
  assert.throws(
    () => validateStructuredOutput({
      ...sobre,
      messages: quinto.map((message) => ({
        ...message,
        artifacts: [{ name: "informe.pdf", uri: DIEZ_MB_DATA_URI }],
      })),
    }),
    /aggregate UTF-8 byte limit/u,
    "el agregado tiene que cortar en el MISMO mensaje con adjuntos que sin ellos",
  );
});

const PDF_DATA_URI = "data:application/pdf;base64,JVBERi0xLjQK";

function soloFichero(uri: string, reply: string | null): Record<string, unknown> {
  return { reply, messages: [], notify: [], status: "done", retryable: false, artifacts: [{ name: "a.pdf", uri }] };
}

test("un turno solo-fichero se entrega en 'done' con un texto corto y honesto", () => {
  const salida = validateDeliveryOutput(validateStructuredOutput(soloFichero(PDF_DATA_URI, null)));
  assert.equal(salida.status, "done", "un fichero entregado ES el trabajo del turno");
  assert.equal(salida.retryable, false);
  assert.match(salida.reply ?? "", /^Te dejo el\/los fichero\(s\)/u);
  assert.equal(salida.artifacts.length, 1);
  assert.equal(salida.artifacts[0]?.uri, PDF_DATA_URI);
});

test("un reply invisible con fichero entregable ya no tira, y el fichero sobrevive", () => {
  const salida = validateDeliveryOutput(validateStructuredOutput(soloFichero(PDF_DATA_URI, "")));
  assert.equal(salida.status, "done");
  assert.match(salida.reply ?? "", /^Te dejo el\/los fichero\(s\)/u);
  assert.equal(salida.artifacts[0]?.uri, PDF_DATA_URI);

  const conHttps = validateDeliveryOutput(validateStructuredOutput(
    soloFichero("https://cauce/informe.pdf", "\u200b \u0000"),
  ));
  assert.equal(conHttps.status, "done");
  assert.equal(conHttps.artifacts[0]?.uri, "https://cauce/informe.pdf");
});

test("los artifacts de un mensaje delegado sobreviven, y la ausencia sigue siendo ausencia", () => {
  const salida = validateStructuredOutput({
    reply: "delego con el fichero",
    messages: [
      {
        to: "socrates",
        body: "segui vos con esto",
        artifacts: [{ name: "a.pdf", uri: PDF_DATA_URI, inventado: true }],
        inventado: "si",
      },
      { to: "seneca", body: "y vos con esto otro" },
    ],
    notify: [],
    status: "done",
    retryable: false,
    artifacts: [],
  });

  assert.deepEqual(salida.messages[0], {
    to: "socrates",
    body: "segui vos con esto",
    artifacts: [{ name: "a.pdf", uri: PDF_DATA_URI }],
  });
  assert.deepEqual(Object.keys(salida.messages[1] ?? {}), ["to", "body"],
    "un adaptador viejo que no manda artifacts tiene que producir el MISMO objeto de antes");
});

test("CONTROL NEGATIVO: los dos uri que cerraban 'done' sin fichero vuelven a ser 'failed'", () => {
  for (const uri of ["data:x", "https:not-a-url"]) {
    const salida = validateDeliveryOutput(validateStructuredOutput(soloFichero(uri, null)));
    assert.equal(salida.status, "failed", uri);
    assert.doesNotMatch(salida.reply ?? "", /Te dejo el\/los fichero/u, uri);
    assert.throws(
      () => validateDeliveryOutput(validateStructuredOutput(soloFichero(uri, ""))),
      /INVISIBLE_REPLY|visible text/u,
      uri,
    );
  }
});

test("un artifact que sí es entregable sigue salvando el turno mudo", () => {
  const salida = validateDeliveryOutput(validateStructuredOutput(soloFichero(PDF_DATA_URI, null)));
  assert.equal(salida.status, "done");
  assert.equal(salida.artifacts[0]?.uri, PDF_DATA_URI);
});

test("un data: sin base64 pesa en bytes UTF-8, no en unidades de codigo UTF-16", () => {
  assert.equal(dataUriPayloadBytes("data:text/plain,\u4e2d"), 3);

  const uri = `data:text/plain,${"\u4e2d".repeat(3_400_000)}`;
  assert.ok(uri.length <= MAX_RELAY_ARTIFACT_URI_CHARACTERS, "el tope de caracteres lo deja pasar");
  assert.ok(uri.length <= MAX_RELAY_ARTIFACT_TOTAL_BYTES, "y contado en caracteres cabria entero");
  assert.ok(Buffer.byteLength(uri, "utf8") > MAX_RELAY_ARTIFACT_TOTAL_BYTES,
    "pero lo que viaja son bytes, y en bytes se pasa del presupuesto agregado");

  const presupuesto = newRelayArtifactBudget();
  const artifacts = parseRelayArtifacts([{ name: "grande.txt", uri }], 0, presupuesto);
  assert.deepEqual(artifacts, [], "un adjunto no puede costar el turno poniendo 3x en el cable");
  assert.deepEqual(presupuesto.dropped, [0]);
  assert.equal(presupuesto.bytes, 0);
});

function sobreMudo(artifacts: readonly OutputArtifact[]): StructuredOutput {
  return {
    reply: NO_REPLY_WRITTEN_REPLY,
    messages: [],
    notify: [],
    status: "failed",
    retryable: false,
    artifacts,
  };
}

test("el texto del turno mudo es exactamente el que la revision sabe deshacer", () => {
  const fallado = validateDeliveryOutput(validateStructuredOutput(soloFichero("/tmp/informe.pdf", null)));
  assert.equal(fallado.status, "failed");
  assert.equal(fallado.reply, NO_REPLY_WRITTEN_REPLY);
});

test("la revision fichero-solo es bidireccional: ningun fichero viaja bajo un texto que lo niega", () => {
  const local = [{ name: "a.pdf", uri: "/tmp/informe.pdf" }];

  const sigueMudo = reviseFileOnlyOutcome(sobreMudo(local));
  assert.equal(sigueMudo.status, "failed", "sin fichero entregable el turno mudo sigue siendo fallo");
  assert.equal(sigueMudo.reply, NO_REPLY_WRITTEN_REPLY);

  const conFichero = reviseFileOnlyOutcome(sobreMudo([{ name: "a.pdf", uri: PDF_DATA_URI }]));
  assert.equal(conFichero.status, "done", "el inliner convirtio el fichero: el turno ya no es mudo");
  assert.equal(conFichero.retryable, false);
  assert.equal(conFichero.reply, FILE_ONLY_REPLY);

  const prometido = reviseFileOnlyOutcome({ ...sobreMudo(local), status: "done", reply: FILE_ONLY_REPLY });
  assert.equal(prometido.status, "failed", "y la direccion contraria sigue igual de cerrada");
  assert.equal(prometido.reply, FILE_ONLY_UNDELIVERED_REPLY);
});

test("un payload que solo DICE ser base64 pesa sus bytes UTF-8, no tres cuartos de sus caracteres", () => {
  assert.equal(dataUriPayloadBytes("data:application/pdf;base64,QUJD"), 3, "el base64 de verdad conserva su descuento");
  assert.equal(dataUriPayloadBytes("data:text/plain;base64,中中中中"), 12);
  assert.equal(dataUriPayloadBytes("data:text/plain;base64,!!!!"), 4, "ni siquiera en ASCII: base64 que no es base64 viaja como texto");

  const uri = `data:text/plain;base64,${"中".repeat(4_000_000)}`;
  assert.ok(uri.length <= MAX_RELAY_ARTIFACT_URI_CHARACTERS, "el tope de caracteres lo deja pasar");
  const presupuesto = newRelayArtifactBudget();
  const artifacts = parseRelayArtifacts([{ name: "grande.txt", uri }], 0, presupuesto);
  assert.deepEqual(artifacts, [], "12 MB reales no pueden entrar declarando 3");
  assert.deepEqual(presupuesto.dropped, [0]);
  assert.equal(presupuesto.bytes, 0);
});

test("«base64» cuenta en cualquier parametro, que es como lo lee el egreso", () => {
  assert.equal(dataUriPayloadBytes("data:text/plain;base64;charset=utf-8,QUJD"), 3);
  assert.equal(dataUriPayloadBytes("data:text/plain;charset=utf-8;base64,QUJD"), 3);
});

test("un fallo REINTENTABLE conserva su reintento aunque el inliner haya materializado el fichero", () => {
  const reintentable = reviseFileOnlyOutcome({
    ...sobreMudo([{ name: "a.pdf", uri: PDF_DATA_URI }]),
    retryable: true,
  });
  assert.equal(reintentable.status, "failed", "el turno mudo reintentable se reintenta, no se cierra en 'done'");
  assert.equal(reintentable.retryable, true);
  assert.equal(reintentable.reply, NO_REPLY_WRITTEN_REPLY);
});

test("la inflacion de cabecera y los blancos se cobran verbatim: el presupuesto pesa el FRAME", () => {
  const conEspacios = `data:text/plain;base64,A${" ".repeat(13_000_000)}AAA`;
  const cabecerota = `data:text/plain;${"x".repeat(13_000_000)};base64,AAAA`;
  const delante = `${" ".repeat(20_000_000)}data:text/plain;base64,QUJD`;

  for (const uri of [conEspacios, cabecerota, delante]) {
    assert.equal(dataUriPayloadBytes(uri), Buffer.byteLength(uri, "utf8"),
      "lo que no es payload ni cabecera honesta se cobra entero");
    const presupuesto = newRelayArtifactBudget();
    assert.deepEqual(parseRelayArtifacts([{ name: "a.txt", uri }], 0, presupuesto), [],
      "un adjunto de 3 bytes declarados no puede poner 13 MB en el cable");
    assert.equal(presupuesto.bytes, 0);
    assert.deepEqual(presupuesto.dropped, [0]);
  }

  assert.equal(dataUriPayloadBytes(DIEZ_MB_DATA_URI), 10_000_000);
  assert.equal(dataUriPayloadBytes(` ${DIEZ_MB_DATA_URI}\n`), 10_000_000,
    "un blanco suelto alrededor no tira el adjunto honesto de 10 MB");
});

test("los artifacts del nivel superior pagan el tope de uri y el presupuesto del turno", () => {
  const inflado = `data:text/plain;base64,A${" ".repeat(13_000_000)}AAA`;
  const salida = validateStructuredOutput({
    reply: "toma",
    messages: [],
    notify: [],
    status: "done",
    retryable: false,
    artifacts: [{ name: "a.txt", uri: inflado }, { name: "b.txt", uri: inflado }],
  });

  assert.equal(salida.artifacts[0]?.uri, inflado, "uno solo todavia cabe en lo que el cable aguanta");
  assert.deepEqual(salida.artifacts[1], { name: "b.txt", uri: "cauce:not-sent" },
    "el segundo pierde el contenido y conserva la identidad, que es lo que el humano lee");

  const gigante = `${" ".repeat(20_000_000)}data:text/plain;base64,QUJD`;
  const conGigante = validateStructuredOutput({
    reply: "toma",
    messages: [],
    notify: [],
    status: "done",
    retryable: false,
    artifacts: [{ name: "g.txt", uri: gigante }],
  });
  assert.deepEqual(conGigante.artifacts, [{ name: "g.txt", uri: "cauce:not-sent" }],
    "por encima del tope de caracteres el uri no viaja ni una vez");
});

test("el presupuesto de bytes es UNO por turno: el nivel superior y los delegados lo comparten", () => {
  const salida = validateStructuredOutput({
    reply: "toma",
    messages: [{ to: "socrates", body: "segui", artifacts: [{ name: "a.pdf", uri: DIEZ_MB_DATA_URI }] }],
    notify: [],
    status: "done",
    retryable: false,
    artifacts: [{ name: "b.pdf", uri: DIEZ_MB_DATA_URI }],
  });

  assert.equal(salida.messages[0]?.artifacts?.length, 1);
  assert.deepEqual(salida.artifacts, [{ name: "b.pdf", uri: "cauce:not-sent" }],
    "dos adjuntos de 10 MB no caben en el agregado del turno");
});

test("un sha256 que no es 64 hex se cae como campo, y el fichero sigue viajando", () => {
  const salida = validateStructuredOutput({
    reply: "toma",
    messages: [],
    notify: [],
    status: "done",
    retryable: false,
    artifacts: [{ name: "a.pdf", uri: PDF_DATA_URI, sha256: "valor-secretisimo-que-nunca-viaja" }],
  });

  assert.deepEqual(salida.artifacts, [{ name: "a.pdf", uri: PDF_DATA_URI }],
    "sha256 no es un canal de texto libre al nivel superior, igual que no lo es en un delegado");
  assert.equal(JSON.stringify(salida).includes("secretisimo"), false);

  const firmado = validateStructuredOutput({
    reply: "toma",
    messages: [],
    notify: [],
    status: "done",
    retryable: false,
    artifacts: [{ name: "a.pdf", uri: PDF_DATA_URI, sha256: "a".repeat(64) }],
  });
  assert.equal(firmado.artifacts[0]?.sha256, "a".repeat(64));
});
