#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ops = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(ops, "cli/cauce");
const panel = path.join(ops, "guardias/cauce-tmux-panel");
const guard = path.join(ops, "guardias/cauce-panel-guard");

async function executable(file, source) {
  await writeFile(file, source, "utf8");
  await chmod(file, 0o755);
}

async function fixture(harness) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cauce-shared-entrypoints-"));
  const home = path.join(directory, "home");
  const bin = path.join(directory, "bin");
  const config = path.join(home, ".config/cauce-v3/container-aliases");
  const scripts = path.join(home, ".local/share/cauce-v3/ops/scripts");
  const localBin = path.join(home, ".local/bin");
  const log = path.join(directory, "calls.log");
  const credential = harness === "claude" ? "/home/dev/.claude" : "/home/dev/.codex";
  await Promise.all([
    mkdir(bin, { recursive: true }),
    mkdir(config, { recursive: true }),
    mkdir(scripts, { recursive: true }),
    mkdir(localBin, { recursive: true }),
    writeFile(log, ""),
  ]);
  await writeFile(path.join(config, "zeus.env"), [
    "SHARED_SESSION=1",
    "BUNDLE_RELEASE=release-test",
    "SHARED_SESSION_WORKSPACE=/workspace/cauce-v3",
    `CREDENTIAL_HOME=${credential}`,
    "",
  ].join("\n"));
  await executable(path.join(scripts, "container-alias-query.py"), `#!/usr/bin/env python3
print("Steven\\tgrp.steven\\tws-zeus\\tdev\\t/home/dev\\t/state/zeus\\t${harness}\\tlocal")
`);
  await executable(path.join(localBin, "cauce-tmux-panel"), `#!/usr/bin/env bash
printf 'PANEL\\t%s\\n' "$*" >> "$CAUCE_TEST_LOG"
`);
  await executable(path.join(bin, "getent"), `#!/usr/bin/env bash
[ "\${CAUCE_TEST_NO_PASSWD:-}" != 1 ] || exit 2
printf 'test:x:1000:1000::%s:/bin/bash\\n' "$CAUCE_TEST_ACCOUNT_HOME"
`);
  await executable(path.join(bin, "docker"), `#!/usr/bin/env bash
{
  printf 'DOCKER'
  for argument in "$@"; do printf '\\t%s' "$argument"; done
  printf '\\n'
} >> "$CAUCE_TEST_LOG"
case " $* " in
  *" node "*" status "*) printf '%s\\n' '{"present":true,"pid":1}' ;;
  *" sh -c "*) printf '123\\n' ;;
esac
exit 0
`);
  await executable(path.join(bin, "systemctl"), `#!/usr/bin/env bash
case " $* " in
  *" cat cauce-v3-host-"*) exit 1 ;;
  *" is-active cauce-v3-container-"*) printf 'active\\n'; exit 0 ;;
esac
exit 1
`);
  await executable(path.join(bin, "node"), `#!/usr/bin/env bash
{
  printf 'NODE\\tCODEX_HOME=%s\\tCLAUDE_CONFIG_DIR=%s' "\${CODEX_HOME:-}" "\${CLAUDE_CONFIG_DIR:-}"
  for argument in "$@"; do printf '\\t%s' "$argument"; done
  printf '\\n'
} >> "$CAUCE_TEST_LOG"
printf '{"present":true,"pid":1}\\n'
`);
  return {
    directory,
    home,
    log,
    environment: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      CAUCE_TEST_LOG: log,
      CAUCE_TEST_ACCOUNT_HOME: home,
    },
  };
}

function run(script, args, environment) {
  const result = spawnSync("bash", [script, ...args], { encoding: "utf8", env: environment });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}

function assertInvocation(log, action, harness, credentialKey, credentialValue, state = "/state/zeus") {
  const line = log.split("\n").find(candidate => candidate.includes(`\t${action}\t`));
  assert.ok(line, log);
  assert.ok(line.includes(`\t--state\t${state}`), line);
  assert.match(line, new RegExp(`\\t--harness\\t${harness}(?:\\t|$)`, "u"));
  assert.ok(line.includes(`${credentialKey}=${credentialValue}`), line);
}

for (const harness of ["claude", "codex"]) {
  const test = await fixture(harness);
  try {
    const credentialKey = harness === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
    const credentialValue = harness === "claude" ? "/home/dev/.claude" : "/home/dev/.codex";

    run(panel, ["zeus"], test.environment);
    assertInvocation(await readFile(test.log, "utf8"), "ensure", harness, credentialKey, credentialValue);

    await writeFile(test.log, "");
    run(panel, ["zeus"], { ...test.environment, HOME: path.join(test.directory, "native-workspace") });
    assertInvocation(await readFile(test.log, "utf8"), "ensure", harness, credentialKey, credentialValue);

    await writeFile(test.log, "");
    run(panel, ["zeus"], { ...test.environment, CAUCE_TEST_NO_PASSWD: "1" });
    assertInvocation(await readFile(test.log, "utf8"), "ensure", harness, credentialKey, credentialValue);

    await writeFile(test.log, "");
    run(guard, ["--dry-run"], test.environment);
    assertInvocation(await readFile(test.log, "utf8"), "status", harness, credentialKey, credentialValue);

    await writeFile(test.log, "");
    const source = `source <(sed '/^uso()/,$d' ${JSON.stringify(cli)})
sesion status zeus ws-zeus dev ${harness} /state/zeus
sesion ensure zeus ws-zeus dev ${harness} /state/zeus
`;
    const result = spawnSync("bash", ["-c", source], { encoding: "utf8", env: test.environment });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const calls = await readFile(test.log, "utf8");
    assertInvocation(calls, "status", harness, credentialKey, credentialValue);
    assertInvocation(calls, "ensure", harness, credentialKey, credentialValue);
  } finally {
    await rm(test.directory, { recursive: true, force: true });
  }
}

const native = await fixture("codex");
try {
  const releaseRoot = path.join(native.directory, "release");
  const helper = path.join(releaseRoot, "packages/adapter-sdk/dist/src/bin/shared-session.js");
  await mkdir(path.dirname(helper), { recursive: true });
  await writeFile(helper, "");
  await executable(path.join(native.directory, "bin/systemctl"), `#!/usr/bin/env bash
case " $* " in
  *" cat cauce-v3-host-kant.service"*) printf 'ExecStart=node ${releaseRoot}/packages/adapter-sdk/dist/src/bin/adapter.js\\n'; exit 0 ;;
  *" show cauce-v3-host-kant.service -p Environment"*) printf 'CAUCE_SHARED_SESSION_WORKSPACE=/workspace/cauce-v3 CODEX_HOME=/home/stev/.codex\\n'; exit 0 ;;
esac
exit 1
`);
  const source = `source <(sed '/^uso()/,$d' ${JSON.stringify(cli)})
sesion status kant '' stev codex /state/kant
sesion ensure kant '' stev codex /state/kant
`;
  const result = spawnSync("bash", ["-c", source], { encoding: "utf8", env: native.environment });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await readFile(native.log, "utf8");
  assertInvocation(calls, "status", "codex", "CODEX_HOME", "/home/stev/.codex", "/state/kant");
  assertInvocation(calls, "ensure", "codex", "CODEX_HOME", "/home/stev/.codex", "/state/kant");
} finally {
  await rm(native.directory, { recursive: true, force: true });
}

const tuple = await fixture("claude");
try {
  const source = `source <(sed '/^case /,$d' ${JSON.stringify(cli)})
alias_info() { printf 'Steven\\tgrp.steven\\tws-zeus\\tdev\\t/home/dev\\t/state/zeus\\tclaude\\tlocal\\n'; }
unit_del_alias() { printf 'unit\\n'; }
systemctl_user_o_avisa() { return 0; }
pids_del_alias() { printf '123\\n'; }
adaptador_activo() { printf 'active\\n'; }
compartida_configurada() { return 0; }
sesion() { printf 'SESSION\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$@" >> "$CAUCE_TEST_LOG"; [ "$1" != status ] || printf '{"present":true}'; }
cmd_on zeus
`;
  const result = spawnSync("bash", ["-c", source], { encoding: "utf8", env: tuple.environment });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const calls = await readFile(tuple.log, "utf8");
  assert.match(calls, /SESSION\tensure\tzeus\tws-zeus\tdev\tclaude\t\/state\/zeus/u);
  assert.match(calls, /SESSION\tstatus\tzeus\tws-zeus\tdev\tclaude\t\/state\/zeus/u);
  assert.ok(!calls.includes("claude\tlocal"), calls);
} finally {
  await rm(tuple.directory, { recursive: true, force: true });
}

for (const harness of ["claude", "codex"]) {
  for (const hostNative of [true, false]) {
    for (const shared of [true, false]) {
      const test = await fixture(harness);
      try {
        const credentialKey = harness === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
        const credentialValue = "/unit/configuration with spaces";
        await executable(path.join(test.directory, "bin", harness), `#!/usr/bin/env bash
{
  printf 'NATIVE\\tHOME=%s\\tPWD=%s\\tCREDENTIAL=%s' "$HOME" "$PWD" "$${credentialKey}"
  for argument in "$@"; do printf '\\t%s' "$argument"; done
  printf '\\n'
} >> "$CAUCE_TEST_LOG"
`);
        await executable(path.join(test.directory, "bin/systemctl"), `#!/usr/bin/env bash
case " $* " in
  *" show cauce-v3-host-native.service -p Environment"*) printf '%s\\n' '"${credentialKey}=${credentialValue}" OTHER=x'; exit 0 ;;
esac
exit 1
`);
        const source = `source <(sed '/^case /,$d' ${JSON.stringify(cli)})
alias_info() { printf 'Steven\\tgrp.steven\\tws-native\\tdev\\t${test.home}\\t/state/native\\t${harness}\\tlocal\\n'; }
adaptador_activo() { printf 'active\\n'; }
compartida_configurada() { return ${shared ? 0 : 1}; }
sesion() { return 1; }
es_host_native() { return ${hostNative ? 0 : 1}; }
cmd_entrar native
`;
        const result = spawnSync("bash", ["-c", source], {
          encoding: "utf8",
          env: { ...test.environment, HOME: path.join(test.directory, "unrelated-home") },
        });
        const calls = await readFile(test.log, "utf8");
        if (shared) {
          assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
          assert.match(result.stdout, /NO se pudo abrir; no se lanzara una sesion aparte/u);
          assert.doesNotMatch(result.stdout, /modo: .*APARTE/u);
          assert.equal(calls, "");
          continue;
        }
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.match(result.stdout, /APARTE/u);
        assert.match(calls, hostNative ? /^NATIVE\t/u : /^DOCKER\t/u);
        assert.ok(calls.includes(harness === "claude" ? "--dangerously-skip-permissions" : "--yolo"), calls);
        if (harness === "claude") assert.ok(calls.includes("--permission-mode\tbypassPermissions"), calls);
        if (hostNative) {
          assert.ok(calls.includes(`HOME=${test.home}\tPWD=${test.home}\tCREDENTIAL=${credentialValue}`), calls);
          assert.ok(!calls.includes("DOCKER"), calls);
        }
      } finally {
        await rm(test.directory, { recursive: true, force: true });
      }
    }
  }
}

// grok: with SHARED_SESSION=1 `cauce <alias>` attaches to the adapter's tmux TUI (the SAME
// conversation as Telegram); only without it does it fall back to a branch of the DM.
for (const shared of [true, false]) {
  const test = await fixture("grok");
  try {
    await writeFile(path.join(test.home, ".config/cauce-v3/container-aliases/hades.env"),
      "SHARED_SESSION=1\nBUNDLE_RELEASE=release-test\nSHARED_SESSION_WORKSPACE=/home/claw\n");
    await executable(path.join(test.home, ".local/bin/cauce-attach"), `#!/usr/bin/env python3
import os, sys
with open(os.environ["CAUCE_TEST_LOG"], "a") as log:
    log.write("ATTACH\\t" + "\\t".join(sys.argv[1:]) + "\\n")
`);
    const source = `source <(sed '/^case /,$d' ${JSON.stringify(cli)})
alias_info() { printf 'Steven\\tgrp.steven\\tagv2-steven-hades-oc\\tclaw\\t/home/claw\\t/state/hades\\tgrok\\tlocal\\n'; }
adaptador_activo() { printf 'active\\n'; }
compartida_configurada() { return ${shared ? 0 : 1}; }
avisos() { :; }
cmd_entrar hades
`;
    const result = spawnSync("bash", ["-c", source], { encoding: "utf8", env: test.environment });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const calls = await readFile(test.log, "utf8");
    if (shared) {
      assert.match(result.stdout, /COMPARTIDA/u);
      const ensure = calls.split("\n").find((line) => line.includes("\tensure\t"));
      assert.ok(ensure?.includes("\t--harness\tgrok"), calls);
      assert.ok(ensure.includes("\t--state\t/state/hades") && ensure.includes("\t--workspace\t/home/claw"), calls);
      assert.match(calls, /DOCKER\texec\t-it\t--user\tclaw\tagv2-steven-hades-oc\ttmux\t-L\tcauce\tattach-session\t-t\tcauce-hades:agente/u);
      assert.ok(!calls.includes("ATTACH"), "la compartida no abre un segundo grok");
    } else {
      assert.match(result.stdout, /APARTE.*rama \(--fork-session\) del DM/u);
      assert.match(result.stdout, /falta SHARED_SESSION=1/u);
      assert.match(calls, /ATTACH\thades\t--dm\t--bifurcar/u);
      assert.ok(!calls.includes("attach-session"), calls);
    }
  } finally {
    await rm(test.directory, { recursive: true, force: true });
  }
}

// muse: the same as grok. With SHARED_SESSION=1 `cauce hegel` attaches to the adapter's tmux TUI;
// without it, the real Muse TUI in a conversation of its own (APARTE), at max effort.
for (const shared of [true, false]) {
  const test = await fixture("muse");
  try {
    await writeFile(path.join(test.home, ".config/cauce-v3/container-aliases/hegel.env"),
      "SHARED_SESSION=1\nBUNDLE_RELEASE=release-test\n");
    const source = `source <(sed '/^case /,$d' ${JSON.stringify(cli)})
alias_info() { printf 'Miguel\\tgrp.miguel\\tws-humanizar\\tdev\\t/home/dev\\t/state/hegel\\tmuse\\tlocal\\n'; }
adaptador_activo() { printf 'active\\n'; }
compartida_configurada() { return ${shared ? 0 : 1}; }
avisos() { :; }
cmd_entrar hegel
`;
    const result = spawnSync("bash", ["-c", source], { encoding: "utf8", env: test.environment });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const calls = await readFile(test.log, "utf8");
    if (shared) {
      assert.match(result.stdout, /COMPARTIDA/u);
      const ensure = calls.split("\n").find((line) => line.includes("\tensure\t"));
      assert.ok(ensure?.includes("\t--harness\tmuse") && ensure.includes("\t--state\t/state/hegel"), calls);
      assert.match(calls, /DOCKER\texec\t-it\t--user\tdev\tws-humanizar\ttmux\t-L\tcauce\tattach-session\t-t\tcauce-hegel:agente/u);
    } else {
      assert.match(result.stdout, /APARTE/u);
      assert.match(result.stdout, /falta SHARED_SESSION=1/u);
      assert.match(calls, /--reasoning-effort max/u);
      assert.ok(!calls.includes("attach-session"), calls);
    }
  } finally {
    await rm(test.directory, { recursive: true, force: true });
  }
}

// Shared TUI and gateway bridges lack the adapter's CAUCE_ALIAS and must survive its shutdown.
{
  const alias = `barrido${process.pid}`;
  const release = `/opt/cauce-v3-adapter/${alias}/releases/r1/packages/adapter-sdk/dist/src/bin`;
  const spawnProbe = (script, environment) => spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", `${release}/${script}`], {
    env: environment, stdio: "ignore", detached: false,
  });
  const clean = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  const bridges = ["cauce-mcp.js", "cauce-decisiones-mcp.js"].map((script) => ({
    script,
    unowned: spawnProbe(script, clean),
    owned: spawnProbe(script, { ...clean, CAUCE_ALIAS: alias }),
  }));
  const adapter = spawnProbe("grok.js", clean);
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const sweep = /^BARRIDO='(.*)'(?:\s+#.*)?$/mu.exec(await readFile(cli, "utf8"))?.[1];
    assert.ok(sweep !== undefined, "cauce defines BARRIDO");
    assert.equal(/^BARRIDO='(.*)'$/mu.exec(await readFile(guard, "utf8"))?.[1], sweep, "the panel guard sweeps the same way");
    const found = spawnSync("sh", ["-c", sweep.replaceAll("@@A@@", alias)], { encoding: "utf8" })
      .stdout.split("\n").filter((line) => line !== "");
    assert.ok(found.includes(String(adapter.pid)), `the adapter counts: ${found.join(" ")}`);
    for (const { script, owned, unowned } of bridges) {
      assert.ok(found.includes(String(owned.pid)), `${script} with CAUCE_ALIAS counts: ${found.join(" ")}`);
      assert.ok(!found.includes(String(unowned.pid)), `${script} without CAUCE_ALIAS does not: ${found.join(" ")}`);
    }
  } finally {
    for (const child of [...bridges.flatMap(({ owned, unowned }) => [owned, unowned]), adapter]) child.kill("SIGKILL");
  }
}

console.log("shared session entrypoints: OK");
