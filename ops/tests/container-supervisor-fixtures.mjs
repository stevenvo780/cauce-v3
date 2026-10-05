import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const supervisorInventory = {
  schemaVersion: 2,
  systemPrincipals: {},
  historicalAliases: {},
  aliases: Object.fromEntries([
    ["argos", "Steven", "ctrl-infra", "dev", "openclaw", "/home/dev/.local/state/cauce-v3/argos"],
    ["atlas", "Miguel", "ws-humanizar", "dev", "codex", "/home/dev/.local/state/cauce-v3/atlas"],
    ["iza", "Miguel", "claw-iza", "claw", "openclaw", "/home/claw/.openclaw/cauce-v3/iza"],
    ["jarvis", "Steven", "claw", "claw", "openclaw", "/home/claw/.openclaw/cauce-v3/jarvis"],
    ["kratos", "Miguel", "ws-humanizar", "dev", "claude", "/home/dev/.local/state/cauce-v3/kratos"],
    ["zeus", "Steven", "ws-zeus", "dev", "claude", "/home/dev/.local/state/cauce-v3/zeus"],
    ["hades", "Steven", "agv2-steven-hades-oc", "claw", "grok", "/home/claw/.local/state/cauce-v3/hades"],
  ].map(([alias, tenant, container, user, harness, stateDirectory]) => [alias, {
    tenant, room: `grp.${tenant.toLowerCase()}`, container, user, home: `/home/${user}`,
    harness, stateDirectory, membershipRole: "agent", systemdUser: "stev",
    ...(harness === "openclaw" ? { workspace: `/home/${user}/clawd` } : {}),
  }])),
};

export async function prepareSupervisorOps(source, destination) {
  for (const relative of [
    "scripts/container-alias-query.py", "scripts/container_alias_lib.py",
    "scripts/validate-container-mount.py", "scripts/alias-lock-exec.py",
    "scripts/verify-hermes-runtime.py", "container-runtime/cauce-container-runtime.py",
    "container-runtime/cauce_container_base.py", "container-runtime/cauce_container_proc.py",
    "container-runtime/cauce_container_tree.py", "container-runtime/podar-releases.py",
    "hermes-runtime.json",
  ]) {
    const target = path.join(destination, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(source, relative), target);
  }
  await writeFile(path.join(destination, "container-aliases.json"), `${JSON.stringify(supervisorInventory)}\n`);
}

export function prepareOperationsOps(source, destination) {
  const result = spawnSync("python3", ["-c", [
    "import importlib.util, pathlib, shutil, subprocess, sys",
    "source, root = (pathlib.Path(value).resolve() for value in sys.argv[1:3])",
    "spec = importlib.util.spec_from_file_location('container_ops_digest', source / 'scripts/container_ops_digest.py')",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "generated = source / 'generated/container-systemd/rootless'",
    "for input_path in module.operational_files(source, generated, rootless=True):",
    "    if input_path.is_relative_to(generated):",
    "        continue",
    "    target = root / input_path.relative_to(source)",
    "    target.parent.mkdir(parents=True, exist_ok=True)",
    "    shutil.copy2(input_path, target)",
    "(root / 'container-aliases.json').write_text(sys.argv[3] + '\\n')",
    "subprocess.run([sys.executable, str(root / 'scripts/generate-container-units.py'),",
    "                '--rootless', '--home', '/home/dev'], check=True, capture_output=True)",
  ].join("\n"), source, destination, JSON.stringify(supervisorInventory)], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout} ${result.stderr}`);
}
