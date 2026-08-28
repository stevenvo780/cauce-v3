import assert from "node:assert/strict";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { cliSharedSessionSpec } from "../src/shared-session/config.js";
import {
  claudeHasPreviousConversation,
  codexHasPreviousConversation,
} from "../src/shared-session/resume.js";
import {
  ensureSharedSession,
  resumeArgumentSuffix,
  transcriptDirectoryIn,
} from "../src/shared-session/session.js";
import type { ResumeSpec } from "../src/shared-session/types.js";
import { FakeTmux, freshState } from "./shared-session-fixtures.js";

const immediate = (): Promise<void> => Promise.resolve();

// ---------------------------------------------------------------------------
// Rehacer el panel debe reanudar la conversación existente desde disco.
// ---------------------------------------------------------------------------

/** Un `ResumeSpec` de mentira, con la respuesta que el test quiera y un contador de llamadas. */
function fakeResume(
  args: readonly string[],
  hay: boolean | (() => Promise<boolean>),
): { spec: ResumeSpec; preguntas: () => number } {
  let preguntas = 0;
  return {
    spec: {
      args,
      hasPreviousConversation: async (): Promise<boolean> => {
        preguntas += 1;
        return typeof hay === "boolean" ? hay : hay();
      },
    },
    preguntas: () => preguntas,
  };
}

test("con conversacion previa, el panel nace REANUDANDO en vez de en blanco", async () => {
  const { workspace } = await freshState("reanuda-codex");
  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.windows = [];
  const resume = fakeResume(["resume", "--last"], true);

  const result = await ensureSharedSession(
    tmux,
    {
      alias: "socrates", harness: "codex", workspace, command: "codex",
      environment: { CODEX_HOME: "/home/dev/.codex" },
      resume: resume.spec,
    },
    { sleep: immediate, readyTimeoutMs: 30 },
  );

  assert.equal(result.ready, true);
  assert.equal(result.created, true);
  // Que lo diga importa tanto como que lo haga: el aviso que lee el dueño distingue "se creó vacía"
  // de "se creó con su conversación", y decir lo primero cuando pasó lo segundo es mentirle.
  assert.equal(result.resumed, true);
  const created = tmux.calls.find((call) => call[0] === "new-session");
  assert.equal(created?.at(-1), "exec env CODEX_HOME='/home/dev/.codex' codex resume --last");
  assert.equal(resume.preguntas(), 1);
});

test("sin conversacion previa NO se intenta reanudar: se arranca pelado", async () => {
  // `claude --continue` sin nada que continuar sale con código 1 y mata el panel (medido con
  // claude 2.1.223). Preguntar antes cuesta leer un directorio; no preguntar cuesta un alias mudo.
  const { workspace } = await freshState("reanuda-sin-nada");
  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.windows = [];
  tmux.fatalPaneArguments = "--continue";
  const resume = fakeResume(["--continue"], false);

  const result = await ensureSharedSession(
    tmux,
    {
      alias: "kratos", harness: "claude", workspace, command: "claude", resume: resume.spec,
    },
    { sleep: immediate, readyTimeoutMs: 30 },
  );

  assert.equal(result.ready, true);
  assert.equal(result.resumed, undefined);
  const creadas = tmux.calls.filter((call) => call[0] === "new-session");
  assert.equal(creadas.length, 1, "sin conversacion previa no hay dos intentos, hay uno");
  assert.equal(creadas[0]?.at(-1), "exec claude");
});

test("si la reanudacion mata el panel, se rehace EN BLANCO y se dice", async () => {
  // La regla que ordena las dos malas opciones: un panel sin contexto es malo, un panel que no
  // arranca es peor. Un alias mudo es el fallo más caro de la flota.
  const { workspace } = await freshState("reanuda-falla");
  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.windows = [];
  // El detector dice que sí hay conversación, pero el harness no la puede abrir: un rollout roto,
  // una versión que cambió el subcomando, un permiso. Esa discrepancia TIENE que ser sobrevivible.
  tmux.fatalPaneArguments = "--continue";
  const resume = fakeResume(["--continue"], true);
  const avisos: string[] = [];

  const result = await ensureSharedSession(
    tmux,
    { alias: "zeus", harness: "claude", workspace, command: "claude", resume: resume.spec },
    { sleep: immediate, readyTimeoutMs: 30, log: (detail) => avisos.push(detail) },
  );

  assert.equal(result.ready, true, "el panel tiene que quedar EN PIE aunque la reanudacion falle");
  assert.equal(result.created, true);
  assert.equal(result.resumed, undefined, "no se puede declarar reanudado lo que arranco vacio");
  const creadas = tmux.calls.filter((call) => call[0] === "new-session");
  assert.equal(creadas.length, 2);
  assert.equal(creadas[0]?.at(-1), "exec claude --continue");
  assert.equal(creadas[1]?.at(-1), "exec claude");
  // El panel fatal se llevó la sesión entera. No se mata por nombre: si otro creador hubiera
  // ocupado `cauce-zeus` en ese instante, ese kill borraría SU conversación.
  assert.equal(tmux.calls.some((call) => call[0] === "kill-session"), false);
  // Y el dueño tiene que poder enterarse de que su conversación no volvió.
  assert.equal(avisos.length, 1);
  assert.ok(avisos[0]?.includes("EN BLANCO"), avisos[0]);
});

test("un panel VIVO pero lento no se mata: se reporta, no se rehace", async () => {
  // Una conversación grande tarda en dibujarse —la de kant pesaba 38 MB—. Confundir "tarda" con
  // "se murió" sería cometer a mano el mismo borrado que este mecanismo viene a evitar.
  const { workspace } = await freshState("reanuda-lenta");
  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.windows = [];
  tmux.paneContent = "❯ el dueño estaba escribiendo esto";  // caja ocupada: nunca "lista"
  const resume = fakeResume(["resume", "--last"], true);
  const avisos: string[] = [];

  const result = await ensureSharedSession(
    tmux,
    { alias: "atlas", harness: "codex", workspace, command: "codex", resume: resume.spec },
    { sleep: immediate, readyTimeoutMs: 5, log: (detail) => avisos.push(detail) },
  );

  assert.equal(result.ready, false);
  assert.equal(result.failure, "tui_absent");
  assert.equal(tmux.calls.filter((call) => call[0] === "new-session").length, 1);
  assert.equal(tmux.calls.some((call) => call[0] === "kill-session"), false);
  assert.deepEqual(avisos, []);
});

test("un detector que revienta no deja al alias sin panel", async () => {
  const { workspace } = await freshState("reanuda-detector-roto");
  const tmux = new FakeTmux();
  tmux.sessionExists = false;
  tmux.windows = [];
  const avisos: string[] = [];
  const roto: ResumeSpec = {
    args: ["--continue"],
    hasPreviousConversation: () => Promise.reject(new Error("EACCES: sessions/")),
  };

  const result = await ensureSharedSession(
    tmux,
    { alias: "vulcano", harness: "claude", workspace, command: "claude", resume: roto },
    { sleep: immediate, readyTimeoutMs: 30, log: (detail) => avisos.push(detail) },
  );

  assert.equal(result.ready, true);
  assert.equal(tmux.calls.find((call) => call[0] === "new-session")?.at(-1), "exec claude");
  assert.ok(avisos[0]?.includes("EACCES"), avisos[0]);
});

test("los argumentos de reanudacion no pueden colarse al shell", () => {
  assert.deepEqual(resumeArgumentSuffix(["resume", "--last"]), { ok: true, suffix: " resume --last" });
  assert.deepEqual(resumeArgumentSuffix(["--continue"]), { ok: true, suffix: " --continue" });
  assert.deepEqual(resumeArgumentSuffix(undefined), { ok: true, suffix: "" });
  assert.deepEqual(resumeArgumentSuffix([]), { ok: true, suffix: "" });
  // Falla cerrado en vez de mandarle al login shell algo que nadie escribió a propósito.
  assert.equal(resumeArgumentSuffix(["; rm -rf /"]).ok, false);
  assert.equal(resumeArgumentSuffix(["$(whoami)"]).ok, false);
});

test("codex: solo cuenta una conversacion interactiva de ESTE directorio", async () => {
  const { state } = await freshState("detector-codex");
  const codexHome = join(state, ".codex");
  const dia = join(codexHome, "sessions", "2026", "08", "06");
  await mkdir(dia, { recursive: true });
  const cabecera = (cwd: string, source: unknown): string => `${JSON.stringify({
    timestamp: "2026-08-06T09:57:18.709Z",
    type: "session_meta",
    payload: { session_id: randomUUID(), cwd, source, originator: "codex-tui" },
  })}\n{"type":"event_msg","payload":{"type":"task_started"}}\n`;

  // Sin nada, no hay nada que reanudar. Es la rama que impide el panel muerto.
  assert.equal(await codexHasPreviousConversation(codexHome, "/workspace"), false);

  // La de OTRO directorio no cuenta: `resume --last` filtra por cwd, y prometer una reanudación que
  // codex no va a hacer es volver a dejar el panel a merced del harness.
  await appendFile(join(dia, `rollout-2026-08-06T09-00-00-${randomUUID()}.jsonl`),
    cabecera("/otro/sitio", "cli"));
  assert.equal(await codexHasPreviousConversation(codexHome, "/workspace"), false);

  // La de un subagente tampoco: codex la esconde salvo `--include-non-interactive`.
  await appendFile(join(dia, `rollout-2026-08-06T09-30-00-${randomUUID()}.jsonl`),
    cabecera("/workspace", { subagent: "revisor" }));
  assert.equal(await codexHasPreviousConversation(codexHome, "/workspace"), false);

  // Y la del dueño, en su directorio, sí.
  await appendFile(join(dia, `rollout-2026-08-06T09-57-00-${randomUUID()}.jsonl`),
    cabecera("/workspace", "cli"));
  assert.equal(await codexHasPreviousConversation(codexHome, "/workspace"), true);
});

test("claude: cuenta el transcript del directorio, y solo si tiene algo dentro", async () => {
  const { state } = await freshState("detector-claude");
  const configDirectory = join(state, ".claude");
  const proyecto = transcriptDirectoryIn(configDirectory, "/workspace");

  // Ni siquiera existe el directorio: no hay nada que continuar.
  assert.equal(await claudeHasPreviousConversation(configDirectory, "/workspace"), false);

  // Existe y está vacío: tampoco. `--continue` saldría con código 1 y se llevaría el panel.
  await mkdir(proyecto, { recursive: true });
  assert.equal(await claudeHasPreviousConversation(configDirectory, "/workspace"), false);

  // Un `.jsonl` de cero bytes es un fichero recién creado, no una conversación.
  await appendFile(join(proyecto, `${randomUUID()}.jsonl`), "");
  assert.equal(await claudeHasPreviousConversation(configDirectory, "/workspace"), false);

  await appendFile(join(proyecto, `${randomUUID()}.jsonl`),
    `${JSON.stringify({ type: "user", uuid: "u1" })}\n`);
  assert.equal(await claudeHasPreviousConversation(configDirectory, "/workspace"), true);

  // Y lo de OTRO workspace no se cuenta: claude reanuda por directorio de trabajo.
  assert.equal(await claudeHasPreviousConversation(configDirectory, "/otro"), false);
});

test("los dos creadores del panel reanudan igual", async () => {
  // El adaptador y `cauce <alias>` son los dos únicos que crean la sesión, y el que gana la carrera
  // le impone su forma al panel para siempre. Si sólo uno reanudara, la conversación del dueño
  // dependería de quién llegó primero — que es como se perdieron los 38 MB de kant: por el CLI.
  const cli = cliSharedSessionSpec("codex", "socrates", "/workspace", "/home/dev", {});
  assert.deepEqual(cli.resume?.args, ["resume", "--last"]);
  const claude = cliSharedSessionSpec("claude", "kratos", "/workspace", "/home/dev", {});
  assert.deepEqual(claude.resume?.args, ["--continue"]);
});