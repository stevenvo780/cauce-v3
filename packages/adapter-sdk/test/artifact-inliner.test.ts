import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";
import {
  MAX_INLINED_ARTIFACT_BYTES,
  inlineLocalArtifacts,
  localArtifactPath,
} from "../src/sdk/artifact-inliner.js";
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

test("una ruta local dentro de messages[].artifacts se inlinea igual que la del origen", async () => {
  const path = await fileWith("delegado.png", PNG_BYTES);
  const entrada: StructuredOutput = {
    ...envelope([]),
    messages: [{ to: "socrates", body: "sigue tú", artifacts: [{ name: "delegado.png", uri: path }] }],
  };

  const output = await inlineLocalArtifacts(entrada);

  const enviado = output.messages[0]?.artifacts?.[0];
  assert.ok(enviado, "la delegación salió sin artifacts");
  assert.match(enviado.uri, /^data:image\/png;base64,/u);
  assert.deepEqual(decodeDataUri(enviado.uri), PNG_BYTES);
  assert.equal(enviado.sha256, createHash("sha256").update(PNG_BYTES).digest("hex"));
  assert.equal(output.messages[0]?.body, "sigue tú");
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

test("un artefacto local mayor que el tope inline sube al almacén de blobs y viaja por referencia", async () => {
  const { configureDefaultBlobClient } = await import("../src/sdk/blob-client.js");
  const { blobArtifactUri, blobLocator } = await import("@cauce/protocol");
  const directory = await mkdtemp(join(tmpdir(), "cauce-blob-inline-"));
  const path = join(directory, "enorme.bin");
  const bytes = Buffer.alloc(MAX_INLINED_ARTIFACT_BYTES + 1, 3);
  await writeFile(path, bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const uploads: { path: string; name: string; mediaType: string }[] = [];
  const uploader = {
    async upload(file: string, options: { name: string; mediaType: string; sha256?: string }) {
      uploads.push({ path: file, name: options.name, mediaType: options.mediaType });
      return { sha256: digest, bytes: bytes.length, mediaType: options.mediaType, name: options.name, uri: blobArtifactUri(digest), blob: blobLocator(digest) };
    },
  };
  const output: StructuredOutput = {
    reply: "va por referencia", messages: [], notify: [], status: "done", retryable: false,
    artifacts: [{ name: "enorme.bin", uri: pathToFileURL(path).href }],
  };
  try {
    const inlined = await inlineLocalArtifacts(output, { blobs: uploader });
    assert.deepEqual(inlined.artifacts, [{
      name: "enorme.bin", uri: blobArtifactUri(digest), media_type: "application/octet-stream", sha256: digest, size: bytes.length,
    }]);
    assert.deepEqual(uploads, [{ path, name: "enorme.bin", mediaType: "application/octet-stream" }]);

    configureDefaultBlobClient(undefined);
    const untouched = await inlineLocalArtifacts(output);
    assert.equal(untouched.artifacts[0]?.uri, pathToFileURL(path).href);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
