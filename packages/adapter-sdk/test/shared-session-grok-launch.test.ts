import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, realpath, rename } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cliSharedSessionSpec, loadSharedSessionConfig } from "../src/shared-session/config.js";
import { isGrokSessionId, newGrokSessionId } from "../src/shared-session/grok.js";
import { SharedTuiPointerStore } from "../src/shared-session/native-pointer.js";
import { NativePointerAttestor } from "../src/shared-session/native-witness.js";
import { inputBoxState, turnInFlight } from "../src/shared-session/pane.js";
import { resolveGrokLaunch, sharedSessionResume } from "../src/shared-session/resume.js";
import { ensureSharedSession } from "../src/shared-session/session.js";
import { paneCommandMatches } from "../src/shared-session/session/identity.js";
import { correlationIdFromPrompt, envelopeText } from "./shared-session-fixtures.js";
import {
  GROK_TRUST_DIALOG,
  GrokTmux,
  THINKING,
  TOOL_RUNNING,
  grokFrame,
  grokRunner,
  grokWorkspace,
} from "./grok-shared-session-fixtures.js";

const request = (stdin: string): Parameters<ReturnType<typeof grokRunner>["run"]>[0] => ({
  command: "grok", args: [], harness: "grok", stdin, timeoutMs: 2_000, signal: new AbortController().signal,
});

test("grok pane: el pie Ctrl+c:cancel y el spinner [stop] son turno en curso; ocioso, tecleado y salida armada no", () => {
  for (const frame of [
    grokFrame({ footer: "running", spinner: THINKING }),
    grokFrame({ footer: "tool", spinner: TOOL_RUNNING }),
    grokFrame({ footer: "queued", spinner: THINKING, queue: "respondé solo: encolado" }),
    grokFrame({ footer: "idle", spinner: THINKING }),
    grokFrame({ footer: "running" }),
  ]) assert.equal(turnInFlight(frame), true, frame);
  for (const frame of [grokFrame(), grokFrame({ footer: "typed", box: "respondé solo: ho" }), grokFrame({ footer: "quit" })]) {
    assert.equal(turnInFlight(frame), false, frame);
  }
  // Conversation text that quotes the footer or a spinner is not the footer nor the spinner.
  const quoted = grokFrame({ history: [
    "     el pie dice Shift+Tab:mode  │  Ctrl+c:cancel  │  Ctrl+x:shortcuts mientras corre",
    "     y la banda termina en [stop] …",
  ] });
  assert.equal(turnInFlight(quoted), false);
});

test("grok pane: caja vacía libre (aun generando), texto o chip ocupado, diálogo de confianza modal", () => {
  assert.equal(inputBoxState(grokFrame()).kind, "free");
  assert.equal(inputBoxState(grokFrame({ footer: "running", spinner: THINKING })).kind, "free");
  assert.equal(inputBoxState(grokFrame({ footer: "typed", box: "respondé solo: ho" })).kind, "busy");
  assert.equal(inputBoxState(grokFrame({ footer: "typed", box: "[Pasted: 81 lines]" })).kind, "busy");
  assert.equal(inputBoxState(GROK_TRUST_DIALOG).kind, "modal");
});

test("grok config: GROK_HOME (o ~/.grok) llega al panel y la TUI arranca con --always-approve", () => {
  const environment = { CAUCE_SHARED_SESSION: "1", CAUCE_SHARED_SESSION_WORKSPACE: "/home/claw", HOME: "/home/claw" };
  const config = loadSharedSessionConfig("grok", "hades", "/state/hades", environment);
  assert.equal(config?.harness, "grok");
  assert.equal(config.configDirectory, "/home/claw/.grok");
  assert.deepEqual(config.paneEnvironment, { GROK_HOME: "/home/claw/.grok" });
  assert.deepEqual(config.harnessArguments, ["--always-approve"]);
  assert.equal(loadSharedSessionConfig("grok", "hades", "/s", { ...environment, GROK_HOME: "/datos/grok" })
    ?.configDirectory, "/datos/grok");
  assert.throws(() => loadSharedSessionConfig("grok", "hades", "/s", { ...environment, GROK_HOME: "rel" }),
    /GROK_HOME debe ser una ruta absoluta/u);
  assert.throws(() => loadSharedSessionConfig("hermes", "hermes", "/s", environment), /claude, codex y grok/u);
});

test("grok identidad: el panel acredita grok y rechaza cualquier otro harness compartido", () => {
  const spec = { alias: "hades", harness: "grok" as const, workspace: "/home/claw" };
  assert.equal(paneCommandMatches(spec, "exec env GROK_HOME='/home/claw/.grok' grok --always-approve --resume x"), true);
  assert.equal(paneCommandMatches(spec, "exec claude --dangerously-skip-permissions"), false);
  assert.equal(paneCommandMatches(spec, "exec grok --always-approve; codex"), false);
  assert.equal(paneCommandMatches({ ...spec, harness: "claude" }, "exec grok --always-approve"), false);
});

test("grok arranque: sin historia crea una sesión nueva con id v7; con historia y sin puntero se bloquea", async () => {
  const empty = await grokWorkspace("grok-launch-vacio", { history: false });
  const fresh = await resolveGrokLaunch(empty.grokHome, "/workspace", { alias: "hades", stateDirectory: empty.state });
  assert.equal(fresh.state, "launch");
  assert.equal(fresh.resumed, false);
  const [flag, id] = fresh.args;
  assert.equal(flag, "--session-id");
  assert.ok(id !== undefined && isGrokSessionId(id) && id[14] === "7", `id v7: ${String(id)}`);

  const legacy = await grokWorkspace("grok-launch-historia");
  const blocked = await resolveGrokLaunch(legacy.grokHome, "/workspace", { alias: "hades", stateDirectory: legacy.state });
  assert.equal(blocked.state, "blocked");
  assert.match(blocked.detail, /seed/u);
  assert.equal((await resolveGrokLaunch(legacy.grokHome, "/workspace", undefined)).state, "blocked");
});

test("grok arranque: la semilla nombra la conversación canónica una sola vez y la TUI la reanuda exacta", async () => {
  const { state, grokHome, log } = await grokWorkspace("grok-launch-semilla");
  const binding = { alias: "hades", harness: "grok" as const, configDirectory: grokHome, workspace: "/workspace" };
  const store = new SharedTuiPointerStore(state);
  assert.equal(await store.seed(binding, log.sessionId), "written");
  assert.equal(await store.seed(binding, log.sessionId), "unchanged");
  assert.equal(await store.seed(binding, newGrokSessionId()), "conflict", "una semilla nunca pisa el puntero");
  assert.deepEqual(await resolveGrokLaunch(grokHome, "/workspace", { alias: "hades", stateDirectory: state }),
    { state: "launch", args: ["--resume", log.sessionId], resumed: true });

  await chmod(dirname(log.file), 0o777);
  assert.equal((await resolveGrokLaunch(grokHome, "/workspace", { alias: "hades", stateDirectory: state })).state,
    "blocked", "una carpeta de sesión escribible por otros no se acredita");
  await chmod(dirname(log.file), 0o700);
  await rename(dirname(log.file), `${dirname(log.file)}-movida`);
  assert.equal((await resolveGrokLaunch(grokHome, "/workspace", { alias: "hades", stateDirectory: state })).state,
    "blocked", "un puntero a una sesión inexistente no lanza nada");
});

test("grok arranque: ensure crea el panel tmux con GROK_HOME y --resume del id sembrado", async () => {
  const { state, grokHome, log } = await grokWorkspace("grok-ensure");
  await new SharedTuiPointerStore(state).seed(
    { alias: "hades", harness: "grok", configDirectory: grokHome, workspace: "/workspace" }, log.sessionId);
  const tmux = new GrokTmux();
  tmux.sessionExists = false;
  const spec = cliSharedSessionSpec("grok", "hades", "/workspace", dirname(grokHome), {}, state);

  const result = await ensureSharedSession(tmux, spec, { sleep: () => Promise.resolve(), readyTimeoutMs: 30 });

  assert.equal(result.ready, true, result.detail);
  assert.equal(result.resumed, true);
  assert.equal(tmux.paneStartCommand,
    `exec env GROK_HOME='${grokHome}' grok --always-approve --resume ${log.sessionId}`);
  assert.equal(tmux.sessionOptions.get("@cauce_harness"), "grok");
});

test("grok testigo: el turno acredita el puntero, la TUI renace sobre él y un /new lo mueve con CAS", async () => {
  const { state, grokHome, sessionLog } = await grokWorkspace("grok-testigo", { history: false });
  const binding = {
    alias: "hades", harness: "grok" as const,
    configDirectory: await realpath(grokHome), workspace: await realpath("/workspace"),
  };
  const store = new SharedTuiPointerStore(state);
  const runnerFor = (tmux: GrokTmux): ReturnType<typeof grokRunner> => grokRunner({
    grokHome, tmux,
    resume: sharedSessionResume("grok", grokHome, "/workspace", { alias: "hades", stateDirectory: state }),
    nativePointer: new NativePointerAttestor(store, binding),
  });
  const tmux = new GrokTmux();
  tmux.sessionExists = false;
  const born = /--session-id (\S+)/u;
  let current = "";
  tmux.onSubmit = async (text) => {
    current ||= born.exec(tmux.paneStartCommand)?.[1] ?? "";
    const log = await sessionLog(current);
    await log.append(log.user(text), log.message("p", envelopeText("ok", correlationIdFromPrompt(text))), log.completed("p"));
  };

  assert.equal((await runnerFor(tmux).run(request("primer turno"))).exitCode, 0);
  assert.ok(isGrokSessionId(current), `la TUI nació con --session-id: ${tmux.paneStartCommand}`);
  assert.deepEqual(await store.read(binding), { state: "valid", binding, nativeId: current });
  assert.deepEqual(await resolveGrokLaunch(grokHome, "/workspace", { alias: "hades", stateDirectory: state }),
    { state: "launch", args: ["--resume", current], resumed: true }, "si la TUI muere, renace sobre ESA conversación");

  // `/new` in the TUI: the next turn lands in another session folder of the same pane.
  const previous = current;
  current = newGrokSessionId(Date.now() + 1_000);
  assert.equal((await runnerFor(tmux).run(request("tras /new"))).exitCode, 0);
  assert.notEqual(current, previous);
  assert.deepEqual(await store.read(binding), { state: "valid", binding, nativeId: current });
});

test("grok semilla por CLI: escribe una vez, repite sin cambios y rechaza una conversación inexistente", async () => {
  const { state, grokHome, log } = await grokWorkspace("grok-semilla-cli");
  const cli = fileURLToPath(new URL("../src/bin/shared-session.js", import.meta.url));
  const run = (nativeId: string, harness = "grok"): ReturnType<typeof spawnSync> => spawnSync(process.execPath, [
    cli, "seed", "--alias", "hades", "--harness", harness, "--workspace", "/workspace", "--state", state,
    "--native-id", nativeId,
  ], { encoding: "utf8", env: { ...process.env, HOME: dirname(grokHome), GROK_HOME: "" } });

  const written = run(log.sessionId);
  assert.equal(written.status, 0, String(written.stderr));
  assert.match(String(written.stdout), /"result":"written"/u);
  assert.match(String(run(log.sessionId).stdout), /"result":"unchanged"/u);
  const missing = run(newGrokSessionId());
  assert.equal(missing.status, 1);
  assert.match(String(missing.stdout), /"result":"unverified"/u);
  assert.equal(run(log.sessionId, "codex").status, 3);
});
