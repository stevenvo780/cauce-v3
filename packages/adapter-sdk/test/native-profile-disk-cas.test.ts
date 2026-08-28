import assert from "node:assert/strict";
import {
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  discoReal,
  escribirEnDiscoRealSiCoincide,
} from "../src/context/siembra-del-perfil.js";

test("native fixed-context CAS preserves bytes on stale read and rejects hardlinks", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cauce-native-cas-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "AGENTS.md");
  writeFileSync(path, "current", "utf8");

  assert.throws(() => discoReal.leer(path, 3), /tope seguro/u);
  assert.equal(readFileSync(path, "utf8"), "current");

  assert.throws(
    () => escribirEnDiscoRealSiCoincide(path, "stale", "replacement"),
    /cambi/u,
  );
  assert.equal(readFileSync(path, "utf8"), "current");

  const hardlink = join(root, "AGENTS-linked.md");
  linkSync(path, hardlink);
  assert.throws(
    () => escribirEnDiscoRealSiCoincide(path, "current", "replacement"),
    /enlaces duros/u,
  );
  assert.equal(readFileSync(path, "utf8"), "current");

  discoReal.escribir(path, "legacy-write");
  assert.equal(readFileSync(path, "utf8"), "legacy-write");
  assert.equal(readFileSync(hardlink, "utf8"), "legacy-write");
});
