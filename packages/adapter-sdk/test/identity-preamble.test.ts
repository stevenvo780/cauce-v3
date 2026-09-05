import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { DurableStore } from "../src/sdk/durable-store.js";
import { SpawnCommandRunner } from "../src/sdk/process-runner.js";
import type {
  CommandRunRequest,
  CommandRunResult,
  CommandRunner,
  HarnessDefinition,
} from "../src/sdk/types.js";
import { HARNESS_DEFINITIONS, HarnessAdapter } from "../src/harnesses/index.js";
import {
  IDENTITY_BEGIN,
  IDENTITY_END,
  PRIMARY_DUTY_HEADER,
  type HarnessRequestContext,
} from "../src/harnesses/shared.js";
import { testStateRoot } from "./test-state.js";

const stateRoot = testStateRoot();
const definitions = Object.values(HARNESS_DEFINITIONS);

function fixture(definition: HarnessDefinition): string {
  return resolve(`test/fixtures/fake-${definition.id}.mjs`);
}

async function freshStore(name: string): Promise<DurableStore> {
  const directory = resolve(stateRoot, name);
  await rm(directory, { recursive: true, force: true });
  return DurableStore.open(directory);
}

class RecordingRunner implements CommandRunner {
  readonly requests: CommandRunRequest[] = [];
  constructor(private readonly inner: CommandRunner) {}

  run(request: CommandRunRequest): Promise<CommandRunResult> {
    this.requests.push(request);
    return this.inner.run(request);
  }
}

const baseContext: HarnessRequestContext = {
  self_alias: "argos",
  sender_alias: "kant",
  tenant_id: "Steven",
  room_id: "grp.steven",
  channel: "cauce",
  agent_message: true,
  message_type: "agent.message",
  routing_targets: [{ tenant_id: "Steven", alias: "zeus", online: true }],
};

async function stdinFor(
  name: string,
  definition: HarnessDefinition,
  context: HarnessRequestContext | undefined,
): Promise<string> {
  const runner = new RecordingRunner(new SpawnCommandRunner());
  const adapter = new HarnessAdapter({
    definition,
    runner,
    store: await freshStore(name),
    commandOverride: { command: process.execPath, prefixArgs: [fixture(definition)] },
  });
  await adapter.execute({
    prompt: "SCENARIO:success",
    ...(context === undefined ? {} : { context }),
    timeoutMs: 2_000,
    signal: new AbortController().signal,
  });
  const request = runner.requests[0];
  assert.ok(request);
  return request.stdin;
}

test("identidad -> deber -> contrato, en ese orden, en los cinco harnesses", async () => {
  for (const definition of definitions) {
    const stdin = await stdinFor(`identity-${definition.id}`, definition, {
      ...baseContext,
      self_role: "Verificacion independiente, read-only. Tu producto es el veredicto, no el reparto.",
    });
    const identityAt = stdin.indexOf(IDENTITY_BEGIN);
    const dutyAt = stdin.indexOf(PRIMARY_DUTY_HEADER);
    const contractAt = stdin.indexOf("Return exactly one structured result");
    assert.ok(identityAt >= 0, `${definition.id}: falta el bloque de identidad`);
    assert.ok(dutyAt >= 0, `${definition.id}: falta el deber primario`);
    assert.ok(contractAt >= 0, `${definition.id}: falta el contrato`);
    assert.ok(
      identityAt < dutyAt,
      `${definition.id}: la identidad tiene que venir antes del deber`,
    );
    assert.ok(
      dutyAt < contractAt,
      `${definition.id}: el deber tiene que enmarcar el contrato, no seguirlo`,
    );
    assert.match(stdin, /Sos "argos", un agente de la flota Cauce V3 del tenant "Steven"/u);
    assert.match(stdin, /Tu rol: Verificacion independiente, read-only\./u);
    assert.ok(stdin.includes(IDENTITY_END));
  }
});

test("sin role_brief se emite la identidad pero nunca un rol inventado", async () => {
  const stdin = await stdinFor("identity-sin-rol", HARNESS_DEFINITIONS.claude, baseContext);
  assert.ok(stdin.includes(IDENTITY_BEGIN));
  assert.match(stdin, /Sos "argos", un agente de la flota Cauce V3/u);
  assert.doesNotMatch(stdin, /Tu rol:/u);
});

test("sin contexto de entrega no hay identidad, pero el deber primario sigue", async () => {
  const stdin = await stdinFor("identity-sin-contexto", HARNESS_DEFINITIONS.claude, undefined);
  assert.ok(!stdin.includes(IDENTITY_BEGIN));
  // The duty does not depend on the alias: a delivery without context is still the work of its runner.
  assert.ok(stdin.includes(PRIMARY_DUTY_HEADER));
  assert.match(stdin, /Return exactly one structured result/u);
});

test("la identidad describe el mundo del agente y deja el mandato al deber primario", async () => {
  const stdin = await stdinFor("identity-mundo", HARNESS_DEFINITIONS.codex, baseContext);
  const identity = stdin.slice(
    stdin.indexOf(IDENTITY_BEGIN),
    stdin.indexOf(IDENTITY_END) + IDENTITY_END.length,
  );

  // What identity IS: how Cauce works, the limits of authority, whom to escalate to.
  assert.match(identity, /Entre entregas no existís/u);
  assert.match(identity, /no dejes el turno abierto/u);
  assert.match(identity, /Comunicación no es autorización/u);
  assert.match(identity, /escalá a zeus con el error textual crudo/u);

  // What identity is NOT: the mandate. It lives only once, in the primary duty — and for
  // `Steven/argos` (this baseContext) that duty is the director's, not the executor's.
  assert.doesNotMatch(identity, /Esta entrega es TU trabajo/u);
  assert.doesNotMatch(identity, /Delegar es la excepción/u);
  assert.doesNotMatch(identity, /REPARTIR y VERIFICAR/u);
  assert.ok(stdin.includes(PRIMARY_DUTY_HEADER));
  assert.match(stdin, /tu entrega es REPARTIR y VERIFICAR/u);
  assert.doesNotMatch(stdin, /Esta entrega es TU trabajo/u);
});

test("un role_brief con tildes sobrevive el viaje por stdin hasta el harness", async () => {
  // The hermes bridge decodes stdin with strict utf-8; the role comes in Spanish from the database.
  const stdin = await stdinFor("identity-tildes", HARNESS_DEFINITIONS.hermes, {
    ...baseContext,
    self_role: "Verificación independiente y read-only: auditás, contrastás y emitís un veredicto.",
  });
  assert.match(
    stdin,
    /Tu rol: Verificación independiente y read-only: auditás, contrastás y emitís un veredicto\./u,
  );
  assert.equal(Buffer.from(stdin, "utf8").toString("utf8"), stdin);
});

test("el rol del alias gana a las lineas genericas, y solo cuando hay rol", async () => {
  const conRol = await stdinFor("identity-precedencia", HARNESS_DEFINITIONS.claude, {
    ...baseContext,
    self_role: "Sos el DIRECTOR: decidí y actuá vos, no consultes salvo dinero o legal.",
  });
  const identidad = conRol.slice(
    conRol.indexOf(IDENTITY_BEGIN),
    conRol.indexOf(IDENTITY_END) + IDENTITY_END.length,
  );
  assert.match(identidad, /Tu rol manda sobre las líneas genéricas de este bloque/u);

  assert.ok(
    identidad.indexOf("Tu rol manda sobre las líneas genéricas")
      > identidad.indexOf("Comunicación no es autorización"),
    "la precedencia tiene que cerrar el bloque, no abrirlo",
  );

  assert.match(identidad, /Si algo SÓLO lo puede resolver un humano/u);

  const sinRol = await stdinFor("identity-precedencia-sin-rol", HARNESS_DEFINITIONS.claude, baseContext);
  assert.doesNotMatch(sinRol, /Tu rol manda sobre las líneas genéricas/u);
});
