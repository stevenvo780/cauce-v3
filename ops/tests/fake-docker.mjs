#!/usr/bin/env node
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const statePath = process.env.FAKE_DOCKER_STATE;
if (!statePath) process.exit(125);
const state = JSON.parse(await readFile(statePath, "utf8"));
state.callCount = (state.callCount ?? 0) + 1;
const idBeforeRace = state.currentId;
if (state.raceAt === state.callCount) {
  state.currentId = state.replacementId;
  state.startedAt = state.replacementStartedAt;
  state.initStarttime = state.replacementInitStarttime;
  state.restartCount = 0;
}
if (state.restartRaceAt === state.callCount) {
  state.startedAt = state.replacementStartedAt;
  state.initStarttime = state.replacementInitStarttime;
  state.restartCount += 1;
}

function execTarget(values) {
  let index = 1;
  while (values[index]?.startsWith("-")) {
    if (values[index] === "--user") index += 2;
    else index += 1;
  }
  return { target: values[index], command: values[index + 1], args: values.slice(index + 2) };
}

let target = null;
let command = null;
let commandArgs = [];
let mutating = false;
if (argv[0] === "inspect") target = argv[3];
if (argv[0] === "cp") {
  target = argv[2]?.split(":", 1)[0] ?? null;
  mutating = true;
}
if (argv[0] === "exec") {
  ({ target, command, args: commandArgs } = execTarget(argv));
  const readOnly = command === "id" || command === "test" || commandArgs[0] === "-c"
    || commandArgs.includes("bundle-digest") || commandArgs.includes("check") || commandArgs.includes("stopped");
  mutating = !readOnly;
}
let applied = target === null || target === state.currentId || target === state.containerName;
let guardMismatch = false;
if (command === "/usr/bin/python3" && commandArgs.includes("guard-exec")) {
  const index = commandArgs.indexOf("--init-starttime");
  if (index < 0 || commandArgs[index + 1] !== String(state.initStarttime)) {
    applied = false;
    guardMismatch = true;
  }
}
await appendFile(state.log, `${JSON.stringify({
  argv,
  call: state.callCount,
  target,
  command,
  mutating,
  applied,
  idBeforeRace,
  currentId: state.currentId,
})}\n`);
await writeFile(statePath, `${JSON.stringify(state)}\n`);

// The start gate must sit BEFORE any early-exit branch: call 1 of a `start` is always
// `inspect --format {{.Id}}`, which answers and exits below — placed later, this gate is dead code.
if (state.startGate && state.callCount === 1) {
  const started = Date.now();
  let released = false;
  while (!released && Date.now() - started < 15000) {
    try {
      await readFile(state.startGate);
      released = true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (!released) process.exit(124);
}

if (argv[0] === "inspect") {
  const format = argv[2] ?? "";
  if (target === state.containerName && format === "{{.Id}}") {
    process.stdout.write(`${state.currentId}\n`);
    process.exit(0);
  }
  if (target !== state.currentId) process.exit(1);
  if (format.includes(".State.Running")) {
    process.stdout.write(`${state.running} ${state.startedAt} ${state.restartCount}\n`);
  } else if (format === "{{.Image}}") {
    process.stdout.write(`${state.imageId}\n`);
  } else if (format.includes("index .Config.Labels")) {
    process.stdout.write(`${state.labelValue}\n`);
  } else if (format === "{{json .Mounts}}") {
    process.stdout.write(`${JSON.stringify(state.mounts)}\n`);
  } else {
    process.exit(1);
  }
  process.exit(0);
}

if (target !== state.currentId) process.exit(1);
if (guardMismatch) process.exit(78);
if (argv[0] === "cp") process.exit(0);
if (argv[0] !== "exec") process.exit(0);
if (command === "id" && commandArgs[0] === "-u") process.stdout.write("1000\n");
if (command === "id" && commandArgs[0] === "-g") process.stdout.write("1000\n");
if (command === "/usr/bin/python3" && commandArgs[0] === "-c") process.stdout.write(`${state.initStarttime}\n`);
if (command === "/usr/bin/python3" && commandArgs[0] === "-c"
  && commandArgs[1]?.includes("def exact_link") && state.isolatedConfigOk === false) process.exit(1);
if ((command === "sh" || command === "bash") && commandArgs[0] === "-c"
  && commandArgs.some((value) => value.includes("hermes_cli.oneshot"))
  && state.hermesRuntimeOk === false) process.exit(1);
if (command === "test") {
  if (commandArgs[0] === "-x") process.exit(state.controlExists === false ? 1 : 0);
  if (commandArgs[0] === "-e") process.exit(state.stateExists === false ? 1 : 0);
}
if (command === "/usr/bin/python3" && commandArgs.includes("bundle-digest")) {
  process.stdout.write(`${state.bundleDigest}\n`);
}
if (command === "/usr/bin/python3" && commandArgs.includes("stop")) {
  if (state.runtimeStopFixture) {
    const actionIndex = commandArgs.indexOf("stop");
    const lifecycleArgs = commandArgs.slice(actionIndex);
    const replaceValue = (name, value) => {
      const index = lifecycleArgs.indexOf(name);
      if (index >= 0) lifecycleArgs[index + 1] = value;
    };
    replaceValue("--state", state.runtimeStopFixture.state);
    replaceValue("--control-dir", state.runtimeStopFixture.control);
    const delegated = spawnSync(
      "python3",
      [state.runtimeStopFixture.helper, ...lifecycleArgs],
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" } },
    );
    if (delegated.stderr) process.stderr.write(delegated.stderr);
    process.exit(delegated.status ?? 125);
  }
  process.exit(state.stopExit ?? 0);
}
if (command === "/usr/bin/python3" && commandArgs.includes("check")) process.exit(state.checkExit ?? 0);
if ((command === "/usr/bin/env" || commandArgs.includes("/usr/bin/env")) && state.finalGate) {
  const started = Date.now();
  let released = false;
  while (!released && Date.now() - started < 15000) {
    try {
      await readFile(state.finalGate);
      released = true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (!released) process.exit(124);
}
if ((command === "/usr/bin/env" || commandArgs.includes("/usr/bin/env")) && Number(state.finalDelayMs ?? 0) > 0) {
  await new Promise((resolve) => setTimeout(resolve, Number(state.finalDelayMs)));
}
process.exit(0);
