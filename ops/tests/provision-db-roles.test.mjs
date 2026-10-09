#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createHmac, pbkdf2Sync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/provision-db-roles.py");
const OWNER_URL = "postgresql://cauce:owner-secret@postgres:5432/cauce?sslmode=verify-full&sslrootcert=/run/secrets/postgres_ca\n";
const LOGINS = ["cauce_gateway", "cauce_dispatcher", "cauce_bridge", "cauce_observer_login", "cauce_fleet", "cauce_monitor", "cauce_backup"];
const FAKE_DOCKER = `#!/usr/bin/env bash
set -u
input="$(cat)"
printf '%s\\n' "$*" >> "$FAKE_LOG/argv"
if [ "$1" = exec ]; then
  if [[ "$*" == *" sh -c "* ]]; then printf '1\\n'; exit 0; fi
  if [[ "$input" == *pg_stat_activity* ]]; then printf '%s\\n' "\${FAKE_RUNTIME_CONNECTIONS:-0}"; exit 0; fi
  if [[ "$input" == *"'adhoc:'"* ]]; then
    for table in \${FAKE_ADHOC:-}; do printf 'adhoc:%s\\n' "$table"; done
    exit 0
  fi
  if [[ "$input" == *"'group:'"* ]]; then
    printf 'group:cauce_runtime\\ngroup:cauce_observer\\n'
    [ -z "\${FAKE_EXISTING:-}" ] || printf 'login:%s\\n' "$FAKE_EXISTING"
    exit 0
  fi
  printf '%s' "$input" > "$FAKE_LOG/transaction.sql"
  if [ -n "\${FAKE_SQL_FAIL:-}" ]; then
    printf "psql:<stdin>:5: ERROR:  %s\\n" "$(grep -o "PASSWORD '[^']*'" <<< "$input" | head -1)" >&2
    printf 'psql:<stdin>:5: ERROR:  role creation refused\\n' >&2
    exit 3
  fi
  exit 0
fi
if [ "$1" = run ]; then
  user="$(sed -E 's#^postgresql://([^:]+):.*#\\1#' <<< "$input")"
  printf '%s\\n' "$input" >> "$FAKE_LOG/verified-urls"
  printf '{"login":"%s","super":%s,"platform_insert":false,"tenants":true}' "$user" "\${FAKE_SUPER:-false}"
  exit 0
fi
exit 97
`;

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cauce-provision-db-roles-"));
  const bin = path.join(root, "bin");
  const log = path.join(root, "log");
  const secretsDir = path.join(root, "secrets");
  await Promise.all([mkdir(bin), mkdir(log), mkdir(secretsDir)]);
  await writeFile(path.join(bin, "docker"), FAKE_DOCKER);
  await chmod(path.join(bin, "docker"), 0o755);
  const owner = path.join(root, "database_url");
  await writeFile(owner, OWNER_URL);
  await chmod(owner, 0o400);
  const password = path.join(root, "postgres_password");
  await writeFile(password, "owner-secret");
  await chmod(password, 0o600);
  const env = path.join(root, "clone.env");
  const environment = ["COMPOSE_PROJECT_NAME=cauce-clone", "POSTGRES_USER=cauce", "POSTGRES_DB=cauce",
    `CAUCE_DATABASE_URL_SECRET_PATH=${owner}`, "CAUCE_RUNTIME_IMAGE=registry.invalid/runtime@sha256:00",
    "CAUCE_POSTGRES_CA_PATH=/etc/ssl/clone-ca.crt", `CAUCE_POSTGRES_PASSWORD_PATH=${password}`,
    "CAUCE_DATABASE_URL_GATEWAY_SECRET_PATH=/stale/path", ""].join("\n");
  await writeFile(env, environment);
  await chmod(env, 0o640);
  return { root, bin, log, secretsDir, env, environment, owner, password };
}

function run(context, extra = [], variables = {}, target = ["--container", "clone-postgres", "--secrets-dir", context.secretsDir]) {
  return spawnSync("python3", [script, "--env", context.env, "--target", "clon", ...target, ...extra], {
    encoding: "utf8", cwd: "/",
    env: { ...process.env, PATH: `${context.bin}:${process.env.PATH}`, FAKE_LOG: context.log, ...variables },
  });
}

function scramMatches(verifier, password) {
  const [, iterations, salt, stored, server] = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/u.exec(verifier) ?? [];
  const salted = pbkdf2Sync(password, Buffer.from(salt, "base64"), Number(iterations), 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  return Number(iterations) === 4096
    && createHash("sha256").update(clientKey).digest("base64") === stored
    && createHmac("sha256", salted).update("Server Key").digest("base64") === server;
}

test("the dry run prints the plan and writes nothing", async () => {
  const context = await fixture();
  try {
    const result = run(context);
    assert.equal(result.status, 0, result.stderr);
    for (const login of LOGINS) assert.match(result.stdout, new RegExp(`crear ${login} en `, "u"));
    assert.match(result.stdout, /ensayo: sin cambios/u);
    assert.deepEqual(await readdir(context.secretsDir), []);
    assert.equal(await readFile(context.env, "utf8"), context.environment);
    assert.deepEqual((await readdir(context.log)).sort(), ["argv"]);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("apply publishes private URLs atomically, sends only verifiers and never prints a secret", async () => {
  const context = await fixture();
  try {
    const result = run(context, ["--apply"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await readdir(context.secretsDir)).sort(), ["database_url_backup", "database_url_bridge",
      "database_url_dispatcher", "database_url_fleet", "database_url_gateway", "database_url_monitor", "database_url_observer"]);
    const transaction = await readFile(path.join(context.log, "transaction.sql"), "utf8");
    assert.match(transaction, /^BEGIN;\nSET LOCAL log_statement='none';/u);
    assert.match(transaction, /\nCOMMIT;\n?$/u);
    const printed = result.stdout + result.stderr + await readFile(path.join(context.log, "argv"), "utf8");
    for (const [file, login] of [["database_url_gateway", "cauce_gateway"], ["database_url_backup", "cauce_backup"]]) {
      const target = path.join(context.secretsDir, file);
      assert.equal((await stat(target)).mode & 0o777, 0o400);
      const url = new URL((await readFile(target, "utf8")).trim());
      assert.equal(url.username, login);
      assert.equal(`${url.host}${url.pathname}${url.search}`, "postgres:5432/cauce?sslmode=verify-full&sslrootcert=/run/secrets/postgres_ca");
      const password = decodeURIComponent(url.password);
      assert.ok(password.length >= 43);
      const verifier = new RegExp(`ROLE ${login} WITH LOGIN .*CONNECTION LIMIT \\d+ PASSWORD '([^']+)'`, "u").exec(transaction)?.[1] ?? "";
      assert.ok(scramMatches(verifier, password), `${login} verifier must match its URL password`);
      assert.ok(!transaction.includes(password));
      for (const secret of [password, verifier, url.href]) assert.ok(!printed.includes(secret));
    }
    assert.match(transaction, /CREATE ROLE cauce_backup WITH .* IN ROLE pg_read_all_data;/u);
    assert.match(transaction, /CREATE ROLE cauce_observer_login WITH .*CONNECTION LIMIT 5 .* IN ROLE cauce_observer;/u);
    assert.match(transaction, /CREATE ROLE cauce_dispatcher WITH .*CONNECTION LIMIT 25 /u);
    const environment = await readFile(context.env, "utf8");
    assert.doesNotMatch(environment, /\/stale\/path/u);
    for (const name of ["GATEWAY", "DISPATCHER", "BRIDGE", "OBSERVER"]) {
      assert.match(environment, new RegExp(`^CAUCE_DATABASE_URL_${name}_SECRET_PATH=${context.secretsDir}/database_url_`, "mu"));
    }
    assert.equal((await stat(context.env)).mode & 0o777, 0o640);
    const backups = (await readdir(context.root)).filter(name => name.startsWith("clone.env.pre-roles-"));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(path.join(context.root, backups[0]), "utf8"), context.environment);
    assert.equal((await readFile(path.join(context.log, "verified-urls"), "utf8")).trim().split("\n").length, LOGINS.length);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("an existing login or secret file stops everything unless rotation is explicit", async () => {
  const context = await fixture();
  try {
    const result = run(context, ["--apply"], { FAKE_EXISTING: "cauce_gateway" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--rotate/u);
    assert.deepEqual(await readdir(context.secretsDir), []);
    assert.equal(await readFile(context.env, "utf8"), context.environment);
    const rotated = run(context, ["--apply", "--rotate", "--login", "cauce_gateway"], { FAKE_EXISTING: "cauce_gateway" });
    assert.equal(rotated.status, 0, rotated.stderr);
    assert.match(await readFile(path.join(context.log, "transaction.sql"), "utf8"),
      /ALTER ROLE cauce_gateway WITH LOGIN .*\nGRANT cauce_runtime TO cauce_gateway;/u);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("a failed transaction publishes nothing and does not echo the verifier", async () => {
  const context = await fixture();
  try {
    const result = run(context, ["--apply"], { FAKE_SQL_FAIL: "1" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /psql failed with status 3: .*role creation refused/u);
    assert.doesNotMatch(result.stderr, /SCRAM-SHA-256/u);
    assert.deepEqual(await readdir(context.secretsDir), []);
    assert.equal(await readFile(context.env, "utf8"), context.environment);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("a failed verification leaves the env file untouched", async () => {
  const context = await fixture();
  try {
    const result = run(context, ["--apply"], { FAKE_SUPER: "true" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cauce_gateway failed verification .* is unchanged/u);
    assert.equal(await readFile(context.env, "utf8"), context.environment);
    assert.deepEqual((await readdir(context.root)).filter(name => name.includes("pre-roles")), []);
    assert.equal((await readdir(context.secretsDir)).length, LOGINS.length);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("a host template keeps its route while verification uses the backend network", async () => {
  const context = await fixture();
  try {
    const template = path.join(context.root, "fleet-database-url");
    await writeFile(template, "postgresql://cauce:fleet-secret@127.0.0.1:15432/cauce?sslmode=verify-full&sslrootcert=/etc/fleet-ca.crt\n");
    await chmod(template, 0o400);
    const result = run(context, ["--apply", "--login", "cauce_fleet", "--login", "cauce_monitor",
      "--template", `cauce_fleet=${template}`]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /cauce_fleet .*\[consumidor del host\]/u);
    assert.match(result.stdout, /cauce_monitor .*sin --template su URL usa el host de compose/u);
    const url = new URL((await readFile(path.join(context.secretsDir, "database_url_fleet"), "utf8")).trim());
    assert.equal(`${url.username}@${url.host}${url.pathname}${url.search}`,
      "cauce_fleet@127.0.0.1:15432/cauce?sslmode=verify-full&sslrootcert=/etc/fleet-ca.crt");
    const verified = (await readFile(path.join(context.log, "verified-urls"), "utf8")).trim().split("\n");
    assert.deepEqual(verified.map(line => new URL(line).host), ["postgres:5432", "postgres:5432"]);
    assert.equal(await readFile(context.env, "utf8"), context.environment);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("owner-only tables in public stop a switch but not a rotation", async () => {
  const context = await fixture();
  try {
    const adhoc = { FAKE_ADHOC: "deliveries_bak_replay respaldo_role_brief" };
    const plan = run(context, [], adhoc);
    assert.equal(plan.status, 0, plan.stderr);
    assert.match(plan.stdout, /sin SELECT para cauce_runtime: deliveries_bak_replay, respaldo_role_brief/u);
    const refused = run(context, ["--apply"], adhoc);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /2 owner-only tables in public .*42501/u);
    assert.deepEqual(await readdir(context.secretsDir), []);
    assert.equal(await readFile(context.env, "utf8"), context.environment);
    const rotated = run(context, ["--apply", "--rotate", "--login", "cauce_bridge"], { ...adhoc, FAKE_EXISTING: "cauce_bridge" });
    assert.equal(rotated.status, 0, rotated.stderr);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("a publish failure after the commit keeps the unpublished URLs", async () => {
  const context = await fixture();
  try {
    await mkdir(path.join(context.secretsDir, "database_url_bridge", "occupied"), { recursive: true });
    const result = run(context, ["--apply", "--rotate"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unpublished URLs stay in cauce_bridge=/u);
    const kept = (await readdir(context.secretsDir)).filter(name => name.startsWith(".provision-"));
    assert.equal(kept.length, 5);
    for (const name of kept) assert.equal((await stat(path.join(context.secretsDir, name))).mode & 0o777, 0o400);
    assert.equal((await stat(path.join(context.secretsDir, "database_url_dispatcher"))).mode & 0o777, 0o400);
    assert.equal(await readFile(context.env, "utf8"), context.environment);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("a clone rehearsal never targets the production configuration", async () => {
  const context = await fixture();
  try {
    for (const target of [["--secrets-dir", "/etc/cauce-v3/secrets"],
      ["--container", "clone-postgres", "--secrets-dir", "/etc//cauce-v3/secrets"],
      ["--container", "clone-postgres", "--secrets-dir", "etc/cauce-v3/secrets"]]) {
      const result = run(context, [], {}, target);
      assert.equal(result.status, 1, target.join(" "));
      assert.match(result.stderr, /--target clon requires/u);
    }
    await writeFile(context.env, context.environment.replace("COMPOSE_PROJECT_NAME=cauce-clone\n", ""));
    const unnamed = run(context);
    assert.equal(unnamed.status, 1);
    assert.match(unnamed.stderr, /COMPOSE_PROJECT_NAME/u);
    assert.deepEqual(await readdir(context.log), []);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("the owner password rotates only after the runtime left it, keeping the mounted password inode", async () => {
  const context = await fixture();
  try {
    const busy = run(context, ["--rotate-owner", "--apply"], { FAKE_RUNTIME_CONNECTIONS: "2" });
    assert.equal(busy.status, 1);
    assert.match(busy.stderr, /2 runtime connections still use cauce/u);
    assert.equal(await readFile(context.owner, "utf8"), OWNER_URL);
    const inode = (await stat(context.password)).ino;
    const result = run(context, ["--rotate-owner", "--apply"]);
    assert.equal(result.status, 0, result.stderr);
    const url = new URL((await readFile(context.owner, "utf8")).trim());
    const password = decodeURIComponent(url.password);
    assert.equal(url.username, "cauce");
    assert.notEqual(password, "owner-secret");
    assert.equal((await stat(context.owner)).mode & 0o777, 0o400);
    assert.equal(await readFile(context.password, "utf8"), password);
    assert.equal((await stat(context.password)).ino, inode);
    const transaction = await readFile(path.join(context.log, "transaction.sql"), "utf8");
    const verifier = /ALTER ROLE cauce WITH PASSWORD '([^']+)';/u.exec(transaction)?.[1] ?? "";
    assert.ok(scramMatches(verifier, password));
    const printed = result.stdout + result.stderr + await readFile(path.join(context.log, "argv"), "utf8");
    for (const secret of [password, verifier]) assert.ok(!printed.includes(secret));
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});
