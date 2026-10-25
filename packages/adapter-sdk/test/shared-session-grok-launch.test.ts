import assert from "node:assert/strict";
import { access, chmod, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { loadSharedSessionConfig } from "../src/shared-session/config.js";
import { isGrokSessionId, newGrokSessionId } from "../src/shared-session/grok.js";
import { prepareGrokWorkspace } from "../src/shared-session/grok-trust.js";
import { SharedTuiPointerStore } from "../src/shared-session/native-pointer.js";
import { NativePointerAttestor } from "../src/shared-session/native-witness.js";
import { turnInFlight } from "../src/shared-session/pane.js";
import { resolveGrokLaunch, sharedSessionResume } from "../src/shared-session/resume.js";
import { paneCommandMatches } from "../src/shared-session/session/identity.js";
import { correlationIdFromPrompt, envelopeText, freshState } from "./shared-session-fixtures.js";
import {
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

async function trustProbe(projectRoot: string | null = null, durable = true) {
  const { state: root } = await freshState('grok-trust');
  const workspace = join(root, 'space', 'projects');
  const profile = join(root, 'profile');
  await mkdir(workspace, { recursive: true });
  await mkdir(profile, { mode: 0o700 });
  const command = join(root, 'grok-probe.mjs');
  await writeFile(command, `#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
const profile = process.env.GROK_HOME;
const grant = process.argv.includes('--trust');
if (grant) writeFileSync(profile + '/grant', 'yes');
if (grant && ${String(durable)}) writeFileSync(profile + '/trusted_folders.toml', 'trusted', { mode: 0o600 });
console.log(JSON.stringify({ cwd: process.cwd(), projectRoot: ${JSON.stringify(projectRoot)},
  projectTrusted: grant || existsSync(profile + '/trusted_folders.toml') }));
`, { mode: 0o700 });
  return { profile, spec: { alias: 'zz-canary-grok', harness: 'grok' as const,
    command, workspace, environment: { GROK_HOME: profile } } };
}

test('grok confianza: una raíz Git ajena al workspace aprobado bloquea antes de conceder confianza', async () => {
  const { profile, spec } = await trustProbe('/tmp');
  await assert.rejects(prepareGrokWorkspace(spec), /raíz nativa.*otro directorio/u);
  await assert.rejects(access(join(profile, 'grant')), { code: 'ENOENT' });
});

test('grok confianza: exige persistencia, conserva el límite del perfil y respeta cancelación', async () => {
  const valid = await trustProbe();
  await prepareGrokWorkspace(valid.spec);
  assert.equal((await stat(join(valid.profile, 'trusted_folders.toml'))).mode & 0o777, 0o600);
  const provisional = await trustProbe(null, false);
  await assert.rejects(prepareGrokWorkspace(provisional.spec), /no quedó persistida/u);
  const unsafe = await trustProbe();
  await chmod(unsafe.profile, 0o777);
  await assert.rejects(prepareGrokWorkspace(unsafe.spec), /directorio seguro/u);
  await assert.rejects(access(join(unsafe.profile, 'grant')), { code: 'ENOENT' });
  const worktree = await trustProbe();
  await writeFile(join(worktree.spec.workspace, '.git'), 'gitdir: /tmp/another-repository');
  await assert.rejects(prepareGrokWorkspace(worktree.spec), /comparte metadatos Git/u);
  await assert.rejects(access(join(worktree.profile, 'grant')), { code: 'ENOENT' });
  const cancelled = await trustProbe();
  await assert.rejects(prepareGrokWorkspace(cancelled.spec, AbortSignal.abort()), { name: 'AbortError' });
  await assert.rejects(access(join(cancelled.profile, 'grant')), { code: 'ENOENT' });
});

test("grok pane: el pie Ctrl+c:cancel y el spinner [stop] son turno en curso; ocioso, tecleado y salida armada no", () => {
  // Without the footer on screen (a pane cut short) the spinner still tells.
  const withoutFooter = (frame: string): string => frame.split("\n").slice(0, -3).join("\n");
  for (const frame of [
    grokFrame({ footer: "running", spinner: THINKING }),
    grokFrame({ footer: "tool", spinner: TOOL_RUNNING }),
    grokFrame({ footer: "queued", spinner: THINKING, queue: "responde solo: encolado" }),
    grokFrame({ footer: "running" }),
    withoutFooter(grokFrame({ footer: "running", spinner: THINKING })),
  ]) assert.equal(turnInFlight(frame), true, frame);
  // With the footer on screen the footer alone decides: a spinner-looking line above an idle footer
  // is conversation text (a quoted spinner kept the bus out of an idle TUI)
  for (const frame of [
    grokFrame(),
    grokFrame({ footer: "typed", box: "responde solo: ho" }),
    grokFrame({ footer: "quit" }),
    grokFrame({ footer: "idle", spinner: THINKING }),
  ]) {
    assert.equal(turnInFlight(frame), false, frame);
  }
  // Conversation text that quotes the footer or a spinner is not the footer nor the spinner.
  const quoted = grokFrame({ history: [
    "     el pie dice Shift+Tab:mode  │  Ctrl+c:cancel  │  Ctrl+x:shortcuts mientras corre",
    "     y la banda termina en [stop] …",
  ] });
  assert.equal(turnInFlight(quoted), false);
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
  assert.throws(() => loadSharedSessionConfig("hermes", "hermes", "/s", environment), /claude, codex, grok y muse/u);
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

test("grok /new del dueño con la caja sin foco (hades 2026-09-30): el primer pedido entra y re-asienta el puntero en 0600", async () => {
  const { state, grokHome, log, sessionLog } = await grokWorkspace("grok-new-sin-foco");
  const binding = { alias: "hades", harness: "grok" as const, configDirectory: await realpath(grokHome), workspace: await realpath("/workspace") };
  const store = new SharedTuiPointerStore(state);
  assert.equal(await store.seed(binding, log.sessionId), "written");
  // The owner typed `/new` and talked in the new conversation, then left the scrollback focused.
  const fresh = await sessionLog(newGrokSessionId(Date.now() + 1_000));
  await fresh.append(fresh.user("hola, conversación nueva"), fresh.message("p-dueno", "hola"), fresh.completed("p-dueno"));
  const tmux = new GrokTmux();
  tmux.paneContent = grokFrame({ footer: "unfocused" });
  tmux.focusedFrame = grokFrame({ footer: "idle" });
  tmux.onSubmit = async (text) => {
    await fresh.append(fresh.user(text), fresh.message("p-bus", envelopeText("ok", correlationIdFromPrompt(text))), fresh.completed("p-bus"));
  };
  const runner = grokRunner({ grokHome, tmux, nativePointer: new NativePointerAttestor(store, binding),
    resume: sharedSessionResume("grok", grokHome, "/workspace", { alias: "hades", stateDirectory: state }) });

  assert.equal((await runner.run(request("pedido tras /new"))).exitCode, 0);
  assert.deepEqual(await store.read(binding), { state: "valid", binding, nativeId: fresh.sessionId });
  const pointer = await stat(`${state}/shared-tui-session.json`);
  assert.equal(pointer.mode & 0o777, 0o600);
  assert.deepEqual(await resolveGrokLaunch(grokHome, "/workspace", { alias: "hades", stateDirectory: state }),
    { state: "launch", args: ["--resume", fresh.sessionId], resumed: true }, "si la TUI renace, vuelve a la conversación nueva");
});
