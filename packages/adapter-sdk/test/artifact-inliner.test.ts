import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";
import {
  MAX_INLINED_ARTIFACTS_PER_RESPONSE,
  MAX_INLINED_ARTIFACT_BYTES,
  inlineLocalArtifacts,
  localArtifactPath,
} from "../src/sdk/artifact-inliner.js";
import { FILE_ONLY_REPLY } from "../src/sdk/output-parser/relay-artifacts.js";
import {
  validateDeliveryOutput,
  validateStructuredOutput,
} from "../src/sdk/output-parser/contract.js";
import { fakeDefinition } from "../src/harnesses/index.js";
import { HarnessAdapter } from "../src/harnesses/shared.js";
import { DurableStore } from "../src/sdk/durable-store.js";
import { AdapterEngine } from "../src/sdk/engine.js";
import type {
  CommandRunRequest,
  CommandRunResult,
  CommandRunner,
  Delivery,
  DeliveryEvent,
  OutputArtifact,
  StructuredOutput,
} from "../src/sdk/types.js";
import { testStateRoot } from "./test-state.js";

/**
 * Attachment egress, measured by its EFFECT: which `uri` actually leaves toward the bus.
 *
 * The case that originated this suite is literal production (2026-08-22): 12 outgoing artifacts in
 * 7 days, ZERO as `data:`, all 12 with `status = sent`. Miguel, the client, non-technical:
 * "it sends me an attached datum but I cannot see it".
 */

/** Real 1x1 PNG, the same one the bridge signature sniffer recognises. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");

let scratch: string | undefined;

async function workspace(): Promise<string> {
  scratch ??= await mkdtemp(join(tmpdir(), "cauce-artifact-"));
  return scratch;
}

async function fileWith(name: string, bytes: Buffer): Promise<string> {
  const directory = await workspace();
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
}

function envelope(artifacts: readonly OutputArtifact[]): StructuredOutput {
  return {
    reply: "listo, te dejo la hoja de ruta",
    messages: [],
    notify: [],
    status: "done",
    retryable: false,
    artifacts,
  };
}

function firstUri(output: StructuredOutput): string {
  const artifact = output.artifacts[0];
  assert.ok(artifact, "el sobre salió sin artifacts");
  return artifact.uri;
}

function decodeDataUri(uri: string): Buffer {
  const comma = uri.indexOf(",");
  assert.notEqual(comma, -1, `no es un data: URI: ${uri.slice(0, 40)}`);
  return Buffer.from(uri.slice(comma + 1), "base64");
}

after(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

/* --------------------------------------------------------------------------- *
 * What Miguel asked for
 * --------------------------------------------------------------------------- */

test("un PNG en file:// sale como data: y los bytes decodificados son idénticos al original", async () => {
  const path = await fileWith("pantallazo.png", PNG_BYTES);
  const uri = pathToFileURL(path).href;
  assert.match(uri, /^file:\/\//u);

  const output = await inlineLocalArtifacts(envelope([{ name: "pantallazo.png", uri }]));

  const salida = firstUri(output);
  assert.match(salida, /^data:image\/png;base64,/u);
  // The effect, not the function name: the bytes that travel are THE file.
  assert.deepEqual(decodeDataUri(salida), PNG_BYTES);
  assert.equal(output.artifacts[0]?.media_type, "image/png");
  assert.equal(output.artifacts[0].sha256, createHash("sha256").update(PNG_BYTES).digest("hex"));
  // The rest of the response is left untouched.
  assert.equal(output.reply, "listo, te dejo la hoja de ruta");
  assert.equal(output.status, "done");
});

test("la ruta absoluta suelta de Miguel, sin file://, también se convierte", async () => {
  // Real outbox case: `/home/claw/clawd/_tmp_hoja_ruta/hoja_ruta_domiciliario.png | image/png`.
  const directory = join(await workspace(), "_tmp_hoja_ruta");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "hoja_ruta_domiciliario.png");
  await writeFile(path, PNG_BYTES);

  const output = await inlineLocalArtifacts(envelope([
    { name: "hoja_ruta_domiciliario.png", uri: path, media_type: "image/png" },
  ]));

  assert.match(firstUri(output), /^data:image\/png;base64,/u);
  assert.deepEqual(decodeDataUri(firstUri(output)), PNG_BYTES);
  assert.equal(output.artifacts[0]?.name, "hoja_ruta_domiciliario.png");
});

test("un documento sin media_type declarado deduce el tipo de la extensión", async () => {
  const markdown = Buffer.from("# informe\n\ntodo listo\n", "utf8");
  const path = await fileWith("informe.md", markdown);
  const output = await inlineLocalArtifacts(envelope([{ name: "informe.md", uri: path }]));
  assert.match(firstUri(output), /^data:text\/markdown;base64,/u);
  assert.deepEqual(decodeDataUri(firstUri(output)), markdown);
});

test("una extensión desconocida cae en application/octet-stream, y el media_type declarado manda", async () => {
  const bytes = Buffer.from("datos", "utf8");
  const raro = await fileWith("cosa.zzz", bytes);
  const anonimo = await inlineLocalArtifacts(envelope([{ name: "cosa.zzz", uri: raro }]));
  assert.match(firstUri(anonimo), /^data:application\/octet-stream;base64,/u);

  const declarado = await inlineLocalArtifacts(envelope([
    { name: "cosa.zzz", uri: raro, media_type: "application/pdf" },
  ]));
  assert.match(firstUri(declarado), /^data:application\/pdf;base64,/u);

  // A media_type that would break the data: URI header is discarded and inferred instead.
  const sucio = await inlineLocalArtifacts(envelope([
    { name: "cosa.zzz", uri: raro, media_type: "image/png;base64,AAAA" },
  ]));
  assert.match(firstUri(sucio), /^data:application\/octet-stream;base64,/u);
});

/* --------------------------------------------------------------------------- *
 * The caps
 * --------------------------------------------------------------------------- */

test("un fichero de 11 MB no se convierte y la respuesta sale igual, con el artifact intacto", async () => {
  const grande = Buffer.alloc(11_000_000, 0x41);
  assert.ok(grande.length > MAX_INLINED_ARTIFACT_BYTES);
  const path = await fileWith("enorme.bin", grande);
  const entrada = envelope([{ name: "enorme.bin", uri: path }]);

  const output = await inlineLocalArtifacts(entrada);

  assert.equal(firstUri(output), path);
  assert.deepEqual(output.artifacts, entrada.artifacts);
  assert.equal(output.reply, "listo, te dejo la hoja de ruta");
  assert.equal(output.status, "done");
});

test("el fichero de 10.000.000 bytes exactos SÍ entra: el tope no se corre por el crecimiento del base64", async () => {
  const justo = Buffer.alloc(MAX_INLINED_ARTIFACT_BYTES, 0x42);
  const path = await fileWith("justo.bin", justo);
  const output = await inlineLocalArtifacts(envelope([{ name: "justo.bin", uri: path }]));
  assert.match(firstUri(output), /^data:application\/octet-stream;base64,/u);
  assert.equal(decodeDataUri(firstUri(output)).length, MAX_INLINED_ARTIFACT_BYTES);
});

test("el techo agregado por respuesta corta en el segundo adjunto, que se degrada a cauce:not-sent", async () => {
  const seis = Buffer.alloc(6_000_000, 0x43);
  const primero = await fileWith("mitad-1.bin", seis);
  const segundo = await fileWith("mitad-2.bin", seis);
  const entrada = envelope([
    { name: "mitad-1.bin", uri: primero },
    { name: "mitad-2.bin", uri: segundo },
  ]);

  const output = await inlineLocalArtifacts(entrada);

  assert.match(firstUri(output), /^data:application\/octet-stream;base64,/u);
  // 6 MB + 6 MB pass the per-attachment cap but not the aggregate cap (10 MB, same as ingestion).
  assert.deepEqual(output.artifacts[1], { name: "mitad-2.bin", uri: "cauce:not-sent" });
});

test("cuatro data: de 10 MB ya hechos: entra el que cabe y los otros salen como cauce:not-sent", async () => {
  const diezMb = `data:application/pdf;base64,${"A".repeat(13_333_334)}==`;
  const entrada = envelope(Array.from({ length: 4 }, (_, index) => ({
    name: `tomo-${String(index)}.pdf`,
    uri: diezMb,
    media_type: "application/pdf",
    sha256: "b".repeat(64),
  })));

  const output = await inlineLocalArtifacts(entrada);

  assert.equal(output.artifacts[0]?.uri, diezMb);
  for (const index of [1, 2, 3]) {
    assert.deepEqual(output.artifacts[index], {
      name: `tomo-${String(index)}.pdf`,
      media_type: "application/pdf",
      sha256: "b".repeat(64),
      uri: "cauce:not-sent",
    }, `el adjunto ${String(index)} no cabía y no puede viajar como si cupiera`);
  }
});

test("una ruta local dentro de messages[].artifacts se inlinea igual que la del origen", async () => {
  const path = await fileWith("delegado.png", PNG_BYTES);
  const entrada: StructuredOutput = {
    ...envelope([]),
    messages: [{ to: "socrates", body: "seguí vos", artifacts: [{ name: "delegado.png", uri: path }] }],
  };

  const output = await inlineLocalArtifacts(entrada);

  const enviado = output.messages[0]?.artifacts?.[0];
  assert.ok(enviado, "la delegación salió sin artifacts");
  assert.match(enviado.uri, /^data:image\/png;base64,/u);
  assert.deepEqual(decodeDataUri(enviado.uri), PNG_BYTES);
  assert.equal(enviado.sha256, createHash("sha256").update(PNG_BYTES).digest("hex"));
  assert.equal(output.messages[0]?.body, "seguí vos");
});

test("el presupuesto agregado es UNO para el origen y la delegación juntos", async () => {
  const seis = Buffer.alloc(6_000_000, 0x44);
  const origen = await fileWith("origen-6.bin", seis);
  const delegado = await fileWith("delegado-6.bin", seis);
  const entrada: StructuredOutput = {
    ...envelope([{ name: "origen-6.bin", uri: origen }]),
    messages: [{ to: "socrates", body: "el resto", artifacts: [{ name: "delegado-6.bin", uri: delegado }] }],
  };

  const output = await inlineLocalArtifacts(entrada);

  assert.match(firstUri(output), /^data:application\/octet-stream;base64,/u);
  assert.deepEqual(output.messages[0]?.artifacts, [{ name: "delegado-6.bin", uri: "cauce:not-sent" }]);
});

test("un enlace simbólico dentro de messages[].artifacts tampoco se lee", async () => {
  const enlace = join(await workspace(), "delegado-inocente.txt");
  await rm(enlace, { force: true });
  await symlink("/etc/passwd", enlace);
  const entrada: StructuredOutput = {
    ...envelope([]),
    messages: [{
      to: "socrates",
      body: "mirá esto",
      artifacts: [
        { name: "delegado-inocente.txt", uri: enlace },
        { name: "entorno", uri: "/proc/self/environ" },
        { name: "escape", uri: `${await workspace()}/../../etc/passwd` },
        { name: "relativa", uri: "informe.md" },
      ],
    }],
  };

  const output = await inlineLocalArtifacts(entrada);

  assert.equal(output, entrada, "nada era convertible: el sobre sale idéntico");
  for (const artifact of output.messages[0]?.artifacts ?? []) {
    assert.equal(artifact.uri.startsWith("data:"), false, `se leyó ${artifact.name}`);
  }
});

test("veinte artifacts: se convierten los primeros N y el resto queda como estaba, sin excepción", async () => {
  const paths: string[] = [];
  for (let index = 0; index < 20; index += 1) {
    paths.push(await fileWith(`lote-${String(index)}.png`, PNG_BYTES));
  }
  const entrada = envelope(paths.map((path, index) => ({ name: `lote-${String(index)}.png`, uri: path })));

  const output = await inlineLocalArtifacts(entrada);

  assert.equal(output.artifacts.length, 20);
  const convertidos = output.artifacts.filter((artifact) => artifact.uri.startsWith("data:"));
  assert.equal(convertidos.length, MAX_INLINED_ARTIFACTS_PER_RESPONSE);
  for (const [index, artifact] of output.artifacts.entries()) {
    if (index < MAX_INLINED_ARTIFACTS_PER_RESPONSE) {
      assert.match(artifact.uri, /^data:image\/png;base64,/u);
      continue;
    }
    // The rest is left EXACTLY as it was: the bridge explains it in the message footer.
    assert.deepEqual(artifact, entrada.artifacts[index]);
  }
});

test("un data: que ya venía hecho no se toca, y gasta cupo igual que una subida del puente", async () => {
  const yaHecho = `data:image/png;base64,${PNG_BASE64}`;
  const path = await fileWith("extra.png", PNG_BYTES);
  const entrada = envelope([
    { name: "a.png", uri: yaHecho },
    { name: "b.png", uri: yaHecho },
    { name: "c.png", uri: yaHecho },
    { name: "d.png", uri: yaHecho },
    { name: "extra.png", uri: path },
  ]);

  const output = await inlineLocalArtifacts(entrada);

  assert.deepEqual(output.artifacts.slice(0, 4), entrada.artifacts.slice(0, 4));
  // The fifth is not converted: the bridge only uploads 4 per response and converting it would be
  // wasted work that also bloats the ACK.
  assert.equal(output.artifacts[4]?.uri, path);
});

/* --------------------------------------------------------------------------- *
 * What is NOT touched and what is NOT read
 * --------------------------------------------------------------------------- */

test("un https:// no se toca: descargarlo es problema del puente, y el puente no lo hace a propósito", async () => {
  const entrada = envelope([
    { name: "deploy", uri: "https://cauce-v3.vercel.app/reporte.pdf" },
    { name: "rama", uri: "http://127.0.0.1:5000/v2/_catalog" },
  ]);
  const output = await inlineLocalArtifacts(entrada);
  assert.equal(output, entrada);
  assert.deepEqual(output.artifacts, entrada.artifacts);
});

test("un fichero que no existe no tira, no rompe el turno y deja el artifact como estaba", async () => {
  const path = join(await workspace(), "no-existe-jamas.png");
  const entrada = envelope([{ name: "fantasma.png", uri: pathToFileURL(path).href }]);
  const output = await inlineLocalArtifacts(entrada);
  assert.equal(firstUri(output), entrada.artifacts[0]?.uri);
  assert.equal(output.status, "done");
  assert.equal(output.reply, "listo, te dejo la hoja de ruta");
});

test("un enlace simbólico a /etc/passwd no se convierte", async () => {
  const enlace = join(await workspace(), "inocente.txt");
  await rm(enlace, { force: true });
  await symlink("/etc/passwd", enlace);
  const entrada = envelope([{ name: "inocente.txt", uri: enlace }]);

  const output = await inlineLocalArtifacts(entrada);

  assert.equal(firstUri(output), enlace);
  assert.equal(output.artifacts[0]?.uri.startsWith("data:"), false);
});

test("ni /proc, ni /sys, ni /dev, ni un directorio, ni una ruta relativa, ni un `..` que se escapa", async () => {
  const directory = await workspace();
  const entrada = envelope([
    { name: "entorno", uri: "/proc/self/environ" },
    { name: "kernel", uri: "/sys/kernel/notes" },
    { name: "azar", uri: "/dev/urandom" },
    { name: "carpeta", uri: directory },
    { name: "relativa", uri: "informe.md" },
    { name: "escape", uri: `${directory}/../../etc/passwd` },
    { name: "escape-url", uri: `${pathToFileURL(directory).href}/%2e%2e/%2e%2e/etc/passwd` },
    { name: "remoto", uri: "file://otra-maquina/etc/passwd" },
  ]);

  const output = await inlineLocalArtifacts(entrada);

  assert.equal(output, entrada);
  for (const artifact of output.artifacts) {
    assert.equal(artifact.uri.startsWith("data:"), false, `se leyó ${artifact.name}`);
  }
  assert.equal(localArtifactPath("/proc/self/environ"), undefined);
  assert.equal(localArtifactPath("informe.md"), undefined);
  assert.equal(localArtifactPath("file://otra-maquina/etc/passwd"), undefined);
  assert.equal(localArtifactPath("git:reporte.md"), undefined);
  assert.equal(localArtifactPath(""), undefined);
});

test("un FIFO no se convierte y, sobre todo, no deja el turno colgado", async () => {
  const fifo = join(await workspace(), "tuberia");
  try {
    execFileSync("mkfifo", [fifo]);
  } catch {
    return; // Without mkfifo in this environment there is nothing to test.
  }
  const entrada = envelope([{ name: "tuberia", uri: fifo }]);
  const output = await Promise.race([
    inlineLocalArtifacts(entrada),
    new Promise<StructuredOutput>((_, reject) => {
      setTimeout(() => { reject(new Error("inlineLocalArtifacts se colgó sobre un FIFO")); }, 5_000).unref();
    }),
  ]);
  assert.equal(firstUri(output), fifo);
});

test("un fichero vacío no se convierte: un data: vacío el puente lo rechaza igual", async () => {
  const path = await fileWith("vacio.png", Buffer.alloc(0));
  const entrada = envelope([{ name: "vacio.png", uri: path }]);
  const output = await inlineLocalArtifacts(entrada);
  assert.equal(firstUri(output), path);
});

/* --------------------------------------------------------------------------- *
 * sha256
 * --------------------------------------------------------------------------- */

test("un sha256 declarado que NO coincide con los bytes leídos no se manda convertido", async () => {
  const path = await fileWith("firmado.png", PNG_BYTES);
  const mentira = "0".repeat(64);
  const entrada = envelope([{ name: "firmado.png", uri: path, sha256: mentira }]);

  const output = await inlineLocalArtifacts(entrada);

  assert.equal(firstUri(output), path);
  assert.equal(output.artifacts[0]?.sha256, mentira);
});

test("un sha256 declarado que SÍ coincide se convierte, y uno ausente se calcula", async () => {
  const digest = createHash("sha256").update(PNG_BYTES).digest("hex");
  const path = await fileWith("firmado-bien.png", PNG_BYTES);

  const conFirma = await inlineLocalArtifacts(envelope([
    { name: "firmado-bien.png", uri: path, sha256: digest.toUpperCase() },
  ]));
  assert.match(firstUri(conFirma), /^data:image\/png;base64,/u);
  assert.equal(conFirma.artifacts[0]?.sha256, digest);

  const sinFirma = await inlineLocalArtifacts(envelope([{ name: "firmado-bien.png", uri: path }]));
  assert.equal(sinFirma.artifacts[0]?.sha256, digest);
});

/* --------------------------------------------------------------------------- *
 * NEGATIVE CONTROL: the same PNG, both branches, measured in the ACK
 * --------------------------------------------------------------------------- */

class StdoutRunner implements CommandRunner {
  constructor(readonly stdout: string) {}

  async run(_request: CommandRunRequest): Promise<CommandRunResult> {
    return { stdout: this.stdout, stderr: "", exitCode: 0, signal: null, timedOut: false, cancelled: false };
  }
}

function delivery(id: string): Delivery {
  return {
    type: "delivery",
    version: "3.0",
    delivery_id: id,
    event_id: `30000000-0000-4000-8000-${id.padEnd(12, "0").slice(0, 12)}`,
    message_id: `00000000-0000-4000-8000-${id.padEnd(12, "0").slice(0, 12)}`,
    request_id: `10000000-0000-4000-8000-${id.padEnd(12, "0").slice(0, 12)}`,
    trace_id: `trace-${id}`,
    epoch: 1,
    attempt: 1,
    claim_token: "20000000-0000-4000-8000-000000000001",
    ack_deadline_at: new Date(Date.now() + 30_000).toISOString(),
    tenant_id: "Miguel",
    room_id: "grp.miguel",
    actor_alias: "miguel",
    recipient_alias: "janus",
    origin: {
      adapter: "telegram",
      channel: "telegram",
      conversation_id: "room-miguel",
      external_message_id: "message-1",
      relay: [],
      metadata: {},
    },
    authenticated_context: {
      session_id: "session-miguel",
      channel: "telegram",
      origin: {
        adapter: "telegram",
        channel: "telegram",
        conversation_id: "room-miguel",
        external_message_id: "message-1",
        relay: [],
        metadata: {},
      },
    },
    body: { prompt: "mandame la hoja de ruta", timeout_ms: 5_000, session_key: "hilo-miguel" },
  };
}

/**
 * Two branches over the SAME envelope and the SAME PNG:
 *   - old: what the parser leaves, which is literally what the engine published before this
 *     change (`emit("done", …, { output })` with that same object). `file://` reaches the ACK.
 *   - new: the envelope going through the whole engine. `data:image/png;base64,…` reaches it.
 */
test("CONTROL NEGATIVO: el PNG de Miguel llegaba al ACK como file:// y ahora llega como data:", async () => {
  const path = await fileWith("hoja-ruta-ack.png", PNG_BYTES);
  const uri = pathToFileURL(path).href;
  const stdout = JSON.stringify({
    reply: "acá va la hoja de ruta",
    messages: [],
    status: "done",
    retryable: false,
    artifacts: [{ name: "hoja_ruta_domiciliario.png", uri, media_type: "image/png" }],
  });

  // OLD BRANCH.
  const antes = fakeDefinition.parse(stdout).output;
  const antesUri = antes.artifacts[0]?.uri;
  assert.ok(antesUri, "no hay uri antes");
  assert.equal(antesUri, uri);
  assert.match(antesUri, /^file:\/\//u);
  assert.equal(antesUri.startsWith("data:"), false);

  // NEW BRANCH.
  const state = testStateRoot("artifact-inliner-ack");
  await rm(state, { recursive: true, force: true });
  const store = await DurableStore.open(state);
  const events: DeliveryEvent[] = [];
  const engine = new AdapterEngine({
    store,
    executionIntentMode: "local-test-only",
    harness: new HarnessAdapter({ definition: fakeDefinition, runner: new StdoutRunner(stdout), store }),
    publish: async (event) => {
      events.push(event);
    },
  });
  await engine.activateEpoch(1);
  await engine.handleDelivery(delivery("miguel-1"));

  const done = events.find((event) => event.phase === "done");
  assert.ok(done, "la entrega no llegó a 'done'");
  const enviado = done.output?.artifacts[0];
  assert.ok(enviado, "el ACK salió sin artifacts");
  assert.match(enviado.uri, /^data:image\/png;base64,/u);
  assert.deepEqual(decodeDataUri(enviado.uri), PNG_BYTES);
  assert.equal(enviado.name, "hoja_ruta_domiciliario.png");
  assert.equal(enviado.media_type, "image/png");
  // And the work —the reply— goes out just the same.
  assert.equal(done.output.reply, "acá va la hoja de ruta");
  assert.equal(store.getDelivery("miguel-1")?.state, "done");
});

test("un adjunto ilegible no le cuesta el turno a nadie: el ACK sale igual, con el artifact crudo", async () => {
  const inexistente = join(await workspace(), "nunca-existio.png");
  const stdout = JSON.stringify({
    reply: "no pude generar el pantallazo, pero acá va el informe",
    messages: [],
    status: "done",
    retryable: false,
    artifacts: [{ name: "pantallazo.png", uri: pathToFileURL(inexistente).href }],
  });
  const state = testStateRoot("artifact-inliner-ack-roto");
  await rm(state, { recursive: true, force: true });
  const store = await DurableStore.open(state);
  const events: DeliveryEvent[] = [];
  const engine = new AdapterEngine({
    store,
    executionIntentMode: "local-test-only",
    harness: new HarnessAdapter({ definition: fakeDefinition, runner: new StdoutRunner(stdout), store }),
    publish: async (event) => {
      events.push(event);
    },
  });
  await engine.activateEpoch(1);
  await engine.handleDelivery(delivery("miguel-2"));

  const done = events.find((event) => event.phase === "done");
  assert.ok(done, "un adjunto ilegible se llevó puesto el turno");
  assert.equal(done.output?.reply, "no pude generar el pantallazo, pero acá va el informe");
  assert.equal(done.output.artifacts[0]?.uri.startsWith("file://"), true);
  assert.equal(store.getDelivery("miguel-2")?.state, "done");
});

test("un data: de 20 MB no cierra el turno anunciando un fichero que nunca viaja", async () => {
  const veinteMB = `data:application/pdf;base64,${"A".repeat(26_666_664)}`;
  const parsed = validateStructuredOutput({
    reply: null,
    messages: [],
    notify: [],
    status: "done",
    retryable: false,
    artifacts: [{ name: "a.pdf", uri: veinteMB }],
  });
  const validado = validateDeliveryOutput(parsed);
  const salida = await inlineLocalArtifacts(validado);

  assert.equal(firstUri(salida), "cauce:not-sent", "el adjunto no entra en el presupuesto del turno");
  assert.doesNotMatch(salida.reply ?? "", /Te dejo el\/los fichero/u,
    "un turno sin fichero no puede cerrar diciendo que deja un fichero");
  assert.equal(salida.status, "failed");
  assert.equal(salida.retryable, false);
});

test("si el único fichero entregable se cae por presupuesto, el turno deja de ser un 'done' mudo", async () => {
  const relleno = { name: "relleno.txt", uri: `data:text/plain,${"x".repeat(9_999_999)}` };
  const entregable = { name: "a.pdf", uri: `data:application/pdf;base64,${"QUJD".repeat(1_000)}` };
  const validado = validateDeliveryOutput(validateStructuredOutput({
    reply: null,
    messages: [],
    notify: [],
    status: "done",
    retryable: false,
    artifacts: [relleno, entregable],
  }));
  assert.equal(validado.status, "done", "con un data: válido el contrato acepta el turno solo-fichero");
  assert.match(validado.reply ?? "", /^Te dejo el\/los fichero\(s\)/u);

  const salida = await inlineLocalArtifacts(validado);
  assert.equal(salida.artifacts[1]?.uri, "cauce:not-sent");
  assert.equal(salida.status, "failed");
  assert.equal(salida.retryable, false);
  assert.doesNotMatch(salida.reply ?? "", /Te dejo el\/los fichero/u);
  assert.match(salida.reply ?? "", /fichero/u, "el humano tiene que saber que había un fichero");
});

test("con una delegación en vuelo el turno sigue en 'done', pero el texto deja de prometer el fichero", async () => {
  const salida = await inlineLocalArtifacts({
    reply: FILE_ONLY_REPLY,
    messages: [{ to: "socrates", body: "segui vos" }],
    notify: [],
    status: "done",
    retryable: false,
    artifacts: [
      { name: "relleno.txt", uri: `data:text/plain,${"x".repeat(9_999_999)}` },
      { name: "a.pdf", uri: `data:application/pdf;base64,${"QUJD".repeat(1_000)}` },
    ],
  });

  assert.equal(salida.status, "done", "una delegación viva no se cae por un adjunto que no entró");
  assert.equal(salida.messages.length, 1);
  assert.doesNotMatch(salida.reply ?? "", /Te dejo el\/los fichero/u);
});

test("un prefijo denegado impide LEER el fichero, y sin la opción el mismo fichero sí se inlinea", async () => {
  const directorio = await workspace();
  const path = await fileWith("secreto-1-abc123", Buffer.from("TOKEN=sk-live-do-not-share"));

  const denegado = await inlineLocalArtifacts(envelope([{ name: "secreto", uri: path }]), {
    deniedPathPrefixes: [directorio],
  });
  assert.equal(firstUri(denegado), path, "una ruta bajo un prefijo denegado no se convierte a data:");

  const porPredicado = await inlineLocalArtifacts(envelope([{ name: "secreto", uri: path }]), {
    denyPath: (candidate) => candidate.endsWith("secreto-1-abc123"),
  });
  assert.equal(firstUri(porPredicado), path);

  const sinOpcion = await inlineLocalArtifacts(envelope([{ name: "secreto", uri: path }]));
  assert.match(firstUri(sinOpcion), /^data:/u, "el default no deniega nada: es la opción la que niega");
});

test("un directorio intermedio enlazado no saca el fichero del prefijo denegado", async () => {
  const raiz = await realpath(await workspace());
  const secretos = join(raiz, "secretos-denegados");
  await mkdir(secretos, { recursive: true });
  const real = join(secretos, "secreto-2-abc123");
  await writeFile(real, Buffer.from("TOKEN=sk-live-do-not-share"));
  const enlace = join(raiz, "enlace-a-secretos");
  await rm(enlace, { force: true });
  await symlink(secretos, enlace, "dir");
  const porEnlace = join(enlace, "secreto-2-abc123");

  const denegado = await inlineLocalArtifacts(envelope([{ name: "secreto", uri: porEnlace }]), {
    deniedPathPrefixes: [secretos],
  });
  assert.equal(firstUri(denegado), porEnlace,
    "el prefijo denegado se evalúa sobre la ruta con el padre resuelto");

  const prefijoEnlazado = await inlineLocalArtifacts(envelope([{ name: "secreto", uri: real }]), {
    deniedPathPrefixes: [enlace],
  });
  assert.equal(firstUri(prefijoEnlazado), real,
    "y también cuando el prefijo que nombra el llamante es el que pasa por el enlace");

  const otroArbol = await inlineLocalArtifacts(envelope([{ name: "secreto", uri: real }]), {
    deniedPathPrefixes: [join(raiz, "otro-arbol")],
  });
  assert.match(firstUri(otroArbol), /^data:/u, "resolver no puede denegar lo que nadie denegó");
});

test("un data: sin base64 de caracteres multibyte no entra en el presupuesto compartido", async () => {
  const uri = `data:text/plain,${"\u4e2d".repeat(3_400_000)}`;
  const salida = await inlineLocalArtifacts(envelope([{ name: "grande.txt", uri }]));
  assert.equal(firstUri(salida), "cauce:not-sent", "el peso del adjunto se mide en bytes UTF-8");
});

test("un fichero no viaja bajo un texto que dice que no se llegó a redactar nada", async () => {
  const path = await fileWith("informe-bidireccional.png", PNG_BYTES);
  const validado = validateDeliveryOutput(validateStructuredOutput({
    reply: null,
    messages: [],
    notify: [],
    status: "done",
    retryable: false,
    artifacts: [{ name: "informe.png", uri: path }],
  }));
  assert.equal(validado.status, "failed", "antes de inlinear el contrato no ve fichero entregable");

  const salida = await inlineLocalArtifacts(validado);
  assert.match(firstUri(salida), /^data:/u, "el inliner sí lo convierte en un fichero real");
  assert.equal(salida.status, "done", "y entonces el turno deja de negar el trabajo que hizo");
  assert.equal(salida.retryable, false);
  assert.equal(salida.reply, FILE_ONLY_REPLY);
});

test("un data: que solo DICE ser base64 no entra en el presupuesto compartido", async () => {
  const uri = `data:text/plain;base64,${"中".repeat(4_000_000)}`;
  const salida = await inlineLocalArtifacts(envelope([{ name: "grande.txt", uri }]));
  assert.equal(firstUri(salida), "cauce:not-sent", "el peso de un base64 fingido son sus bytes UTF-8");
});

test("prometer un fichero con la lista de artifacts vacia tampoco cierra el turno en 'done'", async () => {
  const salida = await inlineLocalArtifacts({
    reply: FILE_ONLY_REPLY,
    messages: [],
    notify: [],
    status: "done",
    retryable: false,
    artifacts: [],
  });
  assert.equal(salida.status, "failed", "sin nada adjunto el texto que promete un fichero es mentira");
  assert.equal(salida.retryable, false);
  assert.doesNotMatch(salida.reply ?? "", /Te dejo el\/los fichero/u);
  assert.match(salida.reply ?? "", /fichero/u, "el humano tiene que saber que había un fichero");
});

test("un data: ya hecho pesa lo que el frame carga, no lo que el decodificador mide", async () => {
  const conEspacios = `data:text/plain;base64,A${" ".repeat(13_000_000)}AAA`;
  const cabecerota = `data:text/plain;${"x".repeat(13_000_000)};base64,AAAA`;
  const delante = `${" ".repeat(20_000_000)}data:text/plain;base64,QUJD`;

  for (const uri of [conEspacios, cabecerota, delante]) {
    const salida = await inlineLocalArtifacts(envelope([{ name: "a.txt", uri }]));
    assert.equal(firstUri(salida), "cauce:not-sent",
      "13 MB de relleno gastan 13 MB del presupuesto agregado, no 3 bytes");
  }
});
