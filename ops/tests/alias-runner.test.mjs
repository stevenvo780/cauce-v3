#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ops = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = path.join(ops, "scripts/alias-runner.sh");
const temporary = await mkdtemp(path.join(os.tmpdir(), "cauce-alias-runner-"));
const fixtureRunner = path.join(temporary, "alias-runner.sh");
const stateDirectory = path.join(temporary, "state");
const capture = path.join(temporary, "executed-timeout");
const executable = path.join(temporary, "fixture-executable.sh");
const credentialPaths = {
  token: path.join(temporary, "token"),
  certificate: path.join(temporary, "client.crt"),
  key: path.join(temporary, "client.key"),
  ca: path.join(temporary, "ca.crt"),
};

function environment(timeout) {
  const env = {
    ...process.env,
    CAUCE_ALIAS: "kant",
    CAUCE_ORIGIN_TRANSPORT: "telegram",
    CAUCE_ENVIRONMENT: "production",
    CAUCE_INSTANCE_ID: "systemd-kant",
    CAUCE_STATE_DIR: stateDirectory,
    CAUCE_ALIAS_RUNNER_TEST_STATE_DIR: stateDirectory,
    CAUCE_RELAY_URL_ENV: "CAUCE_FIXTURE_RELAY_URL",
    CAUCE_FIXTURE_RELAY_URL: "wss://relay.example.invalid/v3/ws",
    CAUCE_TOKEN_PATH_ENV: "CAUCE_FIXTURE_TOKEN_PATH",
    CAUCE_FIXTURE_TOKEN_PATH: credentialPaths.token,
    CAUCE_CERT_PATH_ENV: "CAUCE_FIXTURE_CERT_PATH",
    CAUCE_FIXTURE_CERT_PATH: credentialPaths.certificate,
    CAUCE_KEY_PATH_ENV: "CAUCE_FIXTURE_KEY_PATH",
    CAUCE_FIXTURE_KEY_PATH: credentialPaths.key,
    CAUCE_CA_PATH_ENV: "CAUCE_FIXTURE_CA_PATH",
    CAUCE_FIXTURE_CA_PATH: credentialPaths.ca,
    CAUCE_EXEC_PATH_ENV: "CAUCE_FIXTURE_EXEC_PATH",
    CAUCE_FIXTURE_EXEC_PATH: executable,
    CAUCE_HARNESS: "codex",
    CAUCE_TEST_CAPTURE: capture,
  };
  delete env.CAUCE_OPERATIONAL_MODEL_ENV;
  if (timeout === undefined) delete env.CAUCE_DEFAULT_TIMEOUT_MS;
  else env.CAUCE_DEFAULT_TIMEOUT_MS = timeout;
  return env;
}

function run(timeout) {
  return spawnSync(fixtureRunner, ["kant"], {
    encoding: "utf8",
    env: environment(timeout),
  });
}

try {
  await mkdir(stateDirectory, { mode: 0o700 });
  for (const pathname of Object.values(credentialPaths)) {
    await writeFile(pathname, "fixture-only\n", { mode: 0o600 });
  }
  await writeFile(executable, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "\${CAUCE_DEFAULT_TIMEOUT_MS:?}" >"\${CAUCE_TEST_CAPTURE:?}"
`, { mode: 0o555 });
  await chmod(executable, 0o555);

  const source = await readFile(runner, "utf8");
  const stateAssignment = 'expected_state="/var/lib/cauce-v3/aliases/$alias_name"';
  assert.equal(source.split(stateAssignment).length - 1, 1,
    "the production state assignment must remain singular and explicit");
  await writeFile(
    fixtureRunner,
    source.replace(
      stateAssignment,
      'expected_state=${CAUCE_ALIAS_RUNNER_TEST_STATE_DIR:?test state directory is required}',
    ),
    { mode: 0o555 },
  );
  await chmod(fixtureRunner, 0o555);

  let result = run(undefined);
  assert.equal(result.status, 0, `default timeout must execute: ${result.stderr}`);
  assert.equal((await readFile(capture, "utf8")).trim(), "86400000",
    "an omitted timeout must export the renewable 24-hour agentic default");

  await unlink(capture);
  result = run("480000");
  assert.equal(result.status, 0, `valid override must execute: ${result.stderr}`);
  assert.equal((await readFile(capture, "utf8")).trim(), "480000",
    "a valid timeout override must be exported verbatim");

  for (const [name, timeout] of [
    ["empty", ""],
    ["non-numeric", "480000ms"],
    ["below minimum", "59999"],
    ["above maximum", "604800001"],
  ]) {
    await unlink(capture);
    result = run(timeout);
    assert.notEqual(result.status, 0, `${name} timeout must fail`);
    assert.match(result.stderr, /CAUCE_DEFAULT_TIMEOUT_MS must be a decimal integer between 60000 and 604800000/u);
    await assert.rejects(readFile(capture), { code: "ENOENT" },
      `${name} timeout must fail before the executable runs`);
    await writeFile(capture, "sentinel\n", { mode: 0o600 });
  }

  process.stdout.write(
    "alias runner timeout: 86400000 default and valid override exported; malformed and out-of-range values rejected before exec\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
