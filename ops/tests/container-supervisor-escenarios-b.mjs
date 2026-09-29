import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, chown, lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

// Escenarios lifecycle movidos desde container-supervisor.test.mjs (poda T060-D).
// Continua el mismo flujo secuencial: lee statePath/result/calls que escenariosA dejo en ctx.
export async function escenariosB(ctx) {
  const {
      temporary, release, bundleDigest, cleanupGroups, cleanupProcesses, privilegedChildren, privilegedRoots,
      executable, writeConfig, dockerState, runSupervisor, clearLog, records, waitForFile, waitForMetadataPhase,
      processAlive, processIdentity, waitProcessGone, waitForCommand, lifecycleContainerId, lifecycleGeneration,
      replacementGeneration, runningAsRoot, testIdentity, metadataName, lockName, makeControl, lifecycleArgs,
      lifecycleEnv, runArgs, startManaged, stopManaged, stopManagedAtGate, runtimeHelper, droppedFromRoot,
  } = ctx;
  let statePath = ctx.statePath;
  let result = ctx.result;
  let calls = ctx.calls;
  // Real process-group stop kills a TERM-resistant descendant but not an unrelated process.
  const lifecycleBundle = path.join(temporary, "lifecycle-fixtures");
  await mkdir(lifecycleBundle, { mode: 0o755 });
  const resistant = path.join(lifecycleBundle, "resistant.py");
  const childPidFile = path.join(temporary, "resistant-child.pid");
  await executable(resistant, `#!/usr/bin/env python3
import signal, subprocess, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
child = subprocess.Popen([sys.executable, '-c', "import os,signal,time; os.setsid(); signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)"])
open(sys.argv[1], 'w', encoding='utf-8').write(str(child.pid))
time.sleep(60)
`);
  const simple = path.join(lifecycleBundle, "simple.py");
  await executable(simple, "#!/usr/bin/env python3\nimport time\ntime.sleep(60)\n");
  const earlyExit = path.join(lifecycleBundle, "early-exit.py");
  await executable(earlyExit, "#!/usr/bin/env python3\nimport sys,time\ntime.sleep(0.03)\nsys.exit(78)\n");
  const invalidIdentity = path.join(lifecycleBundle, "invalid-identity.py");
  await executable(invalidIdentity,
    "#!/usr/bin/env python3\nimport os\nos.execv('/bin/sleep', ['/bin/sleep', '60'])\n");
  const reexec = path.join(lifecycleBundle, "reexec.py");
  await executable(reexec, `#!/usr/bin/env python3
import os, sys, time
while not os.path.exists(sys.argv[1]):
    time.sleep(0.01)
os.execv('/bin/sleep', ['/bin/sleep', '60'])
`);
  const atomicMover = path.join(lifecycleBundle, "atomic-mover.py");
  await executable(atomicMover, `#!/usr/bin/env python3
import os, subprocess, sys, time
move, moved, pidfile = sys.argv[1:]
code = """import os,sys,time
move,moved=sys.argv[1:]
while not os.path.exists(move): time.sleep(0.01)
os.setsid()
with open(moved, 'w', encoding='utf-8') as stream: stream.write(str(os.getpid()))
os.execve('/bin/sleep', ['/bin/sleep', '60'], {})
"""
child = subprocess.Popen([sys.executable, '-c', code, move, moved])
with open(pidfile, 'w', encoding='utf-8') as stream: stream.write(str(child.pid))
time.sleep(60)
`);
  const lifecycleState = path.join(temporary, "lifecycle-state");
  const lifecycleControl = await makeControl("lifecycle");
  await mkdir(lifecycleState, { mode: 0o700 });

  // A child may fail transiently after successful exec but before the controller samples two stable
  // identity snapshots; propagate its outcome instead of stranding systemd on permanent exit 78.
  const earlyExitState = path.join(temporary, "early-exit-state");
  const earlyExitControl = await makeControl("early-exit");
  await mkdir(earlyExitState, { mode: 0o700 });
  result = spawnSync("python3", runArgs(earlyExitState, earlyExitControl, earlyExit), {
    encoding: "utf8",
    env: lifecycleEnv(earlyExitState, earlyExitControl, lifecycleGeneration),
  });
  assert.equal(result.status, 70,
    `reserved early adapter exit must remap to the restartable code: ${result.stdout} ${result.stderr}`);
  assert.doesNotMatch(result.stderr, /did not establish its executable identity/u);
  await assert.rejects(lstat(path.join(earlyExitControl, metadataName)),
    "early child exit must clean starting metadata before systemd retries");

  // A live process that replaced the requested command before identity was
  // established is still a permanent mismatch and must not enter a retry loop.
  const invalidIdentityState = path.join(temporary, "invalid-identity-state");
  const invalidIdentityControl = await makeControl("invalid-identity");
  await mkdir(invalidIdentityState, { mode: 0o700 });
  result = spawnSync("python3", runArgs(invalidIdentityState, invalidIdentityControl, invalidIdentity), {
    encoding: "utf8",
    env: lifecycleEnv(invalidIdentityState, invalidIdentityControl, lifecycleGeneration),
    timeout: 10_000,
  });
  assert.equal(result.status, 78,
    `live invalid executable identity must remain permanent: ${result.stdout} ${result.stderr}`);
  assert.match(result.stderr, /did not establish its executable identity/u);
  process.stdout.write("early child exit: restartable 70; live invalid identity: permanent 78\n");

  const unrelated = spawn("/bin/sleep", ["60"], { stdio: "ignore", detached: true });
  cleanupGroups.push(unrelated.pid);
  let managed = await startManaged(lifecycleState, lifecycleControl, resistant, [childPidFile]);
  await waitForFile(childPidFile);
  const descendantPid = Number((await readFile(childPidFile, "utf8")).trim());
  const leaderPid = managed.document.pid;
  assert.equal(managed.document.pid, managed.document.pgid);
  assert.equal(managed.document.pid, managed.document.sid);
  // The metadata and lock live in the control dir, never in the runtime-owned state dir.
  await lstat(path.join(lifecycleControl, metadataName));
  await lstat(path.join(lifecycleControl, lockName));
  assert.equal(await stat(lifecycleState).then((s) => s.isDirectory()), true);
  await assert.rejects(lstat(path.join(lifecycleState, metadataName)), "metadata must not live in the state dir");
  result = stopManaged(lifecycleState, lifecycleControl);
  assert.equal(result.status, 0, result.stderr);
  await waitProcessGone(leaderPid);
  await waitProcessGone(descendantPid);
  // The controller exits and releases the control lock on its own after a running-phase stop.
  await waitProcessGone(managed.child.pid);
  assert.equal(processAlive(unrelated.pid), true);
  result = spawnSync("python3", lifecycleArgs("stopped", lifecycleState, lifecycleControl), { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  process.kill(-unrelated.pid, "SIGTERM");

  // Non-lineage metadata mismatches are preserved and never signalled. An
  // executable-only mismatch is different: the proven same lineage must be stopped.
  async function tamperCase(mutator, { terminate = false } = {}) {
    const state = path.join(temporary, `tamper-${Math.random().toString(16).slice(2)}`);
    const control = await makeControl("tamper");
    await mkdir(state, { mode: 0o700 });
    const running = await startManaged(state, control, simple);
    const original = running.document;
    const tampered = mutator(JSON.parse(JSON.stringify(original)));
    await writeFile(running.metadata, typeof tampered === "string" ? tampered : `${JSON.stringify(tampered)}\n`);
    const before = await readFile(running.metadata, "utf8");
    const stopped = stopManaged(state, control);
    if (terminate) {
      assert.equal(stopped.status, 0, stopped.stderr);
      await waitProcessGone(original.pid);
      await assert.rejects(lstat(running.metadata), "successful stop must remove lifecycle metadata");
    } else {
      assert.equal(stopped.status, 78);
      assert.equal(processAlive(original.pid), true);
      assert.equal(await readFile(running.metadata, "utf8"), before);
      await lstat(path.join(control, lockName));
      await writeFile(running.metadata, `${JSON.stringify(original)}\n`);
      assert.equal(stopManaged(state, control).status, 0);
      await waitProcessGone(original.pid);
    }
  }
  await tamperCase((value) => ({ ...value, alias: "argos" }));
  await tamperCase((value) => ({ ...value, starttime: value.starttime + 1 }));
  const unrelatedTamper = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
  cleanupProcesses.push(unrelatedTamper);
  await tamperCase((value) => ({ ...value, pid: unrelatedTamper.pid }));
  assert.equal(processAlive(unrelatedTamper.pid), true);
  unrelatedTamper.kill("SIGTERM");
  await tamperCase(
    (value) => ({ ...value, executable: { ...value.executable, sha256: `sha256:${"0".repeat(64)}` } }),
    { terminate: true },
  );
  process.stdout.write("same-lineage executable-only mismatch: terminated\n");
  await tamperCase((value) => ({ ...value, runtimeUid: value.runtimeUid + 100000 }));
  await tamperCase((value) => `{"pid":${value.pid}}\n`);

  // A real execve keeps PID/starttime/PGID/SID/UID/env but changes executable
  // identity. It must not evade stop, and stop must not return before it is gone.
  const reexecState = path.join(temporary, "same-lineage-reexec-state");
  const reexecControl = await makeControl("same-lineage-reexec");
  const reexecMarker = path.join(temporary, "same-lineage-reexec.go");
  await mkdir(reexecState, { mode: 0o700 });
  const reexecManaged = await startManaged(reexecState, reexecControl, reexec, [reexecMarker]);
  await writeFile(reexecMarker, "go\n");
  await waitForCommand(reexecManaged.document.pid, "/bin/sleep");
  const afterExec = processIdentity(reexecManaged.document.pid);
  assert.equal(afterExec.starttime, reexecManaged.document.starttime);
  assert.equal(afterExec.pgid, reexecManaged.document.pgid);
  assert.equal(afterExec.sid, reexecManaged.document.sid);
  result = stopManaged(reexecState, reexecControl);
  assert.equal(result.status, 0, `same-lineage re-exec must be terminated: ${result.stderr}`);
  await waitProcessGone(reexecManaged.document.pid);
  process.stdout.write("same-lineage real re-exec: terminated and gone before stop returned\n");

  // Pin the complete observed target set before the first signal. While stop is gated, kill the controller
  // and move a child to a new session with an empty environment: the pre-opened pidfd must still target it.
  const atomicState = path.join(temporary, "atomic-stop-state");
  const atomicControl = await makeControl("atomic-stop");
  const atomicMove = path.join(temporary, "atomic-stop.move");
  const atomicMoved = path.join(temporary, "atomic-stop.moved");
  const atomicPidFile = path.join(temporary, "atomic-stop-child.pid");
  const atomicGate = path.join(temporary, "atomic-stop.pinned");
  const atomicRelease = path.join(temporary, "atomic-stop.release");
  await mkdir(atomicState, { mode: 0o700 });
  const atomicManaged = await startManaged(atomicState, atomicControl, atomicMover, [atomicMove, atomicMoved, atomicPidFile]);
  await waitForFile(atomicPidFile);
  const atomicChildPid = Number((await readFile(atomicPidFile, "utf8")).trim());
  const gatedAtomicStop = await stopManagedAtGate(atomicState, atomicControl, atomicGate, atomicRelease);
  atomicManaged.child.kill("SIGKILL");
  await waitProcessGone(atomicManaged.child.pid);
  await writeFile(atomicMove, "move\n");
  await waitForFile(atomicMoved);
  assert.notEqual(processIdentity(atomicChildPid).pgid, atomicManaged.document.pgid,
    "the child moved out of the metadata process group during the stop barrier");
  await writeFile(atomicRelease, "release\n");
  const atomicStop = await gatedAtomicStop.completed;
  assert.equal(atomicStop.status, 0, `pidfd-pinned stop must succeed: ${atomicStop.stderr}`);
  await waitProcessGone(atomicManaged.document.pid);
  await waitProcessGone(atomicChildPid);
  process.stdout.write("atomic stop barrier: moved identity-cleared child terminated through pinned pidfd\n");

  // ---- PGID reuse AFTER the leader is reaped: an alien in the freed process group
  // must NEVER be signalled. The gated stop pins the leader (and controller) BEFORE the
  // alien exists. The controller is then removed so its own run-path teardown never runs;
  // an env-scrubbed alien joins the leader's process group; the leader is reaped, freeing
  // its PID/PGID number. On release, a numeric PGID re-sweep would catch the alien -- the
  // fix forbids re-enumerating a PGID once its pinned leader has exited, so the alien lives.
  const pgidLeader = path.join(lifecycleBundle, "pgid-leader.py");
  await executable(pgidLeader, `#!/usr/bin/env python3
import os, subprocess, sys, time
trigger, npidfile = sys.argv[1:3]
while not os.path.exists(trigger):
    time.sleep(0.01)
# The alien inherits our PGID/SID (== leader PID == recorded metadata PGID) but carries
# NO CAUCE_* identity, so it is a true outsider that merely occupies the reused group.
alien = subprocess.Popen(['/bin/sleep', '60'], env={'PATH': '/usr/bin:/bin'})
with open(npidfile, 'w', encoding='utf-8') as stream:
    stream.write(str(alien.pid))
time.sleep(60)
`);
  const reuseState = path.join(temporary, "pgid-reuse-state");
  const reuseControl = await makeControl("pgid-reuse");
  const reuseTrigger = path.join(temporary, "pgid-reuse.trigger");
  const reuseNpid = path.join(temporary, "pgid-reuse.npid");
  const reuseGate = path.join(temporary, "pgid-reuse.pinned");
  const reuseRelease = path.join(temporary, "pgid-reuse.release");
  await mkdir(reuseState, { mode: 0o700 });
  const reuseManaged = await startManaged(reuseState, reuseControl, pgidLeader, [reuseTrigger, reuseNpid]);
  const reuseLeader = reuseManaged.document.pid;
  // Pin the leader (and controller) while the alien does not yet exist.
  const gatedReuse = await stopManagedAtGate(reuseState, reuseControl, reuseGate, reuseRelease);
  // Remove the controller so only the already-pinned external stop is in play; the
  // starting/running metadata stays intact because a SIGKILL runs no cleanup.
  reuseManaged.child.kill("SIGKILL");
  await waitProcessGone(reuseManaged.child.pid);
  // The alien joins the leader's process group AFTER pinning, so it is unpinned.
  await writeFile(reuseTrigger, "go\n");
  await waitForFile(reuseNpid);
  const alienPid = Number((await readFile(reuseNpid, "utf8")).trim());
  cleanupProcesses.push({ kill(sig) { try { process.kill(alienPid, sig); } catch { /* gone */ } } });
  assert.equal(processIdentity(alienPid).pgid, reuseManaged.document.pgid,
    "the alien occupies the reaped leader's numeric process group");
  // Reap the leader: its PID/PGID number is now reusable, exactly the dangerous window.
  process.kill(reuseLeader, "SIGKILL");
  await waitProcessGone(reuseLeader);
  // Release the barrier; the signalling sweep must not re-enumerate the defunct PGID.
  await writeFile(reuseRelease, "release\n");
  const reuseStop = await gatedReuse.completed;
  assert.equal(reuseStop.status, 0, `stop must complete after the leader is reaped: ${reuseStop.stderr}`);
  assert.equal(processAlive(alienPid), true, "the alien in the reused PGID must NEVER be signalled");
  process.kill(alienPid, "SIGKILL");
  await waitProcessGone(alienPid);
  process.stdout.write("PGID reuse after leader reap: alien in the freed process group was not signalled\n");

  // PID-reuse analogue: metadata points at a genuinely different live process whose starttime and
  // process group differ. It remains untouched and metadata preserved with a permanent (78) refusal.
  const reusedState = path.join(temporary, "different-process-state");
  const reusedControl = await makeControl("different-process");
  await mkdir(reusedState, { mode: 0o700 });
  const reusedManaged = await startManaged(reusedState, reusedControl, simple);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const differentProcess = spawn("/bin/sleep", ["60"], { stdio: "ignore", detached: true });
  cleanupGroups.push(differentProcess.pid);
  const differentIdentity = processIdentity(differentProcess.pid);
  assert.notEqual(differentIdentity.starttime, reusedManaged.document.starttime);
  assert.notEqual(differentIdentity.pgid, reusedManaged.document.pgid);
  const reusedDocument = { ...reusedManaged.document, pid: differentProcess.pid };
  const reusedBody = `${JSON.stringify(reusedDocument)}\n`;
  await writeFile(reusedManaged.metadata, reusedBody);
  result = stopManaged(reusedState, reusedControl);
  assert.equal(result.status, 78, result.stderr);
  assert.equal(processAlive(differentProcess.pid), true, "different current process must be preserved");
  assert.equal(processAlive(reusedManaged.document.pid), true, "original adapter must also be preserved on refusal");
  assert.equal(await readFile(reusedManaged.metadata, "utf8"), reusedBody);
  await writeFile(reusedManaged.metadata, `${JSON.stringify(reusedManaged.document)}\n`);
  assert.equal(stopManaged(reusedState, reusedControl).status, 0);
  await waitProcessGone(reusedManaged.document.pid);
  process.kill(-differentProcess.pid, "SIGTERM");
  await waitProcessGone(differentProcess.pid);
  process.stdout.write("different-process PID-reuse mismatch: preserved with exit 78\n");

  // Environment identity is an ambiguity detector, never targeting authority: a same-UID process in
  // another session can copy every CAUCE identity variable; stop/stopped must refuse (78) untouched.
  const forgedEnvState = path.join(temporary, "forged-env-state");
  const forgedEnvControl = await makeControl("forged-env");
  await mkdir(forgedEnvState, { mode: 0o700 });
  const forgedEnvManaged = await startManaged(forgedEnvState, forgedEnvControl, simple);
  const forgedEnvProcess = spawn("/bin/sleep", ["60"], {
    stdio: "ignore",
    detached: true,
    env: lifecycleEnv(forgedEnvState, forgedEnvControl, lifecycleGeneration),
  });
  cleanupGroups.push(forgedEnvProcess.pid);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.notEqual(processIdentity(forgedEnvProcess.pid).pgid, forgedEnvManaged.document.pgid);
  const forgedMetadataBody = await readFile(forgedEnvManaged.metadata, "utf8");
  result = stopManaged(forgedEnvState, forgedEnvControl);
  assert.equal(result.status, 78, result.stderr);
  assert.equal(processAlive(forgedEnvProcess.pid), true, "environment-only process must not be signalled");
  assert.equal(processAlive(forgedEnvManaged.document.pid), true, "real leader is preserved on ambiguous stop");
  assert.equal(await readFile(forgedEnvManaged.metadata, "utf8"), forgedMetadataBody);
  const forgedStopped = spawnSync("python3", lifecycleArgs("stopped", forgedEnvState, forgedEnvControl), { encoding: "utf8" });
  assert.equal(forgedStopped.status, 78, forgedStopped.stderr);
  process.kill(-forgedEnvProcess.pid, "SIGKILL");
  await waitProcessGone(forgedEnvProcess.pid);
  result = stopManaged(forgedEnvState, forgedEnvControl);
  assert.equal(result.status, 0, `registered leader must remain stoppable after ambiguity clears: ${result.stderr}`);
  await waitProcessGone(forgedEnvManaged.document.pid);
  process.stdout.write("forged environment outsider: preserved with exit 78; registered leader later stopped with exit 0\n");

  // If the registered leader is absent, an env-matching outsider still cannot be
  // promoted into a target. Metadata remains for operator/container resolution.
  const absentLeaderState = path.join(temporary, "absent-leader-forged-env-state");
  const absentLeaderControl = await makeControl("absent-leader-forged-env");
  await mkdir(absentLeaderState, { mode: 0o700 });
  const absentLeaderManaged = await startManaged(absentLeaderState, absentLeaderControl, simple);
  const absentLeaderDocument = absentLeaderManaged.document;
  absentLeaderManaged.child.kill("SIGKILL");
  await waitProcessGone(absentLeaderManaged.child.pid);
  process.kill(-absentLeaderDocument.pgid, "SIGKILL");
  await waitProcessGone(absentLeaderDocument.pid);
  await writeFile(absentLeaderManaged.metadata, `${JSON.stringify(absentLeaderDocument)}\n`);
  const absentLeaderOutsider = spawn("/bin/sleep", ["60"], {
    stdio: "ignore",
    detached: true,
    env: lifecycleEnv(absentLeaderState, absentLeaderControl, lifecycleGeneration),
  });
  cleanupGroups.push(absentLeaderOutsider.pid);
  result = stopManaged(absentLeaderState, absentLeaderControl);
  assert.equal(result.status, 78, result.stderr);
  assert.equal(processAlive(absentLeaderOutsider.pid), true, "env match cannot replace an absent registered leader");
  assert.equal(await readFile(absentLeaderManaged.metadata, "utf8"), `${JSON.stringify(absentLeaderDocument)}\n`);
  process.kill(-absentLeaderOutsider.pid, "SIGKILL");
  await waitProcessGone(absentLeaderOutsider.pid);
  process.stdout.write("absent registered leader plus forged environment outsider: preserved with exit 78\n");

  // EACCES on an otherwise valid 0700 control path is a clean permanent error,
  // never a traceback or a false stopped result.
  const inaccessibleState = path.join(temporary, "inaccessible-control-state");
  const inaccessibleControl = await makeControl("inaccessible-control");
  await mkdir(inaccessibleState, { mode: 0o700 });
  const inaccessibleManaged = await startManaged(inaccessibleState, inaccessibleControl, simple);
  // Root bypasses DAC, so mode 0000 denies nothing to a root controller. The equivalent
  // fail-closed refusal there is a control dir that is no longer owned by the controller
  // (exactly the adapter-UID-owned control plane the runtime must reject).
  if (runningAsRoot) await chown(inaccessibleControl, testIdentity.uid, testIdentity.gid);
  else await chmod(inaccessibleControl, 0o000);
  try {
    const deniedStop = stopManaged(inaccessibleState, inaccessibleControl);
    assert.equal(deniedStop.status, 78, deniedStop.stderr);
    assert.doesNotMatch(deniedStop.stderr, /Traceback/);
    const deniedStopped = spawnSync("python3", lifecycleArgs("stopped", inaccessibleState, inaccessibleControl), { encoding: "utf8" });
    assert.equal(deniedStopped.status, 78, deniedStopped.stderr);
    assert.doesNotMatch(deniedStopped.stderr, /Traceback/);
    assert.equal(processAlive(inaccessibleManaged.document.pid), true);
  } finally {
    if (runningAsRoot) await chown(inaccessibleControl, 0, 0);
    else await chmod(inaccessibleControl, 0o700);
  }
  assert.equal(stopManaged(inaccessibleState, inaccessibleControl).status, 0);
  await waitProcessGone(inaccessibleManaged.document.pid);
  process.stdout.write("inaccessible control directory: clean exit 78 without traceback\n");

  // A different current container ID/generation never signals a valid live process.
  const identityState = path.join(temporary, "identity-state");
  const identityControl = await makeControl("identity");
  await mkdir(identityState, { mode: 0o700 });
  managed = await startManaged(identityState, identityControl, simple);
  result = spawnSync("python3", [runtimeHelper, "stop", "--alias", "atlas", "--state", identityState,
    "--control-dir", identityControl, "--container-id", "e".repeat(64), "--generation", replacementGeneration], { encoding: "utf8" });
  assert.equal(result.status, 78);
  assert.equal(processAlive(managed.document.pid), true);
  assert.equal(stopManaged(identityState, identityControl).status, 0);

  // Dead metadata is cleaned only for a verifiably stale generation; same-generation death is permanent.
  const staleState = path.join(temporary, "stale-state");
  const staleControl = await makeControl("stale");
  await mkdir(staleState, { mode: 0o700 });
  managed = await startManaged(staleState, staleControl, simple);
  const staleDocument = managed.document;
  assert.equal(stopManaged(staleState, staleControl).status, 0);
  await waitProcessGone(staleDocument.pid);
  await writeFile(managed.metadata, `${JSON.stringify(staleDocument)}\n`);
  const sameGeneration = spawnSync("python3", runArgs(staleState, staleControl, simple), {
    encoding: "utf8",
    env: lifecycleEnv(staleState, staleControl, lifecycleGeneration),
  });
  assert.equal(sameGeneration.status, 78);
  assert.equal(await readFile(managed.metadata, "utf8"), `${JSON.stringify(staleDocument)}\n`);
  const stalePreStartStop = stopManaged(staleState, staleControl, replacementGeneration);
  assert.equal(stalePreStartStop.status, 0,
    `pre-start stop must tolerate quiescent metadata from a prior container generation: ${stalePreStartStop.stderr}`);
  assert.equal(await readFile(managed.metadata, "utf8"), `${JSON.stringify(staleDocument)}\n`,
    "pre-start stop leaves stale metadata for the lock-owning run path to clean");
  const staleReplacementProof = spawnSync(
    "python3",
    lifecycleArgs("stopped", staleState, staleControl, replacementGeneration),
    { encoding: "utf8" },
  );
  assert.equal(staleReplacementProof.status, 0,
    `replacement generation must be provably stopped despite stale metadata: ${staleReplacementProof.stderr}`);
  managed = await startManaged(staleState, staleControl, simple, [], replacementGeneration);
  assert.equal(managed.document.containerGeneration, replacementGeneration);
  assert.equal(stopManaged(staleState, staleControl, replacementGeneration).status, 0);
  process.stdout.write("same-container restart: stale generation stop/stopped passed and run replaced metadata safely\n");

  // Exercise that same stale-generation contract through the host supervisor, not only by
  // calling the lifecycle helper directly.  Fake Docker delegates the pre-deploy `stop` to the
  // real helper while keeping all other container operations observable.  An inert metadata
  // document from the prior generation must not strand the unit before its guarded final exec.
  await writeFile(managed.metadata, `${JSON.stringify(staleDocument)}\n`);
  await writeConfig("atlas");
  await clearLog();
  statePath = await dockerState("atlas", {
    runtimeStopFixture: {
      helper: runtimeHelper,
      state: staleState,
      control: staleControl,
    },
  });
  result = runSupervisor("start", "atlas", statePath);
  assert.equal(result.status, 0,
    `supervisor restart must tolerate inert prior-generation metadata: ${result.stderr}`);
  calls = await records();
  assert(calls.some(({ argv }) => argv.includes("stop") && argv.includes("--generation")),
    "supervisor must ask the real lifecycle helper to stop the prior generation");
  assert(calls.some(({ argv }) => argv.includes("guard-exec") && argv.includes("CAUCE_ALIAS=atlas")),
    "supervisor must reach the guarded adapter exec after stale-generation stop");
  process.stdout.write("host supervisor restart: inert prior-generation metadata reached guarded exec\n");

  // ---- No published leader => a metadata-based stop NEVER signals the controller. ----
  async function startGated(phase, marker, executablePath, generation = lifecycleGeneration) {
    const state = path.join(temporary, `phase-${phase}-state-${Math.random().toString(16).slice(2)}`);
    const control = await makeControl(`phase-${phase}`);
    await mkdir(state, { mode: 0o700 });
    const child = spawn("python3", runArgs(state, control, executablePath, [], generation), {
      stdio: "ignore",
      env: lifecycleEnv(state, control, generation, { CAUCE_CONTAINER_TEST_PHASE_GATE: `${phase}|${marker}|8` }),
    });
    cleanupProcesses.push(child);
    await waitForFile(marker);
    return { child, state, control };
  }
  // While the controller is still starting -- either pre-metadata (lock held, nothing
  // published) or "starting" metadata whose leader PID/PGID/SID are still null -- the
  // controller PID/starttime is lifecycle bookkeeping, not authority to signal an
  // unregistered target. Both stop and stopped must refuse fail-closed (78) and preserve
  // every byte, WITHOUT signalling the controller. The controller cancels itself and any
  // nascent child only on a direct SIGTERM (its own graceful-cancellation contract).
  for (const phase of ["pre-metadata", "starting", "pre-child", "post-child"]) {
    const marker = path.join(temporary, `gate-${phase}-${Math.random().toString(16).slice(2)}.marker`);
    const gated = await startGated(phase, marker, simple);
    const gatedMetadata = path.join(gated.control, metadataName);
    const beforeStop = phase === "pre-metadata" ? null : await readFile(gatedMetadata, "utf8");
    if (beforeStop !== null) {
      assert.equal(JSON.parse(beforeStop).phase, "starting", `${phase} must publish only starting metadata`);
      assert.equal(JSON.parse(beforeStop).pid, null, `${phase} must not publish a leader PID`);
    }
    const gatedStop = stopManaged(gated.state, gated.control);
    assert.equal(gatedStop.status, 78, `${phase} stop must be fail-closed (78), got ${gatedStop.status}: ${gatedStop.stderr}`);
    assert.equal(processAlive(gated.child.pid), true, `${phase}: stop must never signal the still-starting controller`);
    if (beforeStop !== null) {
      assert.equal(await readFile(gatedMetadata, "utf8"), beforeStop, `${phase}: starting metadata must be preserved byte-for-byte`);
    }
    const proof = spawnSync("python3", lifecycleArgs("stopped", gated.state, gated.control), { encoding: "utf8" });
    assert.equal(proof.status, 78, `${phase} stopped must be fail-closed (78), got ${proof.status}: ${proof.stderr}`);
    assert.equal(processAlive(gated.child.pid), true, `${phase}: stopped must never signal the controller either`);
    // Only a direct SIGTERM cancels the controller (and tears down any nascent child).
    gated.child.kill("SIGTERM");
    await waitProcessGone(gated.child.pid);
  }
  process.stdout.write("no published leader across startup phases: stop/stopped refuse with 78 and never signal the controller\n");

  // Starting metadata whose controller PID now names an unrelated process is a
  // PID-reuse analogue. Neither that process nor its child may become traversal
  // roots or signal targets; stop must preserve metadata and return 78.
  const reusedControllerMarker = path.join(temporary, "controller-reuse-starting.marker");
  const reusedController = await startGated("starting", reusedControllerMarker, simple);
  const reusedControllerMetadata = path.join(reusedController.control, metadataName);
  const originalStartingDocument = await waitForMetadataPhase(reusedControllerMetadata, "starting");
  reusedController.child.kill("SIGKILL");
  await waitProcessGone(reusedController.child.pid);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const foreignChildPidFile = path.join(temporary, "foreign-controller-child.pid");
  const foreignController = spawn(resistant, [foreignChildPidFile], { stdio: "ignore", detached: true });
  cleanupGroups.push(foreignController.pid);
  await waitForFile(foreignChildPidFile);
  const foreignControllerChild = Number((await readFile(foreignChildPidFile, "utf8")).trim());
  cleanupGroups.push(foreignControllerChild);
  const reusedControllerDocument = { ...originalStartingDocument, controllerPid: foreignController.pid };
  const reusedControllerBody = `${JSON.stringify(reusedControllerDocument)}\n`;
  await writeFile(reusedControllerMetadata, reusedControllerBody);
  const refusedControllerStop = stopManaged(reusedController.state, reusedController.control);
  assert.equal(refusedControllerStop.status, 78, refusedControllerStop.stderr);
  assert.equal(processAlive(foreignController.pid), true, "reused controller PID must not be signalled");
  assert.equal(processAlive(foreignControllerChild), true, "child of reused controller PID must not be signalled");
  assert.equal(await readFile(reusedControllerMetadata, "utf8"), reusedControllerBody);
  process.kill(foreignController.pid, "SIGKILL");
  process.kill(foreignControllerChild, "SIGKILL");
  await waitProcessGone(foreignController.pid);
  await waitProcessGone(foreignControllerChild);
  process.stdout.write("controller PID reuse: unrelated process and child preserved with exit 78\n");

  // ---- Killing the docker-exec client leaves no orphan and no second consumer. ----
  const orphanState = path.join(temporary, "orphan-state");
  const orphanControl = await makeControl("orphan");
  await mkdir(orphanState, { mode: 0o700 });
  const orphanPidFile = path.join(temporary, "orphan-child.pid");
  managed = await startManaged(orphanState, orphanControl, resistant, [orphanPidFile]);
  await waitForFile(orphanPidFile);
  const orphanDescendant = Number((await readFile(orphanPidFile, "utf8")).trim());
  const orphanLeader = managed.document.pid;
  // The docker-exec client dying == the controller dying abruptly; the adapter is orphaned.
  process.kill(managed.child.pid, "SIGKILL");
  await waitProcessGone(managed.child.pid);
  assert.equal(processAlive(orphanLeader), true, "the adapter survives the controller death");
  assert.equal(processAlive(orphanDescendant), true, "the resistant descendant survives too");
  // A same-generation restart must refuse rather than create a second consumer.
  const secondConsumer = spawnSync("python3", runArgs(orphanState, orphanControl, simple), {
    encoding: "utf8",
    env: lifecycleEnv(orphanState, orphanControl, lifecycleGeneration),
  });
  assert.equal(secondConsumer.status, 78, `a second consumer must be refused: ${secondConsumer.stdout} ${secondConsumer.stderr}`);
  assert.equal(processAlive(orphanLeader), true, "the refused restart never touched the live adapter");
  // stop reaps the orphaned leader and its TERM-resistant setsid descendant, leaving no residue.
  const orphanStop = stopManaged(orphanState, orphanControl);
  assert.equal(orphanStop.status, 0, `stop must reap the orphan: ${orphanStop.stderr}`);
  await waitProcessGone(orphanLeader);
  await waitProcessGone(orphanDescendant);
  const orphanProof = spawnSync("python3", lifecycleArgs("stopped", orphanState, orphanControl), { encoding: "utf8" });
  assert.equal(orphanProof.status, 0, `the orphan must be provably stopped: ${orphanProof.stderr}`);

  // ---- A real non-root UID cannot unlink the root-owned control plane (metadata + lock). ----
  function sudo(args, opts = {}) { return spawnSync("sudo", ["-n", ...args], { encoding: "utf8", ...opts }); }
  const privileged = sudo(["true"]).status === 0 && sudo(["-u", "#65534", "true"]).status === 0;
  if (privileged) {
    const priv = `/tmp/cauce-adv-${process.pid}-${Math.random().toString(16).slice(2)}`;
    privilegedRoots.push(priv);
    assert.equal(sudo(["mkdir", "-m", "0755", priv]).status, 0);
    const psimple = path.join(priv, "simple.py");
    assert.equal(sudo(["cp", simple, psimple]).status, 0);
    assert.equal(sudo(["chmod", "0555", psimple]).status, 0);
    const pstate = path.join(priv, "state");
    const pctl = path.join(priv, "control");
    assert.equal(sudo(["mkdir", "-m", "0700", pstate]).status, 0);
    assert.equal(sudo(["mkdir", "-m", "0700", pctl]).status, 0);
    const rootEnv = ["env", "CAUCE_ALIAS=atlas", `CAUCE_STATE_DIR=${pstate}`, `CAUCE_CONTROL_DIR=${pctl}`,
      `CAUCE_CONTAINER_ID=${lifecycleContainerId}`, `CAUCE_CONTAINER_GENERATION=${lifecycleGeneration}`];
    const rootRun = ["python3", runtimeHelper, "run", "--alias", "atlas", "--state", pstate, "--control-dir", pctl,
      "--runtime-uid", "65534", "--runtime-gid", "65534", "--container-id", lifecycleContainerId,
      "--generation", lifecycleGeneration, "--term-seconds", "1", "--kill-seconds", "2",
      "--bundle", release, "--bundle-digest", bundleDigest, psimple];
    const rootChild = spawn("sudo", ["-n", ...rootEnv, ...rootRun], { stdio: "ignore" });
    privilegedChildren.push(rootChild);
    let rootDoc = null;
    for (let attempt = 0; attempt < 200 && !rootDoc; attempt += 1) {
      const seen = sudo(["cat", path.join(pctl, metadataName)]);
      if (seen.status === 0) {
        try { const parsed = JSON.parse(seen.stdout); if (parsed.phase === "running" && parsed.pid) rootDoc = parsed; } catch { /* not published yet */ }
      }
      if (!rootDoc) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(rootDoc, "the root-owned lifecycle metadata reached the running phase");
    assert.equal(rootDoc.runtimeUid, 65534, "the adapter dropped to the non-root runtime UID");
    assert.equal(rootDoc.runtimeGid, 65534, "the adapter dropped to the non-root runtime GID");
    // A real, unprivileged UID (nobody) must be denied unlink of the metadata and the lock.
    const deny = "import os,sys\ntry:\n os.unlink(sys.argv[1]); print('UNLINKED'); sys.exit(9)\nexcept OSError as e:\n print('DENIED', e.errno); sys.exit(0)";
    const denyMeta = sudo(["-u", "#65534", "python3", "-c", deny, path.join(pctl, metadataName)]);
    assert.equal(denyMeta.status, 0, `non-root metadata unlink must be denied cleanly: ${denyMeta.stdout} ${denyMeta.stderr}`);
    assert.match(denyMeta.stdout, /DENIED/);
    assert.doesNotMatch(denyMeta.stdout, /UNLINKED/);
    const denyLock = sudo(["-u", "#65534", "python3", "-c", deny, path.join(pctl, lockName)]);
    assert.equal(denyLock.status, 0, `non-root lock unlink must be denied cleanly: ${denyLock.stdout} ${denyLock.stderr}`);
    assert.match(denyLock.stdout, /DENIED/);
    assert.doesNotMatch(denyLock.stdout, /UNLINKED/);
    // The control plane and the adapter survived the tampering attempt.
    assert.equal(sudo(["test", "-f", path.join(pctl, metadataName)]).status, 0, "metadata survived the failed unlink");
    assert.equal(sudo(["test", "-f", path.join(pctl, lockName)]).status, 0, "lock survived the failed unlink");
    assert.equal(sudo(["test", "-d", `/proc/${rootDoc.pid}`]).status, 0, "the adapter is still alive after the failed tampering");
    // A root runtime identity is rejected outright before the control plane is touched.
    const rootRuntime = sudo([...rootEnv, "python3", runtimeHelper, "run", "--alias", "atlas", "--state", pstate,
      "--control-dir", pctl, "--runtime-uid", "0", "--runtime-gid", "0", "--container-id", lifecycleContainerId,
      "--generation", lifecycleGeneration, "--bundle", release, "--bundle-digest", bundleDigest, psimple]);
    assert.equal(rootRuntime.status, 78, `a root runtime identity must be rejected: ${rootRuntime.stdout} ${rootRuntime.stderr}`);
    // Tear the root-owned adapter down and prove it stopped.
    const rootStop = sudo(["python3", runtimeHelper, "stop", "--alias", "atlas", "--state", pstate, "--control-dir", pctl,
      "--container-id", lifecycleContainerId, "--generation", lifecycleGeneration, "--term-seconds", "1", "--kill-seconds", "2"]);
    assert.equal(rootStop.status, 0, `the root-owned stop must succeed: ${rootStop.stderr}`);
    process.stdout.write("privileged root-owned control-plane reproductions passed\n");
  } else if (droppedFromRoot) {
    // Do not let the root release host silently buy a green gate with less coverage than a
    // developer machine gets. Name what was not exercised and how to exercise it.
    process.stdout.write(
      "WARNING: privileged root-owned control-plane reproductions were NOT exercised: this run "
      + "started as root and dropped its own privileges, so passwordless sudo is unavailable. "
      + "Run this suite from a non-root account that has passwordless sudo for root and #65534 "
      + "to cover root-owned metadata/lock tamper resistance.\n");
  } else {
    process.stdout.write("skipping privileged reproductions: passwordless sudo for root and #65534 is unavailable\n");
  }
}
