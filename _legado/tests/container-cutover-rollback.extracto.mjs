import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

export async function containerCutoverRollbackScenario({
  runRollback,
  state,
  live,
  systemctlState,
  supervisorLog,
}) {
  await state(["cauce-v3-container-kant.service"], ["cauce-v3-container-kant.service"]);
  let result = runRollback("container", live);
  assert.equal(result.status, 0, result.stderr);
  let current = JSON.parse(await readFile(systemctlState, "utf8"));
  assert.deepEqual(current.active, []);
  assert.deepEqual(current.enabled, []);
  const negativeCalls = (await readFile(supervisorLog, "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(negativeCalls, [{ action: "stopped", alias: "kant" }]);

  await state(["cauce-v3-alias-kant.service"], ["cauce-v3-container-kant.service"]);
  result = runRollback("container", live);
  assert.equal(result.status, 73);
  await state(
    ["cauce-v3-container-kant.service"],
    ["cauce-v3-container-kant.service"],
    { disableKeepsEnabled: true },
  );
  result = runRollback("container", live);
  assert.notEqual(result.status, 0);
  assert.equal(
    (await readFile(supervisorLog, "utf8")).trim(),
    "",
    "negative check must not run while unit can resurrect",
  );

  await state([], ["cauce-v3-alias-kant.service"]);
  result = runRollback("container", live);
  assert.equal(result.status, 73, `rollback must refuse an enabled alternate family: ${result.stderr}`);
  current = JSON.parse(await readFile(systemctlState, "utf8"));
  assert.deepEqual(current.active, []);
  assert.equal(
    (await readFile(supervisorLog, "utf8")).trim(),
    "",
    "no negative check runs while the alternate stays enabled",
  );
}
