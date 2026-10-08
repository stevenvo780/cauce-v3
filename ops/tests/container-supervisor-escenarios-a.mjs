import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { materializeSupervisorOpsFixture } from "./fixtures/container-supervisor-ops-root.mjs";

// Escenarios supervisor-start movidos desde container-supervisor.test.mjs (poda T060-D).
// Recibe por ctx los fixtures/helpers del test; devuelve el flujo (statePath/result/calls) por ctx.
export async function escenariosA(ctx) {
  const {
      temporary, configRoot, bundleRoot, release, release2, pkiRoot, mountSourceRoot, imageId, firstId, secondId,
      secondGenerationStartedAt, aliasState, aliasMount, bundleDigest, bundleDigest2, executable, bundleDigestFor,
      writeConfig, dockerState, environment, runSupervisor, clearLog, records, waitForLogOrExit, waitForChildExit,
      runSupervisorAsync, recordsForState, supervisor, runtimeHelper,
  } = ctx;
  let statePath = await dockerState("atlas", { running: false });
  let result = runSupervisor("start", "atlas", statePath);
  assert.notEqual(result.status, 0);
  assert.equal((await records()).some(({ argv }) => argv[0] === "cp"), false);

  // The alias pin selects one direct release directory; a symlink alias is never accepted.
  await symlink("release-1", path.join(bundleRoot, "releases/release-link"));
  await writeConfig("atlas", [], { BUNDLE_RELEASE: "release-link" });
  await clearLog();
  result = runSupervisor("start", "atlas", await dockerState("atlas"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /non-symlink release directory/u);
  assert.equal((await records()).length, 0, "release symlink must fail before Docker");
  await rm(path.join(bundleRoot, "releases/release-link"));
  await writeConfig("atlas");

  // Full start: full ID only after discovery, structured mount, digest, safe state helper and path-only secrets.
  await clearLog();
  statePath = await dockerState("atlas");
  result = runSupervisor("start", "atlas", statePath);
  assert.equal(result.status, 0, result.stderr);
  let calls = await records();
  const firstInspect = calls.find(({ argv }) => argv[0] === "inspect" && argv[2] === "{{.Id}}");
  assert.equal(firstInspect?.target, "ws-humanizar");
  for (const call of calls.filter(({ argv }) => ["inspect", "exec", "cp"].includes(argv[0]) && argv[2] !== "{{.Id}}")) {
    assert.equal(call.target, firstId, `post-discovery Docker target must be full ID: ${JSON.stringify(call.argv)}`);
  }
  assert(calls.some(({ argv }) => argv.includes("prepare-control") && argv.includes("/run/cauce-v3-supervisor")));
  assert(calls.some(({ argv }) => argv.includes("prepare-state") && argv.includes(aliasState.atlas)));
  assert(calls.some(({ argv }) => argv.includes("bundle-digest") && argv.includes("/opt/cauce-v3-adapter/atlas/releases/release-1")));
  const stopIndex = calls.findIndex(({ argv }) => argv.includes("stop") && argv.includes("--container-id"));
  const bundleCopyIndex = calls.findIndex(({ argv }) => argv[0] === "cp" && argv[1] === `${release}/.`);
  assert(stopIndex >= 0 && stopIndex < bundleCopyIndex);
  // The pre-deploy stop of a prior consumer runs as root against the root-owned control dir.
  const stopCall = calls[stopIndex];
  assert(stopCall.argv.includes("--control-dir") && stopCall.argv.includes("/run/cauce-v3-supervisor/atlas"));
  const stopUserIdx = stopCall.argv.indexOf("--user");
  assert(stopUserIdx >= 0 && stopCall.argv[stopUserIdx + 1] === "0", "stop must run as root");
  const final = calls.find(({ argv }) => argv[0] === "exec" && argv.includes("/usr/bin/env") && argv.includes("CAUCE_ALIAS=atlas"));
  assert(final?.argv.includes("CAUCE_INSTANCE_ID=systemd-container-atlas"));
  assert(final?.argv.includes(`CAUCE_CONTAINER_ID=${firstId}`));
  assert(final?.argv.some((value) => value.startsWith("CAUCE_CONTAINER_GENERATION=")));
  assert.equal(final?.argv.some((value) => value.startsWith("CAUCE_TOKEN_FILE=")), false,
    "mTLS-only atlas must not receive a nonexistent bearer token path");
  assert(final?.argv.includes("CAUCE_TLS_CERT_FILE=/opt/cauce-v3-secrets/atlas/client.crt"));
  assert(final?.argv.includes("CAUCE_TLS_KEY_FILE=/opt/cauce-v3-secrets/atlas/client.key"));
  assert(final?.argv.includes("CAUCE_TLS_CA_FILE=/opt/cauce-v3-secrets/atlas/ca.crt"));
  assert.equal(final?.argv.some((value) => value.includes("FAKE_TOKEN_atlas") || value.includes("FAKE_KEY_atlas")), false);
  assert(final?.argv.includes("--bundle-digest") && final.argv.includes(bundleDigest));
  // The lifecycle controller runs as root and drops the adapter to the mapped non-root UID/GID.
  const finalUserIdx = final.argv.indexOf("--user");
  assert(finalUserIdx >= 0 && final.argv[finalUserIdx + 1] === "0", "controller exec must run as root");
  assert(final.argv.includes("--control-dir") && final.argv.includes("/run/cauce-v3-supervisor/atlas"));
  assert(final.argv.includes("--runtime-uid") && final.argv.includes("--runtime-gid"));
  assert(final.argv.includes("CAUCE_CONTROL_DIR=/run/cauce-v3-supervisor/atlas"));
  assert(final.argv.includes("CAUCE_DEFAULT_TIMEOUT_MS=86400000"),
    "an omitted DEFAULT_TIMEOUT_MS must use the renewable 24-hour agentic default");
  result = runSupervisor("stop", "atlas", statePath);
  assert.equal(result.status, 0, `mTLS-only atlas stop must succeed: ${result.stderr}`);
  process.stdout.write("mTLS-only atlas: start and stop passed without bearer token\n");

  const wireOps = await materializeSupervisorOpsFixture(path.dirname(path.dirname(supervisor)), path.join(temporary, "wire-ops"));
  const wireInventoryPath = path.join(wireOps, "container-aliases.json");
  const wireInventory = JSON.parse(await readFile(wireInventoryPath, "utf8"));
  wireInventory.aliases.atlas.alias = "shared_alias";
  wireInventory.aliases.atlas.tenant = "Equipo_42";
  await writeFile(wireInventoryPath, JSON.stringify(wireInventory));
  await clearLog();
  statePath = await dockerState("atlas");
  result = spawnSync(supervisor, ["start", "atlas"], {
    encoding: "utf8", env: { ...environment(statePath), CAUCE_CONTAINER_OPS_ROOT: wireOps },
  });
  assert.equal(result.status, 0, result.stderr);
  const wireFinal = (await records()).find(({ argv }) => argv.includes("CAUCE_ALIAS=shared_alias"));
  assert(wireFinal?.argv.includes("CAUCE_RUNTIME_KEY=atlas"));
  assert(wireFinal?.argv.includes("CAUCE_TENANT_ID=Equipo_42"));
  assert(wireFinal?.argv.includes("CAUCE_STATE_DIR=" + aliasState.atlas));
  assert(wireFinal?.argv.includes("/run/cauce-v3-supervisor/atlas"));
  assert(wireFinal?.argv.includes("--wire-alias") && wireFinal.argv.includes("shared_alias"));
  assert(wireFinal?.argv.includes("--tenant") && wireFinal.argv.includes("Equipo_42"));
  process.stdout.write("wire identity: logical bus alias and tenant exported; lifecycle/state/profile ownership remains physical\n");

  // Adapter execution defaults to 24 hours, accepts a bounded per-alias override, and rejects every
  // malformed/ambiguous value before Docker, carried through the clean `env -i` boundary explicitly.
  await writeConfig("atlas", [], { DEFAULT_TIMEOUT_MS: "480000" });
  await clearLog();
  result = runSupervisor("start", "atlas", await dockerState("atlas"));
  assert.equal(result.status, 0, `valid DEFAULT_TIMEOUT_MS override must start: ${result.stderr}`);
  const timeoutOverrideFinal = (await records())
    .find(({ argv }) => argv[0] === "exec" && argv.includes("CAUCE_ALIAS=atlas"));
  assert(timeoutOverrideFinal?.argv.includes("CAUCE_DEFAULT_TIMEOUT_MS=480000"),
    "a valid DEFAULT_TIMEOUT_MS override must be exported verbatim");

  for (const [name, extra, override, expected] of [
    ["empty", [], { DEFAULT_TIMEOUT_MS: "" }, /config value is empty: DEFAULT_TIMEOUT_MS/u],
    ["non-numeric", [], { DEFAULT_TIMEOUT_MS: "480000ms" }, /DEFAULT_TIMEOUT_MS must be a decimal integer/u],
    ["below minimum", [], { DEFAULT_TIMEOUT_MS: "59999" }, /DEFAULT_TIMEOUT_MS must be a decimal integer/u],
    ["above maximum", [], { DEFAULT_TIMEOUT_MS: "604800001" }, /DEFAULT_TIMEOUT_MS must be a decimal integer/u],
    ["duplicate", ["DEFAULT_TIMEOUT_MS=420000"], { DEFAULT_TIMEOUT_MS: "480000" },
      /config key is duplicated: DEFAULT_TIMEOUT_MS/u],
  ]) {
    await writeConfig("atlas", extra, override);
    await clearLog();
    result = runSupervisor("start", "atlas", await dockerState("atlas"));
    assert.notEqual(result.status, 0, `${name} DEFAULT_TIMEOUT_MS must fail`);
    assert.match(result.stderr, expected);
    assert.equal((await records()).length, 0, `${name} DEFAULT_TIMEOUT_MS must fail before Docker`);
  }
  await writeConfig("atlas");
  process.stdout.write("default timeout: 86400000 default and 480000 override exported; invalid values rejected before Docker\n");

  // DECISIONES_URL is optional, exported verbatim when valid and rejected before Docker otherwise.
  assert(!timeoutOverrideFinal.argv.some((value) => value.startsWith("CAUCE_DECISIONES_URL=")));
  for (const [url, valid] of [["https://100.64.0.11:8447", true], ["http://100.64.0.11:8447", false], ["https://h:8447/v1", false], ["https://u@h:8447", false]]) {
    await writeConfig("atlas", [`DECISIONES_URL=${url}`]);
    await clearLog();
    result = runSupervisor("start", "atlas", await dockerState("atlas"));
    const exported = (await records()).find(({ argv }) => argv[0] === "exec" && argv.includes("CAUCE_ALIAS=atlas"));
    assert.equal(result.status === 0 && exported?.argv.includes(`CAUCE_DECISIONES_URL=${url}`) === true, valid, `${url}: ${result.stderr}`);
    if (!valid) assert.match(result.stderr, /DECISIONES_URL must be a bare https origin/u);
  }
  await writeConfig("atlas");

  // SHARED_HUMANS is optional, exported verbatim as CAUCE_SHARED_HUMAN_IDS when every entry is an exact tenant:uuid.
  assert(!timeoutOverrideFinal.argv.some((value) => value.startsWith("CAUCE_SHARED_HUMAN_IDS=")));
  const steven = "Steven:78c81e05-0c18-427b-b02b-346d7e8c8508";
  for (const [humans, valid] of [[steven, true], [`${steven},Isa:0b6f1c8e-2a44-4c1b-9f6d-3e1a2b3c4d5e`, true],
    [steven.toUpperCase(), false], [`${steven},`, false], [`${steven} `, false], ["78c81e05-0c18-427b-b02b-346d7e8c8508", false],
    ["Steven:78c81e05-0c18-427b-b02b-346d7e8c850", false], [`${steven};Miguel:x`, false]]) {
    await writeConfig("atlas", [`SHARED_HUMANS=${humans}`]);
    await clearLog();
    result = runSupervisor("start", "atlas", await dockerState("atlas"));
    const exported = (await records()).find(({ argv }) => argv[0] === "exec" && argv.includes("CAUCE_ALIAS=atlas"));
    assert.equal(result.status === 0 && exported?.argv.includes(`CAUCE_SHARED_HUMAN_IDS=${humans}`) === true, valid, `${humans}: ${result.stderr}`);
    if (!valid) assert.match(result.stderr, /SHARED_HUMANS must be tenant:lowercase-uuid/u);
  }
  await writeConfig("atlas");

  // Claude containers are upgraded independently, so the version pin belongs to each alias config and
  // must be exact; a source-global version would reject two healthy containers whose images differ.
  await writeConfig("zeus", [], {}, ["EXPECTED_CLI_VERSION"]);
  await clearLog();
  result = runSupervisor("start", "zeus", await dockerState("zeus"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /claude requires EXPECTED_CLI_VERSION/u);
  assert.equal((await records()).length, 0, "missing Claude version must fail before Docker");

  await writeConfig("zeus", [], { EXPECTED_CLI_VERSION: "2.1" });
  await clearLog();
  result = runSupervisor("start", "zeus", await dockerState("zeus"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exact semantic version/u);
  assert.equal((await records()).length, 0, "malformed Claude version must fail before Docker");

  await writeConfig("zeus");
  await clearLog();
  result = runSupervisor("start", "zeus", await dockerState("zeus"));
  assert.equal(result.status, 0, result.stderr);
  const claudeVersionProbe = (await records()).find(({ argv }) =>
    argv[0] === "exec" && argv.includes("bash") && argv.some((value) => value.includes("required_ver=\"2.1.220\"")));
  assert(claudeVersionProbe, "Claude version probe must use the alias-specific exact pin");
  process.stdout.write("claude version: alias-specific exact pin required and probed\n");

  // claude/codex without isolation export their default CONFIG_DIR so runtime_facts measurement
  // (and profile writing from the console) sees them. zeus is claude without isolation: default $HOME/.claude.
  await clearLog();
  result = runSupervisor("start", "zeus", await dockerState("zeus"));
  assert.equal(result.status, 0, result.stderr);
  const zeusFinal = (await records()).find(({ argv }) => argv[0] === "exec" && argv.includes("CAUCE_ALIAS=zeus"));
  assert(zeusFinal?.argv.includes("CLAUDE_CONFIG_DIR=/home/dev/.claude"),
    "claude sin aislar exporta su CLAUDE_CONFIG_DIR por defecto para que runtime_facts lo mida");
  process.stdout.write("claude/codex sin aislar: CONFIG_DIR por defecto exportado para runtime_facts\n");

  // OpenClaw's mandatory persistent path is its workspace, not a CLI-version pin; a plain
  // start with no per-alias config-directory switch must still succeed under cli transport.
  await clearLog();
  result = runSupervisor("start", "argos", await dockerState("argos"));
  assert.equal(result.status, 0, result.stderr);
  const argosFinal = (await records()).find(({ argv }) => argv[0] === "exec" && argv.includes("CAUCE_ALIAS=argos"));
  assert(argosFinal?.argv.includes("CAUCE_OPENCLAW_WORKSPACE=/home/dev/clawd"));
  assert(argosFinal?.argv.includes("CAUCE_OPENCLAW_TRANSPORT=cli"));
  process.stdout.write("argos openclaw defaults: workspace-only persistence starts under cli transport\n");

  // ---- Shared session: a single conversation in the terminal and in Telegram. ----
  // The switch only exists for claude and codex, only accepts the exact value 1, and when on it must
  // reach the adapter with a usable TERM (else tmux creates the session unknown-terminal and broken).
  await writeConfig("atlas", ["SHARED_SESSION=1", "SHARED_SESSION_WORKSPACE=/workspace"]);
  await clearLog();
  result = runSupervisor("start", "atlas", await dockerState("atlas"));
  assert.equal(result.status, 0, `shared session must start: ${result.stderr}`);
  const sharedFinal = (await records()).find(({ argv }) => argv[0] === "exec" && argv.includes("CAUCE_ALIAS=atlas"));
  assert(sharedFinal?.argv.includes("CAUCE_SHARED_SESSION=1"));
  assert(sharedFinal?.argv.includes("CAUCE_SHARED_SESSION_WORKSPACE=/workspace"));
  assert(sharedFinal?.argv.includes("TERM=xterm-256color"),
    "con sesión compartida el adaptador necesita un TERM utilizable para crear la sesión tmux");
  const workspaceExistsCall = (await records()).find(({ argv }) => argv[0] === "exec"
    && argv.includes("test") && argv.includes("-d") && argv.includes("/workspace"));
  assert(workspaceExistsCall, "SHARED_SESSION debe comprobar que el workspace existe (docker exec test -d)");

  await writeConfig("zeus", ["SHARED_SESSION=1"]);
  await clearLog();
  result = runSupervisor("start", "zeus", await dockerState("zeus"));
  assert.notEqual(result.status, 0, "sin SHARED_SESSION_WORKSPACE debe validar igual el default /workspace");
  assert.match(result.stderr, /required harness path/u);
  await writeConfig("zeus");

  // Without the switch, the behavior is byte-for-byte the same as always.
  await writeConfig("atlas");
  await clearLog();
  result = runSupervisor("start", "atlas", await dockerState("atlas"));
  assert.equal(result.status, 0, result.stderr);
  const plainFinal = (await records()).find(({ argv }) => argv[0] === "exec" && argv.includes("CAUCE_ALIAS=atlas"));
  assert(!plainFinal?.argv.some((value) => value.startsWith("CAUCE_SHARED_SESSION")),
    "sin SHARED_SESSION no se exporta ninguna variable de sesión compartida");
  assert(!plainFinal?.argv.some((value) => value.startsWith("TERM=")),
    "sin sesión compartida el entorno del adaptador no cambia");

  for (const [name, extra, expected] of [
    ["valor distinto de 1", ["SHARED_SESSION=true"], /SHARED_SESSION must be exactly 1/u],
    ["workspace relativo", ["SHARED_SESSION=1", "SHARED_SESSION_WORKSPACE=workspace"],
      /SHARED_SESSION_WORKSPACE must be a canonical absolute path/u],
    ["workspace sin interruptor", ["SHARED_SESSION_WORKSPACE=/workspace"],
      /SHARED_SESSION_WORKSPACE requires SHARED_SESSION=1/u],
    ["perfil nativo con sesión compartida",
      ["SHARED_SESSION=1", "SHARED_SESSION_WORKSPACE=/workspace", "CAUCE_NATIVE_PROFILE_CONTEXT=1"],
      /CAUCE_NATIVE_PROFILE_CONTEXT is incompatible with SHARED_SESSION/u],
  ]) {
    await writeConfig("atlas", extra);
    await clearLog();
    result = runSupervisor("start", "atlas", await dockerState("atlas"));
    assert.notEqual(result.status, 0, `${name} debe fallar`);
    assert.match(result.stderr, expected);
    assert.equal((await records()).length, 0, `${name} debe fallar antes de tocar Docker`);
  }

  // A harness without a shareable TUI cannot declare the switch: accepting it would leave an
  // alias convinced it is sharing a conversation that does not exist.
  await writeConfig("iza", ["SHARED_SESSION=1"]);
  await clearLog();
  result = runSupervisor("start", "iza", await dockerState("iza"));
  assert.notEqual(result.status, 0, "openclaw no tiene sesión compartida");
  assert.match(result.stderr, /config key is not allowed for openclaw: SHARED_SESSION/u);
  await writeConfig("iza");
  await writeConfig("atlas");
  process.stdout.write("shared session: switch exported with TERM for claude/codex, rejected elsewhere and for non-1 values\n");

  // grok: the shared TUI needs tmux inside the container. Without it the alias keeps serving the
  // bus headless and says so (it used to die with 78, never restarted, and Telegram went mute).
  // SHARED_SESSION_NATIVE_ID names the conversation the adapter seeds with its own release.
  const hadesId = "01a0cedb-d05a-7e81-b400-1d58836be1cc";
  const grokShared = ["SHARED_SESSION=1", "SHARED_SESSION_WORKSPACE=/home/claw", `SHARED_SESSION_NATIVE_ID=${hadesId}`];
  await writeConfig("hades", grokShared);
  await clearLog();
  result = runSupervisor("start", "hades", await dockerState("hades"));
  assert.equal(result.status, 0, `grok shared session must start: ${result.stderr}`);
  const hadesFinal = (await records()).find(({ argv }) => argv[0] === "exec" && argv.includes("CAUCE_ALIAS=hades"));
  assert(hadesFinal?.argv.includes("CAUCE_SHARED_SESSION=1"));
  assert(hadesFinal?.argv.includes(`CAUCE_SHARED_SESSION_NATIVE_ID=${hadesId}`));
  assert(hadesFinal?.argv.includes("GROK_HOME=/home/claw/.grok"));

  await clearLog();
  result = runSupervisor("start", "hades", await dockerState("hades", { tmuxMissing: true }));
  assert.equal(result.status, 0, `grok without tmux must still serve the bus: ${result.stderr}`);
  assert.match(result.stderr, /SHARED_SESSION=1 ignored for hades: the container has no tmux/u);
  const headlessFinal = (await records()).find(({ argv }) => argv[0] === "exec" && argv.includes("CAUCE_ALIAS=hades"));
  assert(headlessFinal !== undefined, "the adapter starts");
  assert(!headlessFinal.argv.some((value) => value.startsWith("CAUCE_SHARED_SESSION")),
    "without tmux no shared-session variable reaches the adapter");

  for (const [alias, extra, expected] of [
    ["hades", ["SHARED_SESSION=1", "SHARED_SESSION_NATIVE_ID=../01a0cedb"], /SHARED_SESSION_NATIVE_ID must be a canonical lowercase UUID/u],
    ["hades", [`SHARED_SESSION_NATIVE_ID=${hadesId}`], /SHARED_SESSION_NATIVE_ID requires SHARED_SESSION=1/u],
    ["atlas", ["SHARED_SESSION=1", `SHARED_SESSION_NATIVE_ID=${hadesId}`], /config key is not allowed for codex: SHARED_SESSION_NATIVE_ID/u],
  ]) {
    await writeConfig(alias, extra);
    await clearLog();
    result = runSupervisor("start", alias, await dockerState(alias));
    assert.notEqual(result.status, 0, `${alias} ${extra.join(" ")} must fail`);
    assert.match(result.stderr, expected);
    assert.equal((await records()).length, 0, "it must fail before touching Docker");
    await writeConfig(alias);
  }
  process.stdout.write("grok shared session: native id exported, headless without tmux, native id validated\n");

  const nativeProfileContextGatedByValueNotByPresence = [
    ["zeus", "1", true], ["argos", "1", true], ["atlas", "0", true], ["atlas", "1", false],
  ];
  for (const [alias, value, starts] of nativeProfileContextGatedByValueNotByPresence) {
    await writeConfig(alias, [`CAUCE_NATIVE_PROFILE_CONTEXT=${value}`]);
    await clearLog();
    result = runSupervisor("start", alias, await dockerState(alias));
    assert.equal(result.status === 0, starts, `${alias} con el flag en ${value} decide por VALOR, no por presencia de la clave: ${result.stderr}`);
    if (starts) {
      const nativeFinal = (await records()).find(({ argv }) => argv[0] === "exec" && argv.includes(`CAUCE_ALIAS=${alias}`));
      assert(nativeFinal?.argv.includes(`CAUCE_NATIVE_PROFILE_CONTEXT=${value}`), `el valor validado llega al adaptador de ${alias}`);
    } else {
      assert.match(result.stderr, /CAUCE_NATIVE_PROFILE_CONTEXT requires the claude or openclaw harness/u);
      assert.equal((await records()).length, 0, "el SDK construye ese contexto en el constructor del adaptador y lanza fuera de claude/openclaw: la compuerta cierra antes de tocar Docker");
    }
    await writeConfig(alias);
  }
  process.stdout.write("native profile context: el 1 solo arranca en claude/openclaw; un 0 ya escrito en el .env sigue arrancando en cualquier arnes\n");

  // ---- Per-alias configuration: each alias with its OWN configuration directory. ----
  // Shared container homes require per-alias profiles; omission must fail before Docker.
  await writeConfig("atlas", [], {}, ["CONFIG_POR_ALIAS"]);
  await clearLog();
  result = runSupervisor("start", "atlas", await dockerState("atlas"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /multi-alias container requires CONFIG_POR_ALIAS=1/u);
  assert.equal((await records()).length, 0, "missing isolation policy must fail before Docker");

  await writeConfig("atlas");
  await clearLog();
  result = runSupervisor("start", "atlas", await dockerState("atlas"));
  assert.equal(result.status, 0, `config por alias debe arrancar: ${result.stderr}`);
  const conInterruptor = (await records()).find(({ argv }) => argv[0] === "exec" && argv.includes("CAUCE_ALIAS=atlas"));
  // atlas is codex and its mapped home is /home/dev. The path is DERIVED from the alias: the
  // same one computed by ops/scripts/separar-config-alias.mjs, which copies the files there.
  assert(conInterruptor?.argv.includes("CODEX_HOME=/home/dev/.local/share/cauce-v3/config/atlas/.codex"),
    "el interruptor tiene que exportar el directorio derivado del alias");
  assert(!conInterruptor?.argv.some((value) => value.startsWith("CLAUDE_CONFIG_DIR=")),
    "un alias codex no puede recibir además la variable de claude");

  await writeConfig("atlas", ["CREDENTIAL_HOME=/mnt/atlas-credentials/.codex"]);
  await clearLog();
  result = runSupervisor("start", "atlas", await dockerState("atlas"));
  assert.equal(result.status, 0, `CONFIG_POR_ALIAS + CREDENTIAL_HOME debe arrancar: ${result.stderr}`);
  assert.match(result.stderr, /CONFIG_POR_ALIAS overrides CREDENTIAL_HOME for atlas/u, "el solapamiento se anuncia");
  const credentialFinal = (await records()).find(({ argv }) => argv[0] === "exec" && argv.includes("CAUCE_ALIAS=atlas"));
  assert.equal(credentialFinal?.argv.filter((value) => value.startsWith("CODEX_HOME=")).at(-1), "CODEX_HOME=/home/dev/.local/share/cauce-v3/config/atlas/.codex", "gana el directorio por alias");
  await writeConfig("atlas");

  for (const [name, value, expected] of [
    ["valor distinto de 1", "true", /CONFIG_POR_ALIAS must be exactly 1/u],
    ["valor 0", "0", /CONFIG_POR_ALIAS must be exactly 1/u],
  ]) {
    await writeConfig("atlas", [], { CONFIG_POR_ALIAS: value });
    await clearLog();
    result = runSupervisor("start", "atlas", await dockerState("atlas"));
    assert.notEqual(result.status, 0, `${name} debe fallar`);
    assert.match(result.stderr, expected);
    assert.equal((await records()).length, 0, `${name} debe fallar antes de tocar Docker`);
  }

  // A harness that does not read any directory governed by a variable cannot declare the switch:
  // exporting it would move a directory no one reads and leave someone convinced it is separated.
  await writeConfig("iza", ["CONFIG_POR_ALIAS=1"]);
  await clearLog();
  result = runSupervisor("start", "iza", await dockerState("iza"));
  assert.notEqual(result.status, 0, "openclaw no lee ~/.codex ni ~/.claude");
  assert.match(result.stderr, /config key is not allowed for openclaw: CONFIG_POR_ALIAS/u);
  await writeConfig("iza");

  await writeConfig("jarvis", [
    "OPENCLAW_TRANSPORT=api",
    "OPENCLAW_API_URL=http://127.0.0.1:18789/v1/chat/completions",
    "OPENCLAW_TOKEN_FILE=/opt/cauce-v3-secrets/jarvis/openclaw-token",
    "CONFIG_POR_ALIAS=1",
  ]);
  await clearLog();
  result = runSupervisor("start", "jarvis", await dockerState("jarvis"));
  assert.notEqual(result.status, 0, "openclaw no lee ~/.codex ni ~/.claude");
  assert.match(result.stderr, /config key is not allowed for openclaw: CONFIG_POR_ALIAS/u);
  await writeConfig("jarvis", [
    "OPENCLAW_TRANSPORT=api",
    "OPENCLAW_API_URL=http://127.0.0.1:18789/v1/chat/completions",
    "OPENCLAW_TOKEN_FILE=/opt/cauce-v3-secrets/jarvis/openclaw-token",
  ]);
  await writeConfig("atlas");
  process.stdout.write("config por alias: mandatory for multi-alias containers, derived per alias, rejected outside claude/codex\n");

  // ---- Bundle layout regression guard: mini-monorepo vs legacy root layout. ----
  // The real production bundle ships adapters at packages/adapter-sdk/dist/src/bin/<harness>.js; the
  // supervisor must resolve exactly that path. Positive: the standard fixture uses that layout.
  await clearLog();
  assert.equal(runSupervisor("start", "atlas", await dockerState("atlas")).status, 0,
    "packages/adapter-sdk/dist/src/bin layout must pass validate_bundle");
  process.stdout.write("layout guard: packages/adapter-sdk/dist/src/bin bundle accepted by validate_bundle\n");
  // Negative: a bundle carrying only the legacy root layout dist/src/bin/<harness>.js (WITHOUT the
  // packages/adapter-sdk prefix) must be rejected as the missing executable adapter, before any copy.
  const legacyRoot = path.join(temporary, "bundle-legacy-layout");
  const legacyRelease = path.join(legacyRoot, "releases/release-legacy");
  await mkdir(path.join(legacyRelease, "dist/src/bin"), { recursive: true, mode: 0o700 });
  await executable(path.join(legacyRelease, "dist/src/bin/codex.js"), "#!/usr/bin/env node\n");
  for (const directory of [
    "releases/release-legacy/dist/src/bin",
    "releases/release-legacy/dist/src",
    "releases/release-legacy/dist",
    "releases/release-legacy",
  ]) await chmod(path.join(legacyRoot, directory), 0o555);
  const legacyDigest = bundleDigestFor(legacyRelease);
  await clearLog();
  const legacyConfig = {
    BUNDLE_RELEASE: "release-legacy",
    BUNDLE_SHA256: legacyDigest,
    PKI_DIR: `${pkiRoot}/atlas`,
    RELAY_URL: "wss://gateway.example.invalid/v3/ws",
    EXPECTED_IMAGE_ID: imageId,
    CAUCE_SEMBRAR_PERFIL: "1",
    CONFIG_POR_ALIAS: "1",
  };
  await writeFile(path.join(configRoot, "atlas.env"),
    `${Object.entries(legacyConfig).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
  await chmod(path.join(configRoot, "atlas.env"), 0o600);
  const legacyEnv = { ...environment(await dockerState("atlas")), CAUCE_CONTAINER_BUNDLE_ROOT: legacyRoot };
  result = spawnSync(supervisor, ["start", "atlas"], { encoding: "utf8", env: legacyEnv });
  assert.notEqual(result.status, 0, "legacy dist/src/bin layout (no packages/adapter-sdk) must fail validate_bundle");
  assert.match(result.stderr, /bundle does not contain the assigned executable adapter/u);
  assert.equal((await records()).some(({ argv }) => argv[0] === "cp"), false,
    "a layout-rejected bundle must fail before any container copy");
  await writeConfig("atlas");
  // Restore write bits on the immutable legacy fixture so the final recursive cleanup can remove it.
  for (const directory of [
    "releases/release-legacy",
    "releases/release-legacy/dist",
    "releases/release-legacy/dist/src",
    "releases/release-legacy/dist/src/bin",
  ]) await chmod(path.join(legacyRoot, directory), 0o755).catch(() => undefined);
  process.stdout.write("layout guard: legacy dist/src/bin bundle rejected by validate_bundle before any copy\n");

  // OpenClaw receives only a token-file path, never the bearer token itself.
  await clearLog();
  statePath = await dockerState("jarvis");
  result = runSupervisor("start", "jarvis", statePath);
  assert.equal(result.status, 0, result.stderr);
  calls = await records();
  const jarvisFinal = calls.find(({ argv }) => argv[0] === "exec" && argv.includes("CAUCE_ALIAS=jarvis"));
  assert(jarvisFinal?.argv.includes("CAUCE_TOKEN_FILE=/opt/cauce-v3-secrets/jarvis/token"),
    "bearer-enabled alias must export its copied CAUCE_TOKEN_FILE path");
  assert(jarvisFinal?.argv.includes("CAUCE_OPENCLAW_TOKEN_FILE=/opt/cauce-v3-secrets/jarvis/openclaw-token"));
  assert(jarvisFinal?.argv.includes("CAUCE_DEFAULT_TIMEOUT_MS=86400000"),
    "OpenClaw agentic work defaults to 24 hours while its central claim is renewed");
  assert.equal(jarvisFinal?.argv.some((value) => value.includes("FAKE_OPENCLAW_TOKEN")), false);

  // OpenClaw CLI transport with a GLOBAL dist dir: openclaw can be installed system-wide, so
  // OPENCLAW_DIST_DIR need not live below the mapped user home — any canonical absolute path is
  // accepted and exported verbatim. CLI transport also requires no openclaw-token in the PKI dir.
  await rm(path.join(pkiRoot, "jarvis/openclaw-token"));
  await writeConfig("jarvis", ["OPENCLAW_TRANSPORT=cli", "OPENCLAW_DIST_DIR=/usr/lib/node_modules/openclaw/dist"]);
  await clearLog();
  result = runSupervisor("start", "jarvis", await dockerState("jarvis"));
  assert.equal(result.status, 0, `global OPENCLAW_DIST_DIR (cli) must start: ${result.stderr}`);
  const jarvisCliFinal = (await records()).find(({ argv }) => argv[0] === "exec" && argv.includes("CAUCE_ALIAS=jarvis"));
  assert(jarvisCliFinal?.argv.includes("CAUCE_OPENCLAW_TRANSPORT=cli"));
  assert(jarvisCliFinal?.argv.includes("CAUCE_OPENCLAW_DIST_DIR=/usr/lib/node_modules/openclaw/dist"),
    "a global (non-home) OPENCLAW_DIST_DIR must be accepted and exported verbatim");
  // Restore the jarvis API fixture (token file + config) for a pristine post-test state.
  await writeFile(path.join(pkiRoot, "jarvis/openclaw-token"), "FAKE_OPENCLAW_TOKEN\n");
  await chmod(path.join(pkiRoot, "jarvis/openclaw-token"), 0o600);
  await writeConfig("jarvis", [
    "OPENCLAW_TRANSPORT=api",
    "OPENCLAW_API_URL=http://127.0.0.1:18789/v1/chat/completions",
    "OPENCLAW_TOKEN_FILE=/opt/cauce-v3-secrets/jarvis/openclaw-token",
  ]);
  process.stdout.write("openclaw dist dir: global /usr/lib/node_modules/openclaw/dist accepted under cli transport\n");

  await clearLog();
  statePath = await dockerState("iza");
  result = runSupervisor("start", "iza", statePath);
  assert.equal(result.status, 0, result.stderr);
  const izaFinal = (await records()).find(({ argv }) => argv[0] === "exec" && argv.includes("CAUCE_ALIAS=iza"));
  assert(izaFinal?.argv.includes("CAUCE_OPENCLAW_WORKSPACE=/home/claw/clawd"));
  assert(izaFinal?.argv.includes("CAUCE_OPENCLAW_TRANSPORT=cli"));

  // Each alias consumes its exact BUNDLE_RELEASE pin. A canary pin for iza must copy and
  // execute release-2 directly, without consulting or changing a shared host `current` pointer.
  await writeConfig("iza", [], {
    BUNDLE_RELEASE: "release-2",
    BUNDLE_SHA256: bundleDigest2,
  });
  await clearLog();
  result = runSupervisor("start", "iza", await dockerState("iza", { bundleDigest: bundleDigest2 }));
  assert.equal(result.status, 0, `independently pinned release-2 must start: ${result.stderr}`);
  calls = await records();
  assert(calls.some(({ argv }) => argv[0] === "cp" && argv[1] === `${release2}/.`),
    "supervisor must copy the alias-pinned release directory");
  assert.equal(calls.some(({ argv }) => argv[0] === "cp" && argv[1] === `${release}/.`), false,
    "supervisor must not fall back to another alias release");
  const pinnedIzaFinal = calls.find(({ argv }) => argv[0] === "exec" && argv.includes("CAUCE_ALIAS=iza"));
  assert(pinnedIzaFinal?.argv.includes("/opt/cauce-v3-adapter/iza/releases/release-2"));
  assert(pinnedIzaFinal?.argv.includes(bundleDigest2));
  assert.equal(calls.some(({ argv }) => argv.includes("ln") && argv.some((value) => value.includes("current"))), false,
    "supervisor must not create a mutable current symlink");
  await writeConfig("iza");
  process.stdout.write("per-alias release pin: iza release-2 selected directly without a current symlink\n");

  // Image is mandatory; the label and MOUNT_* keys are optional reinforcement, each must match when
  // declared. The persistent mount CONTAINS the state dir, so a bad/missing ancestor fails before PKI.
  for (const [name, override, expected] of [
    ["image", { imageId: `sha256:${"f".repeat(64)}` }, /image ID/u],
    ["label", { labelValue: "wrong" }, /label/u],
    ["tmpfs", { mounts: [{ Type: "tmpfs", Source: "", Destination: aliasMount.atlas, RW: true }] }, /mount/u],
    ["source", { mounts: [{ Type: "bind", Source: "/wrong", Destination: aliasMount.atlas, RW: true }] }, /mount/u],
    ["readonly", { mounts: [{ Type: "bind", Source: `${mountSourceRoot}/atlas`, Destination: aliasMount.atlas, RW: false }] }, /mount/u],
    ["no-ancestor", { mounts: [{ Type: "bind", Source: `${mountSourceRoot}/atlas`, Destination: "/unrelated/mount", RW: true }] }, /mount/u],
  ]) {
    await clearLog();
    statePath = await dockerState("atlas", override);
    result = runSupervisor("start", "atlas", statePath);
    assert.notEqual(result.status, 0, `${name} policy must fail`);
    assert.match(result.stderr, expected);
    assert.equal((await records()).some(({ argv }) => argv[0] === "cp"), false);
  }

  // A persistent state mount does not make an ephemeral harness home acceptable: Codex auth/config
  // live on a separate mounted home and must survive the same container recreation as the state.
  await clearLog();
  statePath = await dockerState("atlas", { mounts: [{
    Type: "bind", Source: `${mountSourceRoot}/atlas`, Destination: aliasMount.atlas, RW: true,
  }] });
  result = runSupervisor("start", "atlas", statePath);
  assert.notEqual(result.status, 0, "state persistence without persistent Codex auth/config must fail");
  assert.match(result.stderr, /required harness path/u);
  assert.equal((await records()).some(({ mutating }) => mutating), false,
    "harness persistence must fail before any Docker mutation");

  // The on-disk isolated layout is rechecked by start/check, not trusted merely because the env points
  // to its directory. The fake models a broken/missing identity or a link redirected away from source.
  await clearLog();
  result = runSupervisor("start", "atlas", await dockerState("atlas", { isolatedConfigOk: false }));
  assert.notEqual(result.status, 0, "a broken isolated config must fail closed");
  assert.match(result.stderr, /isolated harness configuration verification failed/u);
  assert.equal((await records()).some(({ mutating }) => mutating), false,
    "isolated config verification must precede helper/state/bundle/PKI mutation");

  // A declared volume-name that differs from the discovered mount fails before any copy.
  await writeConfig("atlas", [], {
    MOUNT_TYPE: "volume",
    MOUNT_SOURCE: `${mountSourceRoot}/atlas-volume`,
    MOUNT_NAME: "expected-atlas-volume",
  });
  await clearLog();
  statePath = await dockerState("atlas", { mounts: [{
    Type: "volume",
    Source: `${mountSourceRoot}/atlas-volume`,
    Name: "wrong-volume-name",
    Destination: aliasMount.atlas,
    RW: true,
  }] });
  result = runSupervisor("start", "atlas", statePath);
  assert.notEqual(result.status, 0);
  assert.equal((await records()).some(({ argv }) => argv[0] === "cp"), false);
  await writeConfig("atlas");

  // `check` is a complete read-only preflight: it revalidates host PKI before accepting
  // lifecycle metadata.  Missing PKI cannot be hidden behind a healthy old adapter process.
  await rm(path.join(pkiRoot, "atlas/ca.crt"));
  await clearLog();
  result = runSupervisor("check", "atlas", await dockerState("atlas"));
  assert.notEqual(result.status, 0, "check must reject missing PKI");
  assert.equal((await records()).some(({ argv }) => argv.includes("check")), false,
    "lifecycle check must not run after PKI preflight failure");
  await writeFile(path.join(pkiRoot, "atlas/ca.crt"), "fake-ca\n");
  await chmod(path.join(pkiRoot, "atlas/ca.crt"), 0o600);

  await clearLog();
  result = runSupervisor("check", "atlas", await dockerState("atlas"));
  assert.equal(result.status, 0, `full check must pass: ${result.stderr}`);
  process.stdout.write("complete check: PKI precedes lifecycle metadata\n");

  // Optional-key omission still starts. First: image ID correct, NO label declared, so the
  // label check is skipped even though the container reports an unverified label value.
  await clearLog();
  await writeConfig("atlas", [], {}, ["EXPECTED_LABEL_KEY", "EXPECTED_LABEL_VALUE"]);
  assert.equal(runSupervisor("start", "atlas", await dockerState("atlas", { labelValue: "unverified" })).status, 0,
    "an image-verified container with no declared label must start");
  // Second: no MOUNT_* declared at all -- the supervisor discovers the ancestor bind itself
  // and bounds safe state creation to it.
  await clearLog();
  await writeConfig("atlas", [], {}, ["EXPECTED_LABEL_KEY", "EXPECTED_LABEL_VALUE", "MOUNT_TYPE", "MOUNT_SOURCE", "MOUNT_DESTINATION", "MOUNT_RW"]);
  result = runSupervisor("start", "atlas", await dockerState("atlas"));
  assert.equal(result.status, 0, `discovery-only config must start: ${result.stderr}`);
  assert((await records()).some(({ argv }) => argv.includes("prepare-state") && argv.includes(aliasMount.atlas) && argv.includes(aliasState.atlas)),
    "prepare-state must bound creation to the discovered ancestor mount, not the state dir");
  await writeConfig("atlas");

  // Alias/path/config injection remains fail-closed before Docker.
  await clearLog();
  result = runSupervisor("start", "atlas;bad", await dockerState("atlas"));
  assert.notEqual(result.status, 0);
  assert.equal((await records()).length, 0);
  await writeFile(path.join(configRoot, "atlas.env"), "BUNDLE_RELEASE=../escape\nEVIL=$(touch /tmp/pwned)\n");
  await chmod(path.join(configRoot, "atlas.env"), 0o600);
  await clearLog();
  result = runSupervisor("start", "atlas", await dockerState("atlas"));
  assert.notEqual(result.status, 0);
  assert.equal((await records()).length, 0);
  await writeConfig("atlas");

  // atlas and kratos share ONE persistent bind (/home/dev/.local, one Source) in ws-humanizar. Each
  // alias state dir is a disjoint subtree, so both discover the same mount without colliding.
  await clearLog();
  const sharedSource = `${mountSourceRoot}/ws-humanizar-dot-local`;
  const sharedBind = [
    { Type: "bind", Source: sharedSource, Destination: "/home/dev/.local", RW: true },
    { Type: "bind", Source: `${mountSourceRoot}/ws-humanizar-codex`, Destination: "/home/dev/.codex", RW: true },
    { Type: "bind", Source: `${mountSourceRoot}/ws-humanizar-claude`, Destination: "/home/dev/.claude", RW: true },
    { Type: "bind", Source: `${mountSourceRoot}/ws-humanizar-claude-json`, Destination: "/home/dev/.claude.json", RW: true },
  ];
  await writeConfig("atlas", [], { MOUNT_SOURCE: sharedSource, MOUNT_DESTINATION: aliasMount.atlas });
  await writeConfig("kratos", [], { MOUNT_SOURCE: sharedSource, MOUNT_DESTINATION: aliasMount.kratos });
  let arranqueCompartido = runSupervisor("start", "atlas", await dockerState("atlas", { mounts: sharedBind }));
  assert.equal(arranqueCompartido.status, 0, `atlas compartiendo .local: ${arranqueCompartido.stderr}`);
  arranqueCompartido = runSupervisor("start", "kratos", await dockerState("kratos", { mounts: sharedBind }));
  assert.equal(arranqueCompartido.status, 0, `kratos compartiendo .local: ${arranqueCompartido.stderr}`);
  calls = await records();
  assert(calls.some(({ argv }) => argv.some((value) => value.includes("/opt/cauce-v3-adapter/atlas/"))));
  assert(calls.some(({ argv }) => argv.some((value) => value.includes("/opt/cauce-v3-adapter/kratos/"))));
  assert(calls.some(({ argv }) => argv.includes("prepare-state") && argv.includes(aliasState.atlas)));
  assert(calls.some(({ argv }) => argv.includes("prepare-state") && argv.includes(aliasState.kratos)));
  assert.equal(calls.some(({ argv }) => argv.includes("rm") && argv.includes("/opt/cauce-v3-adapter")), false);
  await writeConfig("atlas");
  await writeConfig("kratos");

  // Recreate with same declared mount relaunches on the new ID and retains state/instance identity.
  await clearLog();
  assert.equal(runSupervisor("start", "atlas", await dockerState("atlas", { currentId: firstId })).status, 0);
  assert.equal(runSupervisor("start", "atlas", await dockerState("atlas", { currentId: secondId, replacementId: firstId, startedAt: secondGenerationStartedAt })).status, 0);
  calls = await records();
  const relaunches = calls.filter(({ argv }) => argv[0] === "exec" && argv.includes("CAUCE_ALIAS=atlas"));
  assert.equal(relaunches.length, 2);
  assert(relaunches[0].argv.includes(`CAUCE_CONTAINER_ID=${firstId}`));
  assert(relaunches[1].argv.includes(`CAUCE_CONTAINER_ID=${secondId}`));
  assert(relaunches.every(({ argv }) => argv.includes(`CAUCE_STATE_DIR=${aliasState.atlas}`) && argv.includes("CAUCE_INSTANCE_ID=systemd-container-atlas")));

  // Every mutating Docker step aborts a recreate race without applying to the replacement ID.
  await clearLog();
  statePath = await dockerState("atlas");
  assert.equal(runSupervisor("start", "atlas", statePath).status, 0);
  const baseline = await records();
  const mutatingCalls = baseline.filter(({ mutating, applied, target }) => mutating && applied && target === firstId).map(({ call }) => call);
  assert(mutatingCalls.length > 10);
  for (let offset = 0; offset < mutatingCalls.length; offset += 4) {
    await Promise.all(mutatingCalls.slice(offset, offset + 4).map(async (raceAt) => {
      const raceLog = path.join(temporary, `recreate-race-${raceAt}.jsonl`);
      const raceState = await dockerState("atlas", { raceAt, log: raceLog });
      const raceResult = await runSupervisorAsync("start", "atlas", raceState, `recreate race at Docker call ${raceAt}`);
      assert.notEqual(raceResult.status, 0, `recreate race at Docker call ${raceAt} must abort`);
      const raced = await recordsForState(raceState);
      const injected = raced.find(({ call }) => call === raceAt);
      assert(injected, `recreate race at ${raceAt} was not reached`);
      assert.equal(injected.idBeforeRace, firstId, `recreate race at ${raceAt} did not begin on the original generation`);
      assert.equal(injected.currentId, secondId, `recreate race at ${raceAt} was not injected`);
      assert.equal(injected.mutating, true, `recreate race at ${raceAt} did not target a mutation`);
      assert.equal(injected.applied, false, `recreate race at ${raceAt} applied to the replacement generation`);
      assert.equal(raced.some(({ mutating, applied, target }) => mutating && applied && target === secondId), false,
        `race at ${raceAt} touched replacement generation`);
      assert.equal(JSON.parse(await readFile(raceState, "utf8")).currentId, secondId,
        `recreate race at ${raceAt} did not change the selected container ID`);
    }));
  }
  const guardedMutationCalls = baseline
    .filter(({ mutating, applied, target, argv }) => mutating && applied && target === firstId && argv.includes("guard-exec"))
    .map(({ call }) => call);
  assert(guardedMutationCalls.length > 10);
  for (let offset = 0; offset < guardedMutationCalls.length; offset += 4) {
    await Promise.all(guardedMutationCalls.slice(offset, offset + 4).map(async (restartRaceAt) => {
      const raceLog = path.join(temporary, `restart-race-${restartRaceAt}.jsonl`);
      const raceState = await dockerState("atlas", { restartRaceAt, log: raceLog });
      const raceResult = await runSupervisorAsync("start", "atlas", raceState, `same-ID restart race at Docker call ${restartRaceAt}`);
      assert.notEqual(raceResult.status, 0,
        `same-ID restart race at guarded call ${restartRaceAt} must abort`);
      const raced = await recordsForState(raceState);
      const injected = raced.find(({ call }) => call === restartRaceAt);
      assert(injected, `same-ID restart race at ${restartRaceAt} was not reached`);
      assert.equal(injected.mutating, true, `same-ID restart race at ${restartRaceAt} did not target a guarded mutation`);
      assert.equal(injected.applied, false, `same-ID restart at ${restartRaceAt} passed the in-container generation guard`);
      assert.equal(raced.some(({ call, mutating, applied }) => call === restartRaceAt && mutating && applied), false,
        `same-ID restart at ${restartRaceAt} passed the in-container generation guard`);
      const restartState = JSON.parse(await readFile(raceState, "utf8"));
      assert.equal(restartState.startedAt, restartState.replacementStartedAt,
        `same-ID restart race at ${restartRaceAt} was not injected`);
      assert.equal(restartState.initStarttime, restartState.replacementInitStarttime,
        `same-ID restart race at ${restartRaceAt} did not change the init generation`);
      assert.equal(restartState.restartCount, 1, `same-ID restart race at ${restartRaceAt} did not increment restart count`);
    }));
  }

  // Host flock rejects a duplicate supervisor before its first Docker operation can run.
  await clearLog();
  const flockGate = path.join(temporary, `flock-owner-${Math.random().toString(16).slice(2)}.gate`);
  statePath = await dockerState("atlas", { startGate: flockGate });
  const firstOwner = spawn(supervisor, ["start", "atlas"], { stdio: "ignore", env: environment(statePath) });
  await waitForLogOrExit(firstOwner,
    (entries) => entries.some(({ call, argv }) => call === 1 && argv[0] === "inspect"));
  result = runSupervisor("start", "atlas", statePath);
  assert.equal(result.status, 73);
  await writeFile(flockGate, "release\n");
  const firstOwnerExit = await waitForChildExit(firstOwner);
  assert.equal(firstOwnerExit.status, 0,
    `the explicit flock test owner must exit cleanly after its barrier: ${JSON.stringify(firstOwnerExit)}`);

  // Root state preparation never follows a leaf or parent symlink and leaves targets untouched.
  const safeRoot = path.join(temporary, "safe-state");
  const safeMount = path.join(safeRoot, "mount");
  const target = path.join(safeRoot, "target");
  await mkdir(safeMount, { recursive: true, mode: 0o700 });
  await mkdir(target, { mode: 0o755 });
  const originalMode = (await stat(target)).mode & 0o777;
  const leaf = path.join(safeMount, "leaf");
  await symlink(target, leaf);
  result = spawnSync("python3", [runtimeHelper, "prepare-state", "--mount", leaf, "--state", leaf,
    "--uid", String(process.getuid()), "--gid", String(process.getgid())], { encoding: "utf8" });
  assert.equal(result.status, 78);
  assert.equal((await stat(target)).mode & 0o777, originalMode);
  const parentLink = path.join(safeMount, "parent");
  await symlink(target, parentLink);
  result = spawnSync("python3", [runtimeHelper, "prepare-state", "--mount", safeMount,
    "--state", path.join(parentLink, "child"), "--uid", String(process.getuid()), "--gid", String(process.getgid())], { encoding: "utf8" });
  assert.equal(result.status, 78);
  assert.equal((await stat(target)).mode & 0o777, originalMode);

  ctx.statePath = statePath;
  ctx.result = result;
  ctx.calls = calls;
}
