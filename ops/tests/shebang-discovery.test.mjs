#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ops = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helper = path.join(ops, "scripts/ficheros-con-shebang.mjs");
const { ficherosConShebang } = await import(helper);

const SHELL_ESPERADOS = [
  "ops/cli/cauce",
  "ops/cli/cauce-huerfanas",
  "ops/cli/cauce-panel",
  "ops/cli/cauce-reponer",
  "ops/guardias/cauce-codex-sync",
  "ops/guardias/cauce-destrabar-telegram",
  "ops/guardias/cauce-directo",
  "ops/guardias/cauce-modal-sweeper",
  "ops/guardias/cauce-panel-guard",
  "ops/guardias/cauce-soltar",
  "ops/guardias/cauce-tmux-panel",
  "ops/guardias/secreto",
];
const PYTHON_ESPERADOS = [
  "ops/guardias/cauce-ai-live",
  "ops/guardias/cauce-attach",
  "ops/guardias/cauce-attach-guard",
  "ops/guardias/cauce-credenciales",
  "ops/guardias/cauce-esfuerzo",
  "ops/guardias/cauce-estado",
  "ops/guardias/cauce-quien-consume",
  "ops/guardias/cauce-sesiones",
  "ops/guardias/cauce-v3-medico-monitor",
  "ops/guardias/cauce-watch",
];

function descubrir(familia) {
  const resultado = spawnSync(process.execPath, [helper, familia], { encoding: "utf8" });
  assert.equal(resultado.status, 0, resultado.stderr);
  return resultado.stdout.split("\n").filter(Boolean);
}

const shell = descubrir("sh");
const python = descubrir("python");
assert.deepEqual(shell, SHELL_ESPERADOS);
assert.deepEqual(python, PYTHON_ESPERADOS);
assert.equal(shell.filter(fichero => python.includes(fichero)).length, 0);

const desconocida = spawnSync(process.execPath, [helper, "perl"], { encoding: "utf8" });
assert.equal(desconocida.status, 2);
assert.equal(spawnSync(process.execPath, [helper], { encoding: "utf8" }).status, 2);

const temporal = await mkdtemp(path.join(os.tmpdir(), "cauce-shebang-"));
try {
  const ficheros = {
    "shebang-python": "#!/usr/bin/env python3\nprint('ok')\n",
    "shebang-bash": "#!/usr/bin/env bash\ntrue\n",
    "shebang-sh-desnudo": "#!/bin/sh\ntrue\n",
    "shebang-tardio": `# a licence header long enough to push the interpreter past the header window\n${"# padding\n".repeat(8)}#!/usr/bin/env python3\nprint('ok')\n`,
    "sin-shebang": "print('ok')\n",
    "con-extension.py": "#!/usr/bin/env python3\nprint('ok')\n",
  };
  await Promise.all(Object.entries(ficheros).map(
    ([nombre, cuerpo]) => writeFile(path.join(temporal, nombre), cuerpo, "utf8"),
  ));
  const candidatos = Object.keys(ficheros).map(nombre => path.join(temporal, nombre));
  const fixturePython = ficherosConShebang("python", candidatos).map(fichero => path.basename(fichero));
  const fixtureShell = ficherosConShebang("sh", candidatos).map(fichero => path.basename(fichero));
  assert.deepEqual(fixturePython, ["shebang-python"]);
  assert.deepEqual(fixtureShell, ["shebang-bash", "shebang-sh-desnudo"]);
  assert.ok(!fixturePython.includes("shebang-tardio"));
  assert.throws(() => ficherosConShebang("perl", candidatos), /unknown interpreter family/u);
} finally {
  await rm(temporal, { recursive: true, force: true });
}

console.log("shebang discovery ok");
