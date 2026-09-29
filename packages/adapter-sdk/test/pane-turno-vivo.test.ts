import assert from "node:assert/strict";
import test from "node:test";
import { turnInFlight } from "../src/shared-session/pane.js";

const PANEL_KRATOS_TRABAJANDO = [
  "     for i in $(seq 1 28); do sleep 20; kill -0 1637989 2>/dev/null || break; done",
  "     echo; echo \"=== contraste en DEV con el arreglo pues… (11s)",
  "     (ctrl+b ctrl+b (twice) to run in background)",
  "· Fermenting… (14m 17s · ↓ 14.2k tokens)",
  "  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude's current work",
  "─────────────────────────────────────────────── ultracode ─",
  "❯ ",
  "───────────────────────────────────────────────────────────",
  "  [Opus 5 (1M context)] | ⚡20:01 codex/gpt-5.6-sol      /rc",
  "  ⏵⏵ bypass permissions on · 4 shells · ← for agents · /diff to hide diff · 2 feedback drafts",
].join("\n");

const PANEL_KRATOS_OCIOSO = [
  "  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude's current work",
  "─────────────────────────────────────────────── ultracode ─",
  "❯ ",
  "───────────────────────────────────────────────────────────",
  "  [Opus 5 (1M context)] | ⚡20:01 codex/gpt-5.6-sol      /rc",
  "  ⏵⏵ bypass permissions on · 3 shells · ← for agents · /diff to hide diff · 2 feedback drafts",
].join("\n");

const PANEL_CON_INTERRUPT = [
  "◦ Working (17s • esc to interrupt)",
  "› Ask Codex to do anything",
  "  gpt-6-astra max · Context 100% left",
].join("\n");

test("ve vivo el panel de kratos aunque la banda no diga «interrupt» y esté en la séptima línea", () => {
  assert.equal(turnInFlight(PANEL_KRATOS_TRABAJANDO), true);
});

test("CONTROL: el mismo panel sin turno NO se declara vivo", () => {
  assert.equal(turnInFlight(PANEL_KRATOS_OCIOSO), false);
});

test("CONTROL: sigue reconociendo la banda clásica con «esc to interrupt»", () => {
  assert.equal(turnInFlight(PANEL_CON_INTERRUPT), true);
});

test("CONTROL: un panel vacío o indefinido no inventa un turno vivo", () => {
  assert.equal(turnInFlight(undefined), false);
  assert.equal(turnInFlight("\n\n   \n"), false);
});
