import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, chmod, mkdtemp, readFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sealSecret, type SecretHandoffPayload, type SecretHandoffRef } from "@cauce/protocol";
import { fakeDefinition, HarnessAdapter } from "../src/harnesses/index.js";
import { AdapterEngine } from "../src/sdk/engine.js";
import type { AdapterEngineOptions } from "../src/sdk/engine/contracts.js";
import type { FetchSealedSecret } from "../src/sdk/secrets.js";
import { loadOrCreateSealingKeyPair, materializeSecrets } from "../src/sdk/secrets.js";
import { SecureFileError, writeOwnerOnlyFile } from "../src/sdk/secure-files.js";
import type { Delivery, DeliveryEvent } from "../src/sdk/types.js";
import { ControlledRunner, delivery, storeFor } from "./engine-fixtures.js";

const FROM = { tenant: "Steven", alias: "kant" } as const;
const SELF = { tenant: "Steven", alias: "argos" } as const;
const VALUE = "valor-secretisimo-que-nunca-viaja";

function instant(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

async function scratch(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `cauce-${prefix}-`));
}

async function sealedHandoff(
  keyPath: string,
  id: string,
  value: string | Buffer = VALUE,
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
    plaintext: Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8"),
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
    expires_at: instant(3_600_000),
    created_at: instant(0),
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

interface Aviso {
  readonly event: string;
  readonly reason?: string;
}

interface Turno {
  readonly engine: AdapterEngine;
  readonly runner: ControlledRunner;
  readonly events: DeliveryEvent[];
  readonly logs: Aviso[];
}

async function turnoConSecretos(
  name: string,
  fetchSealedSecret: FetchSealedSecret,
): Promise<Turno> {
  const store = await storeFor(name);
  const runner = new ControlledRunner();
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
    body: { prompt: "usá la credencial que te pasaron", timeout_ms: 2_000, secrets_v1: [ref] },
  };
}

test("writeOwnerOnlyFile crea 0600, no pisa lo existente y no sigue un enlace", async () => {
  const directory = await scratch("secure");
  const path = join(directory, "valor");
  await writeOwnerOnlyFile(path, Buffer.from(VALUE, "utf8"), "test secret");

  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(await readFile(path, "utf8"), VALUE);

  await assert.rejects(
    writeOwnerOnlyFile(path, Buffer.from("otro valor", "utf8"), "test secret"),
    (error: unknown) => error instanceof SecureFileError && !error.message.includes("otro valor"),
  );

  const link = join(directory, "enlace");
  await symlink(path, link);
  await assert.rejects(
    writeOwnerOnlyFile(link, Buffer.from("otro valor", "utf8"), "test secret"),
    SecureFileError,
  );
  assert.equal(await readFile(path, "utf8"), VALUE);
});

test("materializeSecrets deja el valor en un 0600 dentro del 0700 y sólo devuelve la ruta", async () => {
  const directory = await scratch("secretos-dir");
  await chmod(directory, 0o700);
  const keyPath = join(await scratch("secretos-clave"), "sealing.key");
  const payload = await sealedHandoff(keyPath, randomUUID());
  const notices: string[] = [];

  const materialization = await materializeSecrets([refOf(payload)], {
    directory,
    keyPath,
    toTenant: SELF.tenant,
    toAlias: SELF.alias,
    fetchSealedSecret: async () => payload,
    notice: (secretId, reason) => notices.push(`${secretId}:${reason}`),
  });

  const secret = materialization.secrets[0];
  assert.equal(materialization.secrets.length, 1);
  assert.ok(secret);
  assert.deepEqual(Object.keys(secret).sort(), ["id", "label", "path"]);
  assert.deepEqual(materialization.scrub.values, [VALUE]);
  assert.deepEqual(
    materialization.scrub.digests,
    [createHash("sha256").update(Buffer.from(VALUE, "utf8")).digest("hex")],
  );
  assert.equal(secret.id, payload.id);
  assert.equal(secret.label, payload.label);
  assert.ok(secret.path.startsWith(`${directory}/`));
  assert.equal((await stat(secret.path)).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal(await readFile(secret.path, "utf8"), VALUE);
  assert.deepEqual(notices, []);
});

test("el prompt del turno lleva la ruta y el id del secreto, nunca su valor", async () => {
  const keyPath = join(await scratch("secretos-turno"), "sealing.key");
  process.env.CAUCE_SEALING_KEY_PATH = keyPath;
  try {
    const payload = await sealedHandoff(keyPath, randomUUID());
    const turno = await turnoConSecretos("secretos-prompt", async () => payload);

    await turno.engine.handleDelivery(conSecreto("secreto-en-prompt", refOf(payload)));

    const stdin = turno.runner.requests[0]?.stdin ?? "";
    const path = /"path":"([^"]+)"/u.exec(stdin)?.[1];
    assert.ok(path, "el bloque de secretos debe declarar la ruta");
    assert.ok(stdin.includes(payload.id));
    assert.ok(stdin.includes(payload.label));
    assert.ok(!stdin.includes(VALUE), "el valor jamás entra al prompt");
    assert.match(stdin, /sólo para este turno/u);
    assert.equal(turno.events.at(-1)?.phase, "done");
    await assert.rejects(access(path), { code: "ENOENT" });
  } finally {
    delete process.env.CAUCE_SEALING_KEY_PATH;
  }
});

test("un sobre manipulado no deja fichero, deja aviso y el turno se completa igual", async () => {
  const keyPath = join(await scratch("secretos-roto"), "sealing.key");
  process.env.CAUCE_SEALING_KEY_PATH = keyPath;
  try {
    const payload = await sealedHandoff(keyPath, randomUUID());
    const bytes = Buffer.from(payload.sealed, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    const tampered: SecretHandoffPayload = { ...payload, sealed: bytes.toString("base64") };
    const turno = await turnoConSecretos("secretos-manipulado", async () => tampered);

    await turno.engine.handleDelivery(conSecreto("secreto-manipulado", refOf(payload)));

    const stdin = turno.runner.requests[0]?.stdin ?? "";
    assert.ok(!stdin.includes(VALUE));
    assert.ok(!stdin.includes('"path":"'), "un secreto que no abrió no se anuncia");
    assert.ok(turno.logs.some((entry) => entry.event === "secret_handoff_skipped"));
    assert.equal(turno.events.at(-1)?.phase, "done");
  } finally {
    delete process.env.CAUCE_SEALING_KEY_PATH;
  }
});

interface Materializacion {
  readonly secrets: readonly { path: string }[];
  readonly notices: string[];
  readonly directory: string;
  readonly pedidos: number;
}

async function materializarUno(
  prefix: string,
  payload: SecretHandoffPayload,
  ref: SecretHandoffRef,
  keyPath: string,
  toAlias: string = SELF.alias,
): Promise<Materializacion> {
  const directory = await scratch(prefix);
  await chmod(directory, 0o700);
  const notices: string[] = [];
  let pedidos = 0;
  const materialization = await materializeSecrets([ref], {
    directory,
    keyPath,
    toTenant: SELF.tenant,
    toAlias,
    fetchSealedSecret: async () => {
      pedidos += 1;
      return payload;
    },
    notice: (secretId, reason) => notices.push(`${secretId}:${reason}`),
  });
  return { secrets: materialization.secrets, notices, directory, pedidos };
}

test("un sobre dirigido a otro destinatario no se abre", async () => {
  const keyPath = join(await scratch("secretos-destinatario"), "sealing.key");
  const payload = await sealedHandoff(keyPath, randomUUID());

  const resultado = await materializarUno("destinatario", payload, refOf(payload), keyPath, "seneca");

  assert.deepEqual(resultado.secrets, []);
  assert.deepEqual(resultado.notices, [`${payload.id}:payload_does_not_match_ref`]);
  await assert.rejects(access(join(resultado.directory, `secret-1-${payload.id}`)), { code: "ENOENT" });
});

test("un sobre cuyos campos no coinciden con la referencia de la entrega no se abre", async () => {
  const keyPath = join(await scratch("secretos-referencia"), "sealing.key");
  const payload = await sealedHandoff(keyPath, randomUUID());
  const falsificado: SecretHandoffRef = { ...refOf(payload), from_alias: "zeus" };

  const resultado = await materializarUno("referencia", payload, falsificado, keyPath);

  assert.deepEqual(resultado.secrets, []);
  assert.deepEqual(resultado.notices, [`${payload.id}:payload_does_not_match_ref`]);
});

test("una referencia vencida no llega ni a pedir el sobre", async () => {
  const keyPath = join(await scratch("secretos-vencidos"), "sealing.key");
  const payload = await sealedHandoff(keyPath, randomUUID());
  const vencida: SecretHandoffRef = { ...refOf(payload), expires_at: instant(-1_000) };

  const resultado = await materializarUno("vencidos", payload, vencida, keyPath);

  assert.deepEqual(resultado.secrets, []);
  assert.deepEqual(resultado.notices, [`${payload.id}:handoff_expired`]);
  assert.equal(resultado.pedidos, 0, "una referencia vencida no llega a pedir el sobre");
});

test("un sobre que nombra otra llave de sellado se cierra antes de descifrar", async () => {
  const keyPath = join(await scratch("secretos-llave"), "sealing.key");
  const payload = await sealedHandoff(keyPath, randomUUID());
  const otraLlave: SecretHandoffPayload = { ...payload, sealing_key_id: "0123456789abcdef" };

  const resultado = await materializarUno("llave", otraLlave, refOf(payload), keyPath);

  assert.deepEqual(resultado.secrets, []);
  assert.deepEqual(resultado.notices, [`${payload.id}:sealing_key_mismatch`]);
});

/**
 * The scrub material has two floors, and both are guarantees the reader should see stated: a
 * plaintext under `MIN_SCRUBBED_LENGTH` and one that is not valid UTF-8 leave NO value to strike
 * out of prose. Their digest still travels, which is why the `data:` reading has to be exact.
 */
test("un secreto binario o más corto que el suelo de scrub sólo deja digest", async () => {
  const binario = Buffer.from([0xff, 0xfe, 0x01, 0x02, 0x41, 0x42, 0x43, 0x44]);
  for (const plaintext of [binario, Buffer.from("abc", "utf8")]) {
    const directory = await scratch("secretos-sin-scrub");
    await chmod(directory, 0o700);
    const keyPath = join(await scratch("secretos-sin-scrub-clave"), "sealing.key");
    const payload = await sealedHandoff(keyPath, randomUUID(), plaintext);

    const materialization = await materializeSecrets([refOf(payload)], {
      directory,
      keyPath,
      toTenant: SELF.tenant,
      toAlias: SELF.alias,
      fetchSealedSecret: async () => payload,
      notice: () => undefined,
    });

    assert.equal(materialization.secrets.length, 1);
    assert.deepEqual(materialization.scrub.values, []);
    assert.deepEqual(
      materialization.scrub.digests,
      [createHash("sha256").update(plaintext).digest("hex")],
    );
  }
});
