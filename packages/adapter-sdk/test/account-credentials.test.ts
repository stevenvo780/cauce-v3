/**
 * El sistema rotativo de cuentas, del lado del adaptador: cómo la cuenta elegida por el selector
 * (GET /v3/accounts/selection) se convierte en el `env` con el que se lanza el harness.
 *
 * Dos mitades:
 *   1. `resolveAccountCredentialEnv`, pura: qué variable se emite y cuándo se rechaza.
 *   2. El cableado real en `HarnessAdapter`: que ese `env` LLEGUE al proceso hijo. Sin esta
 *      segunda mitad, la primera sería una función que nadie llama —que es exactamente el estado
 *      del que parte este trabajo, con `credential_ref` como metadato muerto.
 */
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { DurableStore } from "../src/sdk/durable-store.js";
import {
  resolveAccountCredentialEnv,
  type SelectedAccount,
} from "../src/sdk/account-credentials.js";
import type {
  CommandRunRequest,
  CommandRunResult,
  CommandRunner,
} from "../src/sdk/types.js";
import { HARNESS_DEFINITIONS, HarnessAdapter } from "../src/harnesses/index.js";

const stateRoot = resolve(".test-state");

async function freshStore(name: string): Promise<DurableStore> {
  const directory = resolve(stateRoot, name);
  await rm(directory, { recursive: true, force: true });
  return DurableStore.open(directory);
}

const claudeAccount: SelectedAccount = {
  account_id: "claude-max-steven",
  provider: "claude",
  credential_ref_kind: "env_path",
  credential_ref: "CAUCE_CLAUDE_MAX_STEVEN_PATH",
};

const ROTATION_ON = { CAUCE_ACCOUNT_ROTATION: "enabled" };

test("dereferencia el locator env_path y apunta al harness a esa cuenta", () => {
  const resolution = resolveAccountCredentialEnv("claude", claudeAccount, {
    ...ROTATION_ON,
    CAUCE_CLAUDE_MAX_STEVEN_PATH: "/datos/agents/argos/.claude",
  });

  assert.equal(resolution.refused, null);
  assert.equal(resolution.account_id, "claude-max-steven");
  assert.deepEqual(resolution.env, { CLAUDE_CONFIG_DIR: "/datos/agents/argos/.claude" });
});

test("un locator de tipo file es el path directo", () => {
  const resolution = resolveAccountCredentialEnv("codex", {
    account_id: "codex-pro",
    provider: "codex",
    credential_ref_kind: "file",
    credential_ref: "/datos/agents/argos/.codex",
  }, ROTATION_ON);

  assert.equal(resolution.refused, null);
  assert.deepEqual(resolution.env, { CODEX_HOME: "/datos/agents/argos/.codex" });
});

test("SIN el opt-in no toca nada: es el camino de los 6 alias con ~/.claude compartido", () => {
  // La propiedad que impide que este parche rompa a los alias montados sobre
  // /datos/agents/shared/.claude: sin CAUCE_ACCOUNT_ROTATION=enabled se devuelve `{}`, o sea cero
  // variables añadidas, o sea exactamente el comportamiento de hoy.
  const resolution = resolveAccountCredentialEnv("claude", claudeAccount, {
    CAUCE_CLAUDE_MAX_STEVEN_PATH: "/datos/agents/shared/.claude",
  });

  assert.equal(resolution.refused, "rotation_disabled");
  assert.deepEqual(resolution.env, {});
  assert.equal(resolution.account_id, null);
});

test("un valor distinto de 'enabled' tampoco activa la rotación", () => {
  const resolution = resolveAccountCredentialEnv("claude", claudeAccount, {
    CAUCE_ACCOUNT_ROTATION: "true",
    CAUCE_CLAUDE_MAX_STEVEN_PATH: "/datos/agents/argos/.claude",
  });

  assert.equal(resolution.refused, "rotation_disabled");
  assert.deepEqual(resolution.env, {});
});

test("sin cuenta seleccionada no inventa un override", () => {
  const resolution = resolveAccountCredentialEnv("claude", null, ROTATION_ON);
  assert.equal(resolution.refused, "no_account_selected");
  assert.deepEqual(resolution.env, {});
});

test("rechaza un locator que este host no tiene montado, en vez de apuntar a la nada", () => {
  const resolution = resolveAccountCredentialEnv("claude", claudeAccount, ROTATION_ON);
  assert.equal(resolution.refused, "locator_not_present");
  assert.deepEqual(resolution.env, {});
});

test("no dereferencia secret_manager: el adaptador no habla con vaults", () => {
  const resolution = resolveAccountCredentialEnv("claude", {
    account_id: "claude-vault",
    provider: "claude",
    credential_ref_kind: "secret_manager",
    credential_ref: "vault:kv/claude/steven",
  }, ROTATION_ON);

  assert.equal(resolution.refused, "secret_manager_unsupported");
  assert.deepEqual(resolution.env, {});
});

test("un harness sin variable conocida se rechaza en vez de adivinarle una", () => {
  const resolution = resolveAccountCredentialEnv("hermes", {
    account_id: "hermes-local",
    provider: "hermes",
    credential_ref_kind: "file",
    credential_ref: "/datos/agents/argos/.hermes",
  }, ROTATION_ON);

  assert.equal(resolution.refused, "harness_not_rotatable");
  assert.deepEqual(resolution.env, {});
});

test("ninguna variable emitida matchea el filtro de secretos del process-runner", () => {
  // `childEnvironment()` tira SECRET_ENV_REJECTED —y mata la ejecución entera— ante cualquier
  // clave que matchee este regex. Es una condición dura sobre HARNESS_CREDENTIAL_ENV.
  const secretLike = /(?:secret|token|password|passwd|api[_-]?key|auth|credential|cookie|session)/iu;

  for (const harness of ["claude", "codex", "opencode", "openclaw"] as const) {
    const resolution = resolveAccountCredentialEnv(harness, {
      account_id: `${harness}-a`,
      provider: harness,
      credential_ref_kind: "file",
      credential_ref: "/datos/agents/argos/dir",
    }, ROTATION_ON);
    assert.equal(resolution.refused, null);
    for (const key of Object.keys(resolution.env)) assert.equal(secretLike.test(key), false);
  }
});

// ---------------------------------------------------------------------------------------------
// El cableado: que el env resuelto llegue de verdad al proceso del harness.
// ---------------------------------------------------------------------------------------------

class RecordingRunner implements CommandRunner {
  readonly requests: CommandRunRequest[] = [];

  run(request: CommandRunRequest): Promise<CommandRunResult> {
    this.requests.push(request);
    return Promise.resolve({
      stdout: JSON.stringify({ result: "listo" }),
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
    });
  }
}

test("HarnessAdapter pasa al hijo el env de la cuenta resuelta", async () => {
  const runner = new RecordingRunner();
  const adapter = new HarnessAdapter({
    definition: HARNESS_DEFINITIONS.claude,
    runner,
    store: await freshStore("account-env-applied"),
    resolveCredentialEnv: () => Promise.resolve(
      resolveAccountCredentialEnv("claude", claudeAccount, {
        ...ROTATION_ON,
        CAUCE_CLAUDE_MAX_STEVEN_PATH: "/datos/agents/argos/.claude",
      }).env,
    ),
  });

  await adapter.execute({
    prompt: "hola",
    timeoutMs: 2_000,
    signal: new AbortController().signal,
  });

  assert.equal(runner.requests.length, 1);
  assert.deepEqual(runner.requests[0]?.env, { CLAUDE_CONFIG_DIR: "/datos/agents/argos/.claude" });
});

test("sin resolutor el hijo se lanza SIN env añadido: comportamiento de hoy intacto", async () => {
  const runner = new RecordingRunner();
  const adapter = new HarnessAdapter({
    definition: HARNESS_DEFINITIONS.claude,
    runner,
    store: await freshStore("account-env-absent"),
  });

  await adapter.execute({
    prompt: "hola",
    timeoutMs: 2_000,
    signal: new AbortController().signal,
  });

  // `undefined`, no `{}`: el runner no debe recibir siquiera la clave, para que el
  // comportamiento sea idéntico byte a byte al de antes de este parche.
  assert.equal(runner.requests[0]?.env, undefined);
});

test("si el resolutor falla se sigue despachando sin override, no se cae la ejecución", async () => {
  // Quedarse sin despachar porque no se pudo consultar QUÉ cuenta usar sería cambiar un problema
  // de costos por una caída.
  const runner = new RecordingRunner();
  const adapter = new HarnessAdapter({
    definition: HARNESS_DEFINITIONS.claude,
    runner,
    store: await freshStore("account-env-resolver-fails"),
    resolveCredentialEnv: () => Promise.reject(new Error("gateway no responde")),
  });

  await adapter.execute({
    prompt: "hola",
    timeoutMs: 2_000,
    signal: new AbortController().signal,
  });

  assert.equal(runner.requests.length, 1);
  assert.equal(runner.requests[0]?.env, undefined);
});
