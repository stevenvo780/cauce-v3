#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ops = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cauce = path.join(ops, "cli/cauce");

async function executable(file, source) {
  await writeFile(file, source, "utf8");
  await chmod(file, 0o755);
}

test("cauce routes exact argv to validated SSH destinations", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cauce-remote-routing-"));
  const bin = path.join(temporary, "bin");
  const localHome = path.join(temporary, "local-home");
  const remoteHome = path.join(temporary, "remote-home");
  const map = path.join(localHome, ".config/cauce-v3/alias-host.tsv");
  const sshLog = path.join(temporary, "ssh.jsonl");
  const remoteLog = path.join(temporary, "remote.jsonl");

  function environment(extra = {}) {
    return {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_LOCAL_HOME: localHome,
      FAKE_REMOTE_HOME: remoteHome,
      FAKE_SSH_LOG: sshLog,
      FAKE_REMOTE_LOG: remoteLog,
      ...extra,
    };
  }

  function run(args, extra = {}) {
    return spawnSync(cauce, args, {
      encoding: "utf8",
      input: "stdin-must-remain-local\n",
      env: environment(extra),
    });
  }

  async function sshCalls() {
    const text = await readFile(sshLog, "utf8");
    return text.trim().length === 0 ? [] : text.trim().split("\n").map((line) => JSON.parse(line));
  }

  async function remoteCalls() {
    const text = await readFile(remoteLog, "utf8");
    return text.trim().length === 0 ? [] : text.trim().split("\n").map((line) => JSON.parse(line));
  }

  try {
    await mkdir(bin);
    await mkdir(path.dirname(map), { recursive: true });
    await mkdir(path.join(remoteHome, ".local/bin"), { recursive: true });
    await Promise.all([writeFile(sshLog, ""), writeFile(remoteLog, "")]);

    await executable(path.join(bin, "getent"), `#!/bin/sh
fixture_home=$FAKE_LOCAL_HOME
[ "\${FAKE_REMOTE:-0}" = 1 ] && fixture_home=$FAKE_REMOTE_HOME
printf 'fixture:x:1000:1000::%s:/bin/sh\\n' "$fixture_home"
`);
    await executable(path.join(bin, "id"), `#!/bin/sh
[ "\${1:-}" = -u ] && { printf '1000\\n'; exit 0; }
exec /usr/bin/id "$@"
`);
    await executable(path.join(bin, "sudo"), `#!/bin/sh
[ "\${1:-}" = -u ] || exit 64
shift 2
exec "$@"
`);
    await executable(path.join(bin, "ssh"), `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(args) + "\\n");
const command = args.at(-1);
const result = spawnSync("/bin/sh", ["-c", command], {
  encoding: "utf8",
  env: { ...process.env, FAKE_REMOTE: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 70);
`);
    await executable(path.join(remoteHome, ".local/bin/cauce"), `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.FAKE_REMOTE_LOG, JSON.stringify({
  argv: process.argv.slice(2),
  home: process.env.HOME,
  runtime: process.env.XDG_RUNTIME_DIR,
  cwd: process.cwd(),
}) + "\\n");
process.exit(Number(process.env.FAKE_REMOTE_EXIT ?? "0"));
`);

    await writeFile(map, "astra\tssh:ubuntu@pc-agente\natlas    vps\n", "utf8");
    const literalArgs = ["estado", "dos palabras", "comilla'", "$(touch INYECCION)", "$HOME", "linea\n"];
    let result = run(["astra", ...literalArgs], { FAKE_REMOTE_EXIT: "37" });
    assert.equal(result.status, 37, result.stderr);
    let ssh = await sshCalls();
    let remote = await remoteCalls();
    assert.equal(ssh.length, 1);
    assert.deepEqual(ssh[0].slice(0, 2), ["-n", "ubuntu@pc-agente"]);
    assert.deepEqual(remote, [{
      argv: ["astra", ...literalArgs],
      home: remoteHome,
      runtime: "/run/user/1000",
      cwd: remoteHome,
    }]);
    assert(!result.stderr.includes("alias desconocido"));

    result = spawnSync("/bin/bash", [
      "-c",
      '"$1" astra estado; IFS= read -r remaining; printf "remaining=%s\\n" "$remaining"',
      "routing-test",
      cauce,
    ], {
      encoding: "utf8",
      input: "stdin-must-remain-local\n",
      env: environment(),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /remaining=stdin-must-remain-local/u);
    ssh = await sshCalls();
    assert.equal(ssh[1][0], "-n", "non-interactive routing must detach ssh from stdin");

    result = spawnSync("script", ["-qefc", `"${cauce}" astra estado`, "/dev/null"], {
      encoding: "utf8",
      env: environment(),
    });
    assert.equal(result.status, 0, result.stderr);
    ssh = await sshCalls();
    assert.equal(ssh[2][0], "-t", "interactive routing must allocate a remote tty");

    result = run(["atlas", ...literalArgs], { FAKE_REMOTE_EXIT: "23" });
    assert.equal(result.status, 23, result.stderr);
    ssh = await sshCalls();
    remote = await remoteCalls();
    assert.deepEqual(ssh[3].slice(0, 2), ["-n", "vps"]);
    assert.deepEqual(remote[3], {
      argv: ["atlas", ...literalArgs],
      home: remoteHome,
      runtime: "/run/user/1000",
      cwd: remoteHome,
    });

    const marker = path.join(temporary, "INYECCION");
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(remoteHome, "INYECCION")), { code: "ENOENT" });

    await writeFile(map, "astra\tssh:-oProxyCommand=malicioso\n", "utf8");
    result = run(["astra", "estado"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /ruta remota invalida/u);
    assert.equal((await sshCalls()).length, 4, "an invalid route must not invoke ssh");

    await writeFile(map, "astra\tssh:ubuntu@pc-agente\textra\n", "utf8");
    result = run(["astra", "estado"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /ruta remota invalida/u);
    assert.equal((await sshCalls()).length, 4, "a route with an extra field must fail closed");

    await writeFile(map, "astra\tvm\n", "utf8");
    result = run(["astra", "estado"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /ruta remota invalida/u);
    assert.equal((await sshCalls()).length, 4, "a legacy unknown route must fail closed");

    await writeFile(map, "astra\tssh:ubuntu@pc-agente\nastra\tlocal\n", "utf8");
    result = run(["astra", "estado"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /ruta remota invalida/u);
    assert.equal((await sshCalls()).length, 4, "a duplicate route must not fall back locally");

    await rm(map);
    await mkdir(map);
    result = run(["astra", "estado"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /no se pudo leer el mapa/u);
    assert.equal((await sshCalls()).length, 4, "an unreadable route map must fail closed");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
