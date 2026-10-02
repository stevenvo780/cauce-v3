import assert from "node:assert/strict";
import test from "node:test";
import { grokPromptUnfocused, inputBoxState, turnInFlight } from "../src/shared-session/pane.js";
import {
  adapterFor,
  correlationIdFromPrompt,
  envelopeText,
  execute,
  expectSharedTuiUnavailable,
} from "./shared-session-fixtures.js";
import { GrokTmux, grokFrame, grokRunner, grokWorkspace } from "./grok-shared-session-fixtures.js";

// ---------------------------------------------------------------------------------------------
// grok with the scrollback focused: hades lost 2b194c63 because its box showed a grey
// «Build anything» that read as the owner's text, so the bus prompt never went in.
// ---------------------------------------------------------------------------------------------

const firstCall = (tmux: GrokTmux, match: (call: readonly string[]) => boolean): number =>
  tmux.calls.findIndex(match);

test("grok: el pie `Space:prompt` es la caja sin foco, no texto del dueño ni un turno en vuelo", () => {
  const pane = grokFrame({ footer: "unfocused" });
  assert.equal(grokPromptUnfocused(pane), true);
  assert.equal(inputBoxState(pane).unfocused, true);
  assert.equal(turnInFlight(pane), false, "grok ocioso con la caja sin foco no está generando");
  assert.equal(grokPromptUnfocused(grokFrame({ footer: "idle" })), false);
  assert.equal(grokPromptUnfocused(grokFrame({ footer: "typed", box: "Space:prompt es texto del dueño" })), false,
    "sólo cuenta el pie, no la caja");
});

test("grok: con la caja sin foco manda UN Space bajo la exclusión, antes de pegar, y el pedido entra", async () => {
  const { state, grokHome, log } = await grokWorkspace("grok-foco-placeholder");
  const tmux = new GrokTmux();
  tmux.paneContent = grokFrame({ footer: "unfocused" });
  tmux.focusedFrame = grokFrame({ footer: "idle" });
  tmux.onSubmit = async (text) => {
    await log.append(log.user(text), log.message("p-foco", envelopeText("entró tras dar foco", correlationIdFromPrompt(text))),
      log.completed("p-foco"));
  };

  const output = await execute(await adapterFor(grokRunner({ grokHome, tmux }), state, "hades", "grok"));

  assert.equal(output.reply, "entró tras dar foco");
  assert.equal(tmux.focusKeys, 1);
  assert.equal(tmux.strayFocusKeys, 0, "un Space llegó a una caja que ya tenía foco");
  assert.equal(tmux.unbarrieredFocusKeys, 0, "el Space salió sin la exclusión de input");
  const load = firstCall(tmux, (call) => call[0] === "load-buffer");
  assert.ok(load >= (tmux.focusAt[0] ?? Infinity), "el foco va antes de cargar el pegado");
  assert.equal(tmux.submittedCount, 1);
});

test("grok: con la caja ya enfocada no se manda ningún Space", async () => {
  const { state, grokHome, log } = await grokWorkspace("grok-foco-normal");
  const tmux = new GrokTmux();
  tmux.onSubmit = async (text) => {
    await log.append(log.user(text), log.message("p-n", envelopeText("normal", correlationIdFromPrompt(text))), log.completed("p-n"));
  };

  const output = await execute(await adapterFor(grokRunner({ grokHome, tmux }), state, "hades", "grok"));

  assert.equal(output.reply, "normal");
  assert.equal(tmux.focusKeys, 0);
});

test("grok: si tras dar foco la caja muestra texto del dueño, no se pega nada y el texto queda intacto", async () => {
  const { state, grokHome } = await grokWorkspace("grok-foco-texto-dueno");
  const tmux = new GrokTmux();
  tmux.paneContent = grokFrame({ footer: "unfocused", box: "hola dueño" });
  tmux.focusedFrame = grokFrame({ footer: "typed", box: "hola dueño" });

  const error = await expectSharedTuiUnavailable(execute(await adapterFor(grokRunner({ grokHome, tmux }), state, "hades", "grok")));

  assert.match(error.message, /input_busy/u);
  assert.equal(tmux.focusKeys, 1);
  assert.equal(tmux.strayFocusKeys, 0);
  assert.equal(tmux.used("load-buffer"), false);
  assert.equal(tmux.submittedCount, 0);
});

test("grok: si grok tarda en redibujar tras el Space, NO manda otro (lo escribiría) y el pedido entra al verse el foco", async () => {
  const { state, grokHome, log } = await grokWorkspace("grok-foco-redibujo-tardio");
  const tmux = new GrokTmux();
  tmux.paneContent = grokFrame({ footer: "unfocused" });
  tmux.focusedFrame = grokFrame({ footer: "idle" });
  tmux.focusRedrawAfterCaptures = 4;
  tmux.onSubmit = async (text) => {
    await log.append(log.user(text), log.message("p-t", envelopeText("tardío", correlationIdFromPrompt(text))), log.completed("p-t"));
  };

  const output = await execute(await adapterFor(grokRunner({ grokHome, tmux, acquireTimeoutMs: 5_000 }), state, "hades", "grok"));

  assert.equal(output.reply, "tardío");
  assert.equal(tmux.focusKeys, 1);
  assert.equal(tmux.strayFocusKeys, 0, "un segundo Space sobre el pie viejo se habría escrito en la caja");
});

test("grok: una caja que nunca toma el foco recibe UN solo Space y degrada como caja ocupada, sin pegar", async () => {
  const { state, grokHome } = await grokWorkspace("grok-foco-nunca");
  const tmux = new GrokTmux();
  tmux.paneContent = grokFrame({ footer: "unfocused" });
  tmux.focusedFrame = grokFrame({ footer: "unfocused" }); // grok ignores the key

  const error = await expectSharedTuiUnavailable(execute(await adapterFor(grokRunner({ grokHome, tmux }), state, "hades", "grok")));

  assert.match(error.message, /input_busy/u);
  assert.match(error.message, /no tiene el foco/u);
  assert.equal(tmux.focusKeys, 1, "nunca un segundo Space: podría escribirse en una caja que ya tiene foco");
  assert.equal(tmux.used("load-buffer"), false);
  assert.equal(tmux.submittedCount, 0);
});
