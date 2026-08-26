import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { createHash } from "node:crypto";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SCRIPT = path.join(ROOT, "ops/scripts/update-alias-config.py");
const PRIVATE_A = "value-that-must-never-appear-A";
const PRIVATE_B = "value-that-must-never-appear-B";
const SHA_A = `sha256:${"a".repeat(64)}`;
const SHA_B = `sha256:${"b".repeat(64)}`;

function digest(body) {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function config(alias, release, extra = "") {
  return [
    "# configuracion privada de prueba",
    `BUNDLE_RELEASE=${release}`,
    `BUNDLE_SHA256=${SHA_A}`,
    `PKI_DIR=/etc/cauce-v3/pki/${alias}`,
    "RELAY_URL=wss://gateway.example.invalid/v3/ws",
    `EXPECTED_IMAGE_ID=${SHA_B}`,
    "CAUCE_SEMBRAR_PERFIL=1",
    "CONFIG_POR_ALIAS=1",
    extra,
  ].filter(Boolean).join("\n") + "\n";
}

async function fixture(name) {
  const root = await mkdtemp(path.join(tmpdir(), `cauce-config-cas-${name}-`));
  const configRoot = path.join(root, "configs");
  const pkiRoot = "/etc/cauce-v3/pki";
  await mkdir(configRoot, { mode: 0o700 });
  const inventory = path.join(root, "inventory.json");
  await writeFile(inventory, `${JSON.stringify({
    schemaVersion: 2,
    aliases: {
      alpha: {
        container: "shared", user: "dev", home: "/home/dev", harness: "codex",
      },
      beta: {
        container: "shared", user: "dev", home: "/home/dev", harness: "codex",
      },
      claudia: {
        container: "claude-only", user: "dev", home: "/home/dev", harness: "claude",
      },
      iza: {
        container: "shared", user: "dev", home: "/home/dev", harness: "hermes",
        stateDirectory: "/home/dev/.local/state/cauce-v3/iza",
      },
      claw: {
        container: "claw-only", user: "claw", home: "/home/claw", harness: "openclaw",
        workspace: "/home/claw/clawd",
      },
    },
  })}\n`, { mode: 0o600 });
  return { root, configRoot, inventory, pkiRoot };
}

function run(context, action, args, options = {}) {
  const result = spawnSync(
    "python3",
    [
      SCRIPT, "--inventory", context.inventory, "--config-root", context.configRoot,
      "--pki-root", context.pkiRoot, action, ...args,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" },
      ...options,
    },
  );
  const combined = `${result.stdout}${result.stderr}`;
  assert.equal(combined.includes(PRIVATE_A), false, "stdout/stderr must never reveal value A");
  assert.equal(combined.includes(PRIVATE_B), false, "stdout/stderr must never reveal value B");
  return result;
}

function output(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function spawnResult(args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", args, { cwd: ROOT, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

const CRASH_RESTORE_HARNESS = String.raw`
import importlib.util
import os
import signal
import sys

spec = importlib.util.spec_from_file_location("cauce_update_alias_config", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
phase = sys.argv[2]
original_atomic_replace = module.atomic_replace

def crash_before_replace(*_args, **_kwargs):
    os.kill(os.getpid(), signal.SIGKILL)

def crash_after_replace(*args, **kwargs):
    original_atomic_replace(*args, **kwargs)
    os.kill(os.getpid(), signal.SIGKILL)

module.atomic_replace = crash_before_replace if phase == "before" else crash_after_replace
raise SystemExit(module.main(sys.argv[3:]))
`;

async function crashRestore(context, phase, args) {
  const environment = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    PYTHONDONTWRITEBYTECODE: "1",
  };
  const result = await spawnResult([
    "-c", CRASH_RESTORE_HARNESS, SCRIPT, phase,
    "--inventory", context.inventory,
    "--config-root", context.configRoot,
    "--pki-root", context.pkiRoot,
    "restore", ...args,
  ], environment);
  const combined = `${result.stdout}${result.stderr}`;
  assert.equal(combined.includes(PRIVATE_A), false, "crash output must never reveal value A");
  assert.equal(combined.includes(PRIVATE_B), false, "crash output must never reveal value B");
  return result;
}

test("CAS limpia claves incompatibles y su backup legacy se restaura byte a byte", async () => {
  const context = await fixture("apply");
  try {
    const file = path.join(context.configRoot, "alpha.env");
    const original = config(
      "alpha",
      PRIVATE_A,
      `EXPECTED_CLI_VERSION=2.1.220\nPRIVATE_TOKEN=${PRIVATE_B}`,
    );
    await writeFile(file, original, { mode: 0o600 });
    const originalStat = await stat(file);

    const inspected = output(run(context, "inspect", ["--alias", "alpha"]));
    assert.equal(inspected.digest, digest(original));
    const applied = output(run(context, "apply", [
      "--alias", "alpha",
      "--expected-old-digest", inspected.digest,
      "--set", `BUNDLE_RELEASE=${PRIVATE_B}`,
    ]));

    assert.equal(applied.status, "updated");
    assert.deepEqual(applied.removedKeys, ["EXPECTED_CLI_VERSION", "PRIVATE_TOKEN"]);
    const current = await readFile(file, "utf8");
    assert.match(current, new RegExp(`BUNDLE_RELEASE=${PRIVATE_B}`));
    assert.doesNotMatch(current, /EXPECTED_CLI_VERSION|PRIVATE_TOKEN/u);
    const currentStat = await stat(file);
    assert.equal(currentStat.mode & 0o777, 0o600);
    assert.notEqual(currentStat.ino, originalStat.ino, "publication must replace the inode");

    const backup = path.join(context.configRoot, "backups", applied.backup);
    assert.equal(await readFile(backup, "utf8"), original);
    assert.equal((await stat(backup)).mode & 0o777, 0o600);
    assert.equal((await stat(`${backup}.receipt`)).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(path.dirname(backup), ".backup-auth-key"))).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(backup))).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(context.configRoot, ".alpha.config.lock"))).mode & 0o777, 0o600);

    const restored = output(run(context, "restore", [
      "--alias", "alpha",
      "--expected-old-digest", applied.newDigest,
      "--backup", applied.backup,
    ]));
    assert.equal(restored.status, "updated");
    assert.equal(restored.newDigest, digest(original));
    assert.equal(await readFile(file, "utf8"), original,
      "restore must publish the exact legacy bytes, including keys removed by apply");
    assert.equal(await readFile(path.join(context.configRoot, "backups", restored.backup), "utf8"), current,
      "restoring legacy bytes must also preserve the state it replaced");

    const reapplied = output(run(context, "apply", [
      "--alias", "alpha",
      "--expected-old-digest", restored.newDigest,
      "--set", "BUNDLE_RELEASE=release-after-restore",
    ]));
    assert.deepEqual(reapplied.removedKeys, ["EXPECTED_CLI_VERSION", "PRIVATE_TOKEN"],
      "a later apply must keep enforcing the current allowlist after a legacy restore");
    assert.doesNotMatch(await readFile(file, "utf8"), /EXPECTED_CLI_VERSION|PRIVATE_TOKEN/u);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("un backup emitido antes de claves requeridas nuevas se restaura byte a byte", async () => {
  const context = await fixture("restore-before-required-keys");
  try {
    const file = path.join(context.configRoot, "alpha.env");
    const beforePolicyExpansion = config("alpha", "release-before")
      .replace("CAUCE_SEMBRAR_PERFIL=1\n", "")
      .replace("CONFIG_POR_ALIAS=1\n", "");
    await writeFile(file, beforePolicyExpansion, { mode: 0o600 });

    const migrated = output(run(context, "apply", [
      "--alias", "alpha",
      "--expected-old-digest", digest(beforePolicyExpansion),
      "--set", "CAUCE_SEMBRAR_PERFIL=1",
      "--set", "CONFIG_POR_ALIAS=1",
    ]));
    const afterPolicyExpansion = await readFile(file, "utf8");
    assert.match(afterPolicyExpansion, /CAUCE_SEMBRAR_PERFIL=1/u);
    assert.match(afterPolicyExpansion, /CONFIG_POR_ALIAS=1/u);

    const restored = output(run(context, "restore", [
      "--alias", "alpha",
      "--expected-old-digest", migrated.newDigest,
      "--backup", migrated.backup,
    ]));
    assert.equal(restored.newDigest, digest(beforePolicyExpansion));
    assert.equal(await readFile(file, "utf8"), beforePolicyExpansion,
      "rollback must not synthesize keys that did not exist in the authenticated before-image");
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("restore rechaza un fichero con nombre y digest válidos que no emitió el helper", async () => {
  const context = await fixture("restore-policy-negative");
  try {
    const file = path.join(context.configRoot, "alpha.env");
    const original = config("alpha", "release-a");
    await writeFile(file, original, { mode: 0o600 });

    const invalid = original.replace("CAUCE_SEMBRAR_PERFIL=1", "CAUCE_SEMBRAR_PERFIL=0")
      + `PRIVATE_TOKEN=${PRIVATE_A}\n`;
    const backups = path.join(context.configRoot, "backups");
    await mkdir(backups, { mode: 0o700 });
    const backupName = [
      "alpha",
      digest(invalid).slice("sha256:".length),
      "1700000000000000",
      "0123456789abcdef",
      "env",
    ].join(".");
    await writeFile(path.join(backups, backupName), invalid, { mode: 0o600 });

    const result = run(context, "restore", [
      "--alias", "alpha",
      "--expected-old-digest", digest(original),
      "--backup", backupName,
    ]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /autenticacion emitida por el helper/u);
    assert.equal(await readFile(file, "utf8"), original,
      "a policy-invalid backup must not replace the current config");
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("un backup valido se restaura byte a byte y la propia restauracion queda respaldada", async () => {
  const context = await fixture("restore");
  try {
    const file = path.join(context.configRoot, "alpha.env");
    const original = config("alpha", "release-a");
    await writeFile(file, original, { mode: 0o600 });
    const oldDigest = digest(original);

    const first = output(run(context, "apply", [
      "--alias", "alpha", "--expected-old-digest", oldDigest,
      "--set", `BUNDLE_RELEASE=${PRIVATE_A}`,
    ]));
    const changed = await readFile(file, "utf8");
    assert.notEqual(changed, original);

    const restored = output(run(context, "restore", [
      "--alias", "alpha",
      "--expected-old-digest", first.newDigest,
      "--backup", first.backup,
    ]));
    assert.equal(await readFile(file, "utf8"), original);
    assert.equal(restored.newDigest, oldDigest);
    assert.equal(await readFile(path.join(context.configRoot, "backups", restored.backup), "utf8"), changed);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("restore es causal y de un solo uso incluso si el mismo sucesor reaparece", async () => {
  const context = await fixture("restore-causal-once");
  try {
    const file = path.join(context.configRoot, "alpha.env");
    const original = config("alpha", "release-a");
    await writeFile(file, original, { mode: 0o600 });
    const first = output(run(context, "apply", [
      "--alias", "alpha", "--expected-old-digest", digest(original),
      "--set", `BUNDLE_RELEASE=${PRIVATE_A}`,
    ]));
    const successor = await readFile(file, "utf8");

    output(run(context, "restore", [
      "--alias", "alpha", "--expected-old-digest", digest(successor), "--backup", first.backup,
    ]));
    const repeatedSuccessor = output(run(context, "apply", [
      "--alias", "alpha", "--expected-old-digest", digest(original),
      "--set", `BUNDLE_RELEASE=${PRIVATE_A}`,
    ]));
    assert.equal(repeatedSuccessor.newDigest, digest(successor));

    const replay = run(context, "restore", [
      "--alias", "alpha", "--expected-old-digest", digest(successor), "--backup", first.backup,
    ]);
    assert.equal(replay.status, 2);
    assert.match(replay.stderr, /ya fue consumido/u);
    assert.equal(await readFile(file, "utf8"), successor);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("journal pending reintenta el sucesor y falla cerrado ante cualquier tercer estado", async () => {
  const context = await fixture("restore-crash-before-publication");
  try {
    const file = path.join(context.configRoot, "alpha.env");
    const original = config("alpha", "release-a");
    await writeFile(file, original, { mode: 0o600 });
    const first = output(run(context, "apply", [
      "--alias", "alpha", "--expected-old-digest", digest(original),
      "--set", `BUNDLE_RELEASE=${PRIVATE_A}`,
    ]));
    const successor = await readFile(file, "utf8");
    const crash = await crashRestore(context, "before", [
      "--alias", "alpha", "--expected-old-digest", digest(successor),
      "--backup", first.backup,
    ]);
    assert.equal(crash.signal, "SIGKILL", `${crash.stdout}\n${crash.stderr}`);
    assert.equal(await readFile(file, "utf8"), successor,
      "SIGKILL before publication must leave the successor intact");

    const journalPath = path.join(
      context.configRoot, "backups", `${first.backup}.receipt.used`,
    );
    let journal = JSON.parse(await readFile(journalPath, "utf8"));
    assert.equal(journal.state, "pending");
    assert.equal((await stat(journalPath)).nlink, 1, "pending journal must be one durable inode");
    assert.equal(journal.successorSha256, digest(successor));
    assert.equal(journal.targetSha256, digest(original));

    const unrelated = config("alpha", "release-unrelated");
    await writeFile(file, unrelated, { mode: 0o600 });
    const refused = run(context, "restore", [
      "--alias", "alpha", "--expected-old-digest", digest(unrelated),
      "--backup", first.backup,
    ]);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /journal de consumo.*estado actual/u);
    assert.equal(await readFile(file, "utf8"), unrelated);
    assert.equal(JSON.parse(await readFile(journalPath, "utf8")).state, "pending");

    await writeFile(file, successor, { mode: 0o600 });
    const retried = output(run(context, "restore", [
      "--alias", "alpha", "--expected-old-digest", digest(successor),
      "--backup", first.backup,
    ]));
    assert.equal(retried.status, "updated");
    assert.equal(await readFile(file, "utf8"), original);
    journal = JSON.parse(await readFile(journalPath, "utf8"));
    assert.equal(journal.state, "committed");
    assert.equal(await readFile(
      path.join(context.configRoot, "backups", journal.replacementBackup), "utf8",
    ), successor, "the retried restore keeps the authenticated reverse edge");
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("journal pending con target publicado finaliza idempotente tras SIGKILL", async () => {
  const context = await fixture("restore-crash-after-publication");
  try {
    const file = path.join(context.configRoot, "alpha.env");
    const original = config("alpha", "release-a");
    await writeFile(file, original, { mode: 0o600 });
    const first = output(run(context, "apply", [
      "--alias", "alpha", "--expected-old-digest", digest(original),
      "--set", `BUNDLE_RELEASE=${PRIVATE_A}`,
    ]));
    const successor = await readFile(file, "utf8");
    const crash = await crashRestore(context, "after", [
      "--alias", "alpha", "--expected-old-digest", digest(successor),
      "--backup", first.backup,
    ]);
    assert.equal(crash.signal, "SIGKILL", `${crash.stdout}\n${crash.stderr}`);
    assert.equal(await readFile(file, "utf8"), original,
      "publication is durable before the simulated process death");

    const journalPath = path.join(
      context.configRoot, "backups", `${first.backup}.receipt.used`,
    );
    const pending = JSON.parse(await readFile(journalPath, "utf8"));
    assert.equal(pending.state, "pending");
    assert.equal((await stat(journalPath)).nlink, 1, "SIGKILL must not leave a hard-link journal");
    assert.equal(await readFile(
      path.join(context.configRoot, "backups", pending.replacementBackup), "utf8",
    ), successor);

    const recovered = output(run(context, "restore", [
      "--alias", "alpha", "--expected-old-digest", digest(original),
      "--backup", first.backup,
    ]));
    assert.equal(recovered.status, "unchanged");
    assert.equal(recovered.oldDigest, digest(original));
    assert.equal(recovered.newDigest, digest(original));
    assert.equal(recovered.backup, pending.replacementBackup);
    assert.equal(await readFile(file, "utf8"), original);
    assert.equal(JSON.parse(await readFile(journalPath, "utf8")).state, "committed");
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("restore rechaza un backup auténtico cuyo sucesor no es el estado actual", async () => {
  const context = await fixture("restore-lineage");
  try {
    const file = path.join(context.configRoot, "alpha.env");
    const original = config("alpha", "release-a");
    await writeFile(file, original, { mode: 0o600 });
    const first = output(run(context, "apply", [
      "--alias", "alpha", "--expected-old-digest", digest(original),
      "--set", "BUNDLE_RELEASE=release-b",
    ]));
    const middle = await readFile(file, "utf8");
    output(run(context, "apply", [
      "--alias", "alpha", "--expected-old-digest", digest(middle),
      "--set", "BUNDLE_RELEASE=release-c",
    ]));
    const latest = await readFile(file, "utf8");

    const nonCausal = run(context, "restore", [
      "--alias", "alpha", "--expected-old-digest", digest(latest), "--backup", first.backup,
    ]);
    assert.equal(nonCausal.status, 2);
    assert.match(nonCausal.stderr, /estado sucesor actual/u);
    assert.equal(await readFile(file, "utf8"), latest);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("dos escritores con el mismo digest se serializan: solo uno gana el CAS", async () => {
  const context = await fixture("race");
  try {
    const file = path.join(context.configRoot, "beta.env");
    const original = config("beta", "release-a");
    await writeFile(file, original, { mode: 0o600 });
    const expected = digest(original);
    const argsA = [
      SCRIPT, "--inventory", context.inventory, "--config-root", context.configRoot,
      "--pki-root", context.pkiRoot, "apply",
      "--alias", "beta", "--expected-old-digest", expected,
      "--set", `BUNDLE_RELEASE=${PRIVATE_A}`,
    ];
    const argsB = [
      SCRIPT, "--inventory", context.inventory, "--config-root", context.configRoot,
      "--pki-root", context.pkiRoot, "apply",
      "--alias", "beta", "--expected-old-digest", expected,
      "--set", `BUNDLE_RELEASE=${PRIVATE_B}`,
    ];
    const environment = { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" };
    const results = await Promise.all([
      spawnResult(argsA, environment),
      spawnResult(argsB, environment),
    ]);
    const statuses = results.map((result) => result.status).sort();
    assert.deepEqual(statuses, [0, 2]);
    const first = results.find((result) => result.status === 0);
    const second = results.find((result) => result.status === 2);
    assert(first);
    assert(second);
    const combined = `${first.stdout}${first.stderr}${second.stdout}${second.stderr}`;
    assert.equal(combined.includes(PRIVATE_A), false);
    assert.equal(combined.includes(PRIVATE_B), false);
    assert.match(second.stderr, /compare-and-swap fallo/u);
    const final = await readFile(file, "utf8");
    assert.equal(
      final.includes(`BUNDLE_RELEASE=${PRIVATE_A}`) || final.includes(`BUNDLE_RELEASE=${PRIVATE_B}`),
      true,
    );
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("la matriz por alias impide quitar aislamiento o inyectar claves de otro harness", async () => {
  const context = await fixture("matrix");
  try {
    const file = path.join(context.configRoot, "alpha.env");
    const original = config("alpha", PRIVATE_A);
    await writeFile(file, original, { mode: 0o600 });
    const expected = digest(original);

    const missingIsolation = run(context, "apply", [
      "--alias", "alpha", "--expected-old-digest", expected, "--unset", "CONFIG_POR_ALIAS",
    ]);
    assert.equal(missingIsolation.status, 2);
    assert.match(missingIsolation.stderr, /CONFIG_POR_ALIAS/u);

    const wrongHarness = run(context, "apply", [
      "--alias", "alpha", "--expected-old-digest", expected,
      "--set", `EXPECTED_CLI_VERSION=${PRIVATE_B}`,
    ]);
    assert.equal(wrongHarness.status, 2);
    assert.match(wrongHarness.stderr, /claves incompatibles/u);

    const contradictory = run(context, "apply", [
      "--alias", "alpha", "--expected-old-digest", expected,
      "--set", `BUNDLE_RELEASE=${PRIVATE_B}`, "--unset", "BUNDLE_RELEASE",
    ]);
    assert.equal(contradictory.status, 2);
    assert.match(contradictory.stderr, /a la vez/u);

    const foreignPki = run(context, "apply", [
      "--alias", "alpha", "--expected-old-digest", expected,
      "--set", "PKI_DIR=/opt/another-alias/pki",
    ]);
    assert.equal(foreignPki.status, 2);
    assert.match(foreignPki.stderr, /PKI_DIR.*ruta acotada/u);
    assert.equal(await readFile(file, "utf8"), original);
    await assert.rejects(stat(path.join(context.configRoot, "backups")), /ENOENT/u);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("la matriz Hermes ata commit, perfil y runtime Python inmutable en una sola transaccion", async () => {
  const context = await fixture("hermes");
  try {
    const file = path.join(context.configRoot, "iza.env");
    const firstCommit = "62b2d78025c349996e753c6f7c748de035eb8048";
    const secondCommit = "d".repeat(40);
    const runtimeId = "hermes-0.20.5-62b2d78025c3-uv0.11.21-2856d1bf7e5b";
    const approvedPython = `/opt/cauce-v3-hermes-runtime/iza/${runtimeId}/venv/bin/python`;
    const original = config("iza", "release-a")
      .replace("CONFIG_POR_ALIAS=1\n", "")
      + [
        "HERMES_HOME=/home/dev/.local/share/cauce-v3/hermes/iza",
        `HERMES_SOURCE_COMMIT=${firstCommit}`,
        `HERMES_PYTHON=${approvedPython}`,
        "HERMES_INFERENCE_MODEL=provider/model",
      ].join("\n") + "\n";
    await writeFile(file, original, { mode: 0o600 });
    const expected = digest(original);

    const partial = run(context, "apply", [
      "--alias", "iza", "--expected-old-digest", expected,
      "--set", `HERMES_SOURCE_COMMIT=${secondCommit}`,
    ]);
    assert.equal(partial.status, 2);
    assert.match(partial.stderr, /pin operacional aprobado/u);
    assert.equal(await readFile(file, "utf8"), original);

    const mismatchedPath = run(context, "apply", [
      "--alias", "iza", "--expected-old-digest", expected,
      "--set", "HERMES_PYTHON=/opt/cauce-v3-hermes-runtime/iza/otro-runtime/venv/bin/python",
    ]);
    assert.equal(mismatchedPath.status, 2);
    assert.match(mismatchedPath.stderr, /HERMES_PYTHON/u);

    const unapproved = run(context, "apply", [
      "--alias", "iza", "--expected-old-digest", expected,
      "--set", `HERMES_SOURCE_COMMIT=${secondCommit}`,
      "--set", "HERMES_PYTHON=/opt/cauce-v3-hermes-runtime/iza/otro-runtime/venv/bin/python",
    ]);
    assert.equal(unapproved.status, 2);
    assert.match(unapproved.stderr, /pin operacional aprobado/u);

    const coherent = output(run(context, "apply", [
      "--alias", "iza", "--expected-old-digest", expected,
      "--set", "HERMES_INFERENCE_MODEL=provider/model-v2",
    ]));
    assert.equal(coherent.status, "updated");
    assert.match(await readFile(file, "utf8"), /HERMES_INFERENCE_MODEL=provider\/model-v2/u);
    assert.match(await readFile(file, "utf8"), new RegExp(firstCommit, "u"));
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("digest obsoleto, symlink y backup ajeno fallan sin revelar valores", async () => {
  const context = await fixture("fail-closed");
  try {
    const alpha = path.join(context.configRoot, "alpha.env");
    const beta = path.join(context.configRoot, "beta.env");
    const original = config("alpha", PRIVATE_A);
    await writeFile(alpha, original, { mode: 0o600 });
    await writeFile(beta, config("beta", PRIVATE_B), { mode: 0o600 });

    const stale = run(context, "apply", [
      "--alias", "alpha", "--expected-old-digest", SHA_B,
      "--set", `BUNDLE_RELEASE=${PRIVATE_B}`,
    ]);
    assert.equal(stale.status, 2);
    assert.match(stale.stderr, /compare-and-swap fallo/u);
    assert.equal(await readFile(alpha, "utf8"), original);

    const link = path.join(context.configRoot, "claudia.env");
    await symlink("alpha.env", link);
    const linked = run(context, "inspect", ["--alias", "claudia"]);
    assert.equal(linked.status, 2);
    assert.match(linked.stderr, /error operacional no divulgado/u);

    const invalidCli = run(context, "apply", [
      "--alias", "alpha", "--expected-old-digest", digest(original),
      "--set", PRIVATE_B,
    ]);
    assert.equal(invalidCli.status, 2);
    assert.match(invalidCli.stderr, /sintaxis invalida/u);

    const issued = output(run(context, "apply", [
      "--alias", "alpha", "--expected-old-digest", digest(original),
      "--set", "BUNDLE_RELEASE=release-after-authenticated-backup",
    ]));
    const reboundName = issued.backup.replace(/^alpha\./u, "beta.");
    const backups = path.join(context.configRoot, "backups");
    await copyFile(path.join(backups, issued.backup), path.join(backups, reboundName));
    await copyFile(
      path.join(backups, `${issued.backup}.receipt`),
      path.join(backups, `${reboundName}.receipt`),
    );
    const rebound = run(context, "restore", [
      "--alias", "beta", "--expected-old-digest", digest(config("beta", PRIVATE_B)),
      "--backup", reboundName,
    ]);
    assert.equal(rebound.status, 2);
    assert.match(rebound.stderr, /autenticacion|estado sucesor/u,
      "a valid receipt cannot be rebound to another alias or opaque backup name");
    assert.equal(await readFile(beta, "utf8"), config("beta", PRIVATE_B));
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});
