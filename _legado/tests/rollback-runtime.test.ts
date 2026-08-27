import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const rollback = join(repository, 'ops/scripts/rollback.sh');
const scratch: string[] = [];
const current = `registry.invalid/cauce/runtime@sha256:${'c'.repeat(64)}`;
const previous = `registry.invalid/cauce/runtime@sha256:${'a'.repeat(64)}`;
const currentId = `sha256:${'d'.repeat(64)}`;
const previousId = `sha256:${'b'.repeat(64)}`;
const currentConsole = `registry.invalid/cauce/console@sha256:${'e'.repeat(64)}`;
const previousConsole = `registry.invalid/cauce/console@sha256:${'f'.repeat(64)}`;
const currentConsoleId = `sha256:${'1'.repeat(64)}`;
const previousConsoleId = `sha256:${'2'.repeat(64)}`;
const sha256 = (content: string): string =>
  `sha256:${createHash('sha256').update(content).digest('hex')}`;
const baselineContent = '{}\n';
const baselineSha = sha256(baselineContent);
const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

async function harness(
  running: string,
  mismatch = '',
  currentSchema = '037_console_publish_intent_indexes.sql',
  terminalPreflight: 'pass' | 'fail' = 'pass',
  consoleJournal: 'present' | 'absent' = 'present',
  activeBridgeReadOnly = false,
) {
  const directory = await mkdtemp(join(tmpdir(), 'cauce-rollback-'));
  scratch.push(directory);
  const bin = join(directory, 'bin');
  const overrides = join(directory, 'overrides');
  const log = join(directory, 'docker.log');
  const envFile = join(directory, 'prod.env');
  const currentManifest = join(directory, 'current.manifest');
  const previousManifest = join(directory, 'previous.manifest');
  const bridgeEvidence = join(directory, 'rollback-bridge.json');
  const baseline = join(directory, 'rollback-baseline.json');
  const writerSnapshot = join(directory, 'writer-snapshot.json');
  const writerState = join(directory, 'writers-stopped');
  const gatewayStopped = join(directory, 'gateway-stopped');
  const dispatcherStopped = join(directory, 'dispatcher-stopped');
  const dispatcherRemoved = join(directory, 'dispatcher-removed');
  const writersRemoved = join(directory, 'writers-removed');
  const consoleStopped = join(directory, 'console-stopped');
  await mkdir(bin);
  await mkdir(overrides);
  const currentManifestContent = '# current manifest\n';
  const previousManifestContent = '# previous manifest\n';
  const currentManifestSha = sha256(currentManifestContent);
  const previousManifestSha = sha256(previousManifestContent);
  const writerNames = running.split('\n').filter((service) => [
    'relay-worker', 'terminal-relay', 'telegram-bridge', 'shadow-router', 'shadow-guard',
  ].includes(service));
  const aliasManifestContent = await readFile(join(repository, 'ops/container-aliases.json'), 'utf8');
  const aliasManifest = JSON.parse(aliasManifestContent) as {
    aliases: Record<string, { tenant: string; dockerHost?: string; systemdUser: string }>;
  };
  const absentUnit = (family: string, scope: string, name: string) => ({
    activeState: 'inactive',
    family,
    fragmentSha256: null,
    loadState: 'not-found',
    mainPid: 0,
    name,
    scope,
    subState: 'dead',
    unitFileState: 'not-found',
  });
  const writerSnapshotContent = `${JSON.stringify({
    aliases: Object.entries(aliasManifest.aliases).sort(([left], [right]) => left.localeCompare(right)).map(([alias, entry]) => ({
      alias,
      host: entry.dockerHost ?? 'local',
      leaseActive: false,
      systemdUser: entry.systemdUser,
      tenant: entry.tenant,
      units: [
        absentUnit('host-native', 'system', `cauce-v3-alias-${alias}.service`),
        absentUnit('container-system', 'system', `cauce-v3-container-${alias}.service`),
        absentUnit('container-rootless', 'user', `cauce-v3-container-${alias}.service`),
      ],
    })),
    composeWriters: [...writerNames].sort(),
    kind: 'cauce-v3-release-writer-snapshot',
    manifestSha256: sha256(aliasManifestContent),
    schemaVersion: 2,
    writersExpectedCandidate: writerNames.length,
  })}\n`;
  const writerSnapshotSha = sha256(writerSnapshotContent);
  await writeFile(currentManifest, currentManifestContent);
  await writeFile(previousManifest, previousManifestContent);
  await chmod(currentManifest, 0o600);
  await chmod(previousManifest, 0o600);
  await writeFile(bridgeEvidence, '{}\n', { mode: 0o600 });
  await chmod(bridgeEvidence, 0o600);
  await writeFile(baseline, baselineContent, { mode: 0o600 });
  await chmod(baseline, 0o600);
  await writeFile(writerSnapshot, writerSnapshotContent, { mode: 0o600 });
  await writeFile(`${writerSnapshot}.state.json`, '{}\n', { mode: 0o444 });
  const copiedPin = join(directory, 'pin-production-release.py');
  await copyFile(join(repository, 'ops/scripts/pin-production-release.py'), copiedPin);
  await chmod(copiedPin, 0o755);
  const fakeBaseline = join(directory, 'rollback-baseline.py');
  await writeFile(fakeBaseline, '#!/usr/bin/python3\nraise SystemExit(0)\n', { mode: 0o755 });
  await chmod(fakeBaseline, 0o755);
  await writeFile(
    envFile,
    [
      'COMPOSE_PROJECT_NAME=cauce-v3-prod',
      'CAUCE_LOCAL_POSTGRES=0',
      `CAUCE_COMPOSE_OVERRIDES_DIR=${overrides}`,
      `CAUCE_RUNTIME_IMAGE=${current}`,
      `CAUCE_CONSOLE_IMAGE=${currentConsole}`,
      `CAUCE_COMPOSE_OVERRIDE_MANIFEST=${currentManifest}`,
      `CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256=${currentManifestSha}`,
      `CAUCE_ROLLBACK_BASELINE_FILE=${baseline}`,
      `CAUCE_ROLLBACK_BASELINE_SHA256=${baselineSha}`,
      `CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE=${writerSnapshot}`,
      `CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256=${writerSnapshotSha}`,
      'PRIVATE_SENTINEL=never-print-this-value',
    ].join('\n') + '\n',
    { mode: 0o600 },
  );
  await chmod(envFile, 0o600);
  const roleFor = (service: string): string => {
    if (service === 'console') return 'console';
    if (writerNames.includes(service)) return 'writer';
    return 'core';
  };
  const composeRoles = [
    `migrator\tmigrator\t${current}`,
    ...running.split('\n').filter(Boolean).sort().map((service) =>
      `${roleFor(service)}\t${service}\t${service === 'console' ? currentConsole : current}`),
  ].join('\n') + '\n';
  const composeServices: Record<string, { image: string }> = { migrator: { image: current } };
  for (const service of running.split('\n').filter(Boolean)) {
    composeServices[service] = { image: service === 'console' ? currentConsole : current };
  }
  const composeModel = JSON.stringify({ services: composeServices });
  const fakeDocker = join(bin, 'docker');
  await writeFile(
    fakeDocker,
    `#!/bin/sh
set -eu
FAKE_DOCKER_LOG=${shellQuote(log)}
CAUCE_ENV_FILE=${shellQuote(envFile)}
FAKE_PREVIOUS_REF=${shellQuote(previous)}
FAKE_PREVIOUS_ID=${shellQuote(previousId)}
FAKE_CURRENT_REF=${shellQuote(current)}
FAKE_CURRENT_ID=${shellQuote(currentId)}
FAKE_PREVIOUS_CONSOLE_REF=${shellQuote(previousConsole)}
FAKE_PREVIOUS_CONSOLE_ID=${shellQuote(previousConsoleId)}
FAKE_CURRENT_CONSOLE_REF=${shellQuote(currentConsole)}
FAKE_CURRENT_CONSOLE_ID=${shellQuote(currentConsoleId)}
FAKE_RUNNING=${shellQuote(running)}
FAKE_COMPOSE_MODEL=${shellQuote(composeModel)}
FAKE_COMPOSE_ROLES=${shellQuote(composeRoles)}
FAKE_WRITER_STATE=${shellQuote(writerState)}
FAKE_GATEWAY_STOPPED=${shellQuote(gatewayStopped)}
FAKE_DISPATCHER_STOPPED=${shellQuote(dispatcherStopped)}
FAKE_DISPATCHER_REMOVED=${shellQuote(dispatcherRemoved)}
FAKE_WRITERS_REMOVED=${shellQuote(writersRemoved)}
FAKE_CONSOLE_STOPPED=${shellQuote(consoleStopped)}
FAKE_MISMATCH=${shellQuote(mismatch)}
FAKE_CURRENT_SCHEMA=${shellQuote(currentSchema)}
FAKE_TERMINAL_PREFLIGHT=${shellQuote(terminalPreflight)}
FAKE_CONSOLE_JOURNAL=${shellQuote(consoleJournal)}
FAKE_ACTIVE_BRIDGE_READ_ONLY=${shellQuote(activeBridgeReadOnly ? '1' : '0')}
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
printf 'control project=%s profiles=%s host=%s context=%s interpolation=%s\n' \
  "\${COMPOSE_PROJECT_NAME:-}" "\${COMPOSE_PROFILES:-}" "\${DOCKER_HOST:-}" \
  "\${DOCKER_CONTEXT:-}" "\${PRIVATE_PATH:-}" >> "$FAKE_DOCKER_LOG"
[ "\${COMPOSE_PROJECT_NAME:-}" = cauce-v3-prod ] || exit 96
[ -z "\${COMPOSE_PROFILES:-}" ] || exit 97
[ "\${DOCKER_HOST:-}" = unix:///var/run/docker.sock ] || exit 98
[ -z "\${DOCKER_CONTEXT:-}" ] || exit 99
[ -z "\${PRIVATE_PATH:-}" ] || exit 100
if [ "$1" = pull ]; then exit 0; fi
if [ "$1" = image ] && [ "$2" = inspect ]; then
  last=
  for value in "$@"; do last=$value; done
  case " $* " in
    *RepoDigests*) printf '%s\n' "$last" ;;
    *rollback-bridge.read-only*)
      if [ "$last" = "$FAKE_PREVIOUS_REF" ] || { [ "$last" = "$FAKE_CURRENT_REF" ] && [ "$FAKE_ACTIVE_BRIDGE_READ_ONLY" = 1 ]; }; then
        printf 'server-v2\n'
      fi ;;
    *console.publish-journal*)
      if [ "$last" = "$FAKE_PREVIOUS_CONSOLE_REF" ] && [ "$FAKE_CONSOLE_JOURNAL" = present ]; then
        printf 'multi-intent-v1\n'
      fi ;;
    *schema.compatible-through*)
      if [ "$last" = "$FAKE_CURRENT_REF" ]; then printf '%s\n' "$FAKE_CURRENT_SCHEMA"; fi ;;
    *)
      case "$last" in
        "$FAKE_PREVIOUS_REF") printf '%s\n' "$FAKE_PREVIOUS_ID" ;;
        "$FAKE_CURRENT_REF") printf '%s\n' "$FAKE_CURRENT_ID" ;;
        "$FAKE_PREVIOUS_CONSOLE_REF") printf '%s\n' "$FAKE_PREVIOUS_CONSOLE_ID" ;;
        "$FAKE_CURRENT_CONSOLE_REF") printf '%s\n' "$FAKE_CURRENT_CONSOLE_ID" ;;
        *) exit 1 ;;
      esac ;;
  esac
  exit 0
fi
if [ "$1" = inspect ]; then
  last=
  for value in "$@"; do last=$value; done
  case " $* " in
    *'.State.Running'*)
      case "$last" in
        cid-gateway)
          if [ -e "$FAKE_GATEWAY_STOPPED" ]; then printf 'false 0\n'; else printf 'true 1234\n'; fi ;;
        cid-dispatcher)
          if [ -e "$FAKE_DISPATCHER_STOPPED" ]; then printf 'false 0\n'; else printf 'true 1234\n'; fi ;;
        cid-console)
          if [ -e "$FAKE_CONSOLE_STOPPED" ]; then printf 'false 0\n'; else printf 'true 1234\n'; fi ;;
        cid-relay-worker|cid-terminal-relay|cid-telegram-bridge|cid-shadow-router|cid-shadow-guard)
          if [ -e "$FAKE_WRITER_STATE" ]; then printf 'false 0\n'; else printf 'true 1234\n'; fi ;;
        *) printf 'true 1234\n' ;;
      esac
      exit 0 ;;
  esac
  if [ "$last" = cid-console ]; then
    selected_ref=$(sed -n 's/^CAUCE_CONSOLE_IMAGE=//p' "$CAUCE_ENV_FILE")
    if [ "$selected_ref" = "$FAKE_PREVIOUS_CONSOLE_REF" ]; then selected_id=$FAKE_PREVIOUS_CONSOLE_ID; is_target=1; else selected_id=$FAKE_CURRENT_CONSOLE_ID; is_target=0; fi
  else
    selected_ref=$(sed -n 's/^CAUCE_RUNTIME_IMAGE=//p' "$CAUCE_ENV_FILE")
    if [ "$selected_ref" = "$FAKE_PREVIOUS_REF" ]; then selected_id=$FAKE_PREVIOUS_ID; is_target=1; else selected_id=$FAKE_CURRENT_ID; is_target=0; fi
  fi
  if [ -n "\${FAKE_MISMATCH:-}" ] && [ "$is_target" = 1 ] && [ "$last" = "cid-\${FAKE_MISMATCH}" ]; then
    printf 'sha256:%064d\n' 9
  else
    printf '%s\n' "$selected_id"
  fi
  exit 0
fi
if [ "$1" = compose ]; then
  expected_manifest=$(sed -n 's/^CAUCE_COMPOSE_OVERRIDE_MANIFEST=//p' "$CAUCE_ENV_FILE")
  expected_manifest_sha=$(sed -n 's/^CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256=//p' "$CAUCE_ENV_FILE")
  [ "\${CAUCE_COMPOSE_OVERRIDE_MANIFEST:-}" = "$expected_manifest" ] || exit 91
  [ "\${CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256:-}" = "$expected_manifest_sha" ] || exit 95
  [ "\${CAUCE_LOCAL_POSTGRES:-}" = 0 ] || exit 92
  [ -z "\${CAUCE_RUNTIME_IMAGE+x}" ] || exit 93
  [ -z "\${CAUCE_CONSOLE_IMAGE+x}" ] || exit 94
  case " $* " in
    *' version'*) exit 0 ;;
    *' exec -T gateway node deploy/schema-version.mjs'*) printf '%s\n' "$FAKE_CURRENT_SCHEMA"; exit 0 ;;
    *' run --rm --no-deps -T migrator node --input-type=module -'*) [ "$FAKE_TERMINAL_PREFLIGHT" = pass ]; exit $? ;;
    *' exec -T gateway node --input-type=module -'*)
      [ "$FAKE_ACTIVE_BRIDGE_READ_ONLY" = 1 ] || exit 1
      printf 'rollback-bridge-read-only-active'
      exit 0 ;;
    *' config --format json'*) printf '%s\n' "$FAKE_COMPOSE_MODEL"; exit 0 ;;
    *' ps --services --status running'*)
      printf '%s\n' "$FAKE_RUNNING" | while IFS= read -r service; do
        case "$service" in
          gateway) [ -e "$FAKE_GATEWAY_STOPPED" ] || printf '%s\n' "$service" ;;
          dispatcher) [ -e "$FAKE_DISPATCHER_STOPPED" ] || printf '%s\n' "$service" ;;
          console) [ -e "$FAKE_CONSOLE_STOPPED" ] || printf '%s\n' "$service" ;;
          relay-worker|terminal-relay|telegram-bridge|shadow-router|shadow-guard)
            if [ ! -e "$FAKE_WRITER_STATE" ]; then printf '%s\n' "$service"; fi ;;
          *) [ -n "$service" ] && printf '%s\n' "$service" ;;
        esac
      done
      exit 0 ;;
    *' ps --all --services'*)
      printf '%s\n' "$FAKE_RUNNING" | while IFS= read -r service; do
        [ "$service" != dispatcher ] || { [ ! -e "$FAKE_DISPATCHER_REMOVED" ] || continue; }
        case "$service" in relay-worker|terminal-relay|telegram-bridge|shadow-router|shadow-guard)
          [ ! -e "$FAKE_WRITERS_REMOVED" ] || continue ;;
        esac
        [ -n "$service" ] && printf '%s\n' "$service"
      done
      exit 0 ;;
    *' ps -q '*)
      last=; for value in "$@"; do last=$value; done
      [ "$last" != dispatcher ] || { [ ! -e "$FAKE_DISPATCHER_REMOVED" ] || exit 0; }
      case "$last" in relay-worker|terminal-relay|telegram-bridge|shadow-router|shadow-guard)
        [ ! -e "$FAKE_WRITERS_REMOVED" ] || exit 0 ;;
      esac
      printf 'cid-%s\n' "$last"; exit 0 ;;
    *' run --rm --no-deps -T migrator node deploy/fleet-snapshot.mjs'*) printf '{"schemaVersion":3,"leases":[]}\n'; exit 0 ;;
    *' exec -T outbox-metrics node -e '*) printf 'cauce_release_rollback_bridge_degraded 1\ncauce_release_writers_declared 0\ncauce_release_writer_leases_active 0\n'; exit 0 ;;
    *' stop '*)
      for value in "$@"; do
        [ "$value" != gateway ] || : > "$FAKE_GATEWAY_STOPPED"
        [ "$value" != dispatcher ] || : > "$FAKE_DISPATCHER_STOPPED"
        [ "$value" != console ] || : > "$FAKE_CONSOLE_STOPPED"
        case "$value" in relay-worker|terminal-relay|telegram-bridge|shadow-router|shadow-guard) : > "$FAKE_WRITER_STATE" ;; esac
      done
      exit 0 ;;
    *' rm -f '*)
      for value in "$@"; do
        [ "$value" != dispatcher ] || : > "$FAKE_DISPATCHER_REMOVED"
        case "$value" in relay-worker|terminal-relay|telegram-bridge|shadow-router|shadow-guard) : > "$FAKE_WRITERS_REMOVED" ;; esac
      done
      exit 0 ;;
    *' up -d '*)
      for value in "$@"; do
        [ "$value" != gateway ] || rm -f -- "$FAKE_GATEWAY_STOPPED"
        [ "$value" != dispatcher ] || { rm -f -- "$FAKE_DISPATCHER_STOPPED" "$FAKE_DISPATCHER_REMOVED"; }
        [ "$value" != console ] || rm -f -- "$FAKE_CONSOLE_STOPPED"
        case "$value" in relay-worker|terminal-relay|telegram-bridge|shadow-router|shadow-guard) rm -f -- "$FAKE_WRITER_STATE" "$FAKE_WRITERS_REMOVED" ;; esac
      done
      exit 0 ;;
    *' config --services '*) printf '%s\n' gateway dispatcher outbox-metrics; exit 0 ;;
    *) exit 0 ;;
  esac
fi
exit 1
`,
  );
  await chmod(fakeDocker, 0o755);
  // rollback.sh is the unit under test.  Its production Compose wrapper is a
  // separate hardening boundary which deliberately ignores PATH shims, so the
  // fixture substitutes only that boundary with a deterministic adapter while
  // preserving rollback.sh's closed control-plane environment.
  const fixtureCompose = join(directory, 'compose-prod');
  await writeFile(
    fixtureCompose,
    `#!/bin/sh
set -eu
[ "\${1:-}" = prod ] || exit 2
shift
CAUCE_LOCAL_POSTGRES=$(sed -n 's/^CAUCE_LOCAL_POSTGRES=//p' "$CAUCE_ENV_FILE")
CAUCE_COMPOSE_OVERRIDE_MANIFEST=$(sed -n 's/^CAUCE_COMPOSE_OVERRIDE_MANIFEST=//p' "$CAUCE_ENV_FILE")
CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256=$(sed -n 's/^CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256=//p' "$CAUCE_ENV_FILE")
export CAUCE_LOCAL_POSTGRES CAUCE_COMPOSE_OVERRIDE_MANIFEST CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256
exec ${shellQuote(fakeDocker)} compose "$@"
`,
    { mode: 0o755 },
  );
  await chmod(fixtureCompose, 0o755);
  const fixtureHealth = join(directory, 'stack-health');
  await writeFile(fixtureHealth, '#!/bin/sh\n[ "${1:-}" = prod ]\n', { mode: 0o755 });
  await chmod(fixtureHealth, 0o755);
  const lostForwardEnable = join(directory, 'enable-lost-forward');
  const lostInverseEnable = join(directory, 'enable-lost-inverse');
  const bridgeInvalid = join(directory, 'bridge-invalid');
  const lostForwardMarker = join(directory, 'lost-forward');
  const lostInverseMarker = join(directory, 'lost-inverse');
  const fixtureRollback = join(directory, 'rollback.sh');
  const fakePython = join(bin, 'python3');
  await writeFile(
    fakePython,
    `#!/bin/sh
set -eu
FAKE_DOCKER_LOG=${shellQuote(log)}
FAKE_PIN_HELPER=${shellQuote(copiedPin)}
FAKE_CURRENT_REF=${shellQuote(current)}
FAKE_PREVIOUS_REF=${shellQuote(previous)}
FAKE_CURRENT_CONSOLE_REF=${shellQuote(currentConsole)}
FAKE_PREVIOUS_CONSOLE_REF=${shellQuote(previousConsole)}
FAKE_CURRENT_ID=${shellQuote(currentId)}
FAKE_PREVIOUS_ID=${shellQuote(previousId)}
FAKE_CURRENT_CONSOLE_ID=${shellQuote(currentConsoleId)}
FAKE_PREVIOUS_CONSOLE_ID=${shellQuote(previousConsoleId)}
FAKE_WRITER_STATE=${shellQuote(writerState)}
FAKE_DISPATCHER_STOPPED=${shellQuote(dispatcherStopped)}
FAKE_COMPOSE_ROLES=${shellQuote(composeRoles)}
FAKE_LOST_FORWARD_ENABLE=${shellQuote(lostForwardEnable)}
FAKE_LOST_INVERSE_ENABLE=${shellQuote(lostInverseEnable)}
FAKE_LOST_FORWARD_MARKER=${shellQuote(lostForwardMarker)}
FAKE_LOST_INVERSE_MARKER=${shellQuote(lostInverseMarker)}
FAKE_BRIDGE_INVALID=${shellQuote(bridgeInvalid)}
FAKE_FORWARD_COMMIT=${shellQuote('7'.repeat(40))}
FAKE_FORWARD_SOURCE=${shellQuote(`sha256:${'8'.repeat(64)}`)}
FAKE_PREVIOUS_MANIFEST=${shellQuote(previousManifest)}
FAKE_PREVIOUS_MANIFEST_SHA=${shellQuote(previousManifestSha)}
FAKE_BRIDGE_EVIDENCE=${shellQuote(bridgeEvidence)}
FAKE_BRIDGE_SHA=${shellQuote(`sha256:${'3'.repeat(64)}`)}
FAKE_ROLLBACK_UNDER_TEST=${shellQuote(fixtureRollback)}
case " $* " in
  *pin-production-release.py*)
    shift
    printf 'pin-operation %s\n' "\${1:-}" >> "$FAKE_DOCKER_LOG"
    /usr/bin/python3 "$FAKE_PIN_HELPER" "$@"
    status=$?
    [ "$status" = 0 ] || exit "$status"
    if [ "\${1:-}" = swap ]; then
      selected=$(sed -n 's/^CAUCE_RUNTIME_IMAGE=//p' "$CAUCE_ENV_FILE")
      if [ -e "$FAKE_LOST_FORWARD_ENABLE" ] && [ "$selected" = "$FAKE_PREVIOUS_REF" ] \
         && [ ! -e "$FAKE_LOST_FORWARD_MARKER" ]; then
        : > "$FAKE_LOST_FORWARD_MARKER"
        exit 43
      fi
      if [ -e "$FAKE_LOST_INVERSE_ENABLE" ] && [ "$selected" = "$FAKE_CURRENT_REF" ] \
         && [ ! -e "$FAKE_LOST_INVERSE_MARKER" ]; then
        : > "$FAKE_LOST_INVERSE_MARKER"
        exit 44
      fi
    fi
    exit 0 ;;
  *release-writer-state.py*)
    case " $* " in
      *' guarded-exec '*)
        while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done
        [ "$#" -gt 0 ] || exit 96
        shift
        [ "$#" -gt 0 ] || exit 96
        if [ "$1" = ${shellQuote(join(repository, 'ops/scripts/rollback.sh'))} ]; then
          shift
          set -- "$FAKE_ROLLBACK_UNDER_TEST" "$@"
        fi
        printf 'writer-state guarded-exec lock=%s\n' "\${CAUCE_RELEASE_TRANSITION_LOCK_FD:-}" >> "$FAKE_DOCKER_LOG"
        CAUCE_WRITER_REMOTE_GUARD_FD=8 \
          CAUCE_WRITER_REMOTE_GUARD_MANAGERS_SHA256=$(printf '%064d' 0) \
          CAUCE_WRITER_REMOTE_GUARDS='[]' \
          "$@"
        exit $? ;;
    esac
    action=
    previous=
    marker_path=
    mode=
    for value in "$@"; do
      case "$value" in compose-model|validate|check|fence|stop|restore|marker|marker-check) action=$value ;; esac
      [ "$previous" = --path ] && marker_path=$value
      [ "$previous" = --mode ] && mode=$value
      previous=$value
    done
    printf 'writer-state %s lock=%s\n' "$action" "\${CAUCE_RELEASE_TRANSITION_LOCK_FD:-}" >> "$FAKE_DOCKER_LOG"
    case "$action" in
      compose-model) /bin/cat >/dev/null; printf '%b' "$FAKE_COMPOSE_ROLES" ;;
      fence|stop) : > "$FAKE_WRITER_STATE" ;;
      restore) rm -f -- "$FAKE_WRITER_STATE" ;;
      check)
        if [ "$mode" = stopped ] || [ "$mode" = fenced ]; then [ -e "$FAKE_WRITER_STATE" ]; else [ ! -e "$FAKE_WRITER_STATE" ]; fi ;;
      marker)
        if [ "$mode" = rollback_bridge_degraded ]; then
          [ -e "$FAKE_DISPATCHER_STOPPED" ] || exit 89
        fi
        chmod 0600 "$marker_path" 2>/dev/null || true
        printf '{}\n' > "$marker_path"
        chmod 0444 "$marker_path" ;;
      validate|marker-check) : ;;
      *) exit 1 ;;
    esac
    exit $? ;;
  *rollback-baseline.py*' field '*)
    name=; previous=;
    for value in "$@"; do if [ "$previous" = --name ]; then name=$value; fi; previous=$value; done
    case "$name" in
      forward-release-commit) printf '%s\n' "$FAKE_FORWARD_COMMIT" ;;
      forward-runtime-image) printf '%s\n' "$FAKE_CURRENT_REF" ;;
      forward-runtime-source-digest) printf '%s\n' "$FAKE_FORWARD_SOURCE" ;;
      bridge-runtime-image) printf '%s\n' "$FAKE_PREVIOUS_REF" ;;
      console-image) printf '%s\n' "$FAKE_PREVIOUS_CONSOLE_REF" ;;
      override-manifest) printf '%s\n' "$FAKE_PREVIOUS_MANIFEST" ;;
      override-manifest-sha256) printf '%s\n' "$FAKE_PREVIOUS_MANIFEST_SHA" ;;
      bridge-evidence) printf '%s\n' "$FAKE_BRIDGE_EVIDENCE" ;;
      bridge-evidence-sha256) printf '%s\n' "$FAKE_BRIDGE_SHA" ;;
      *) exit 1 ;;
    esac
    exit 0 ;;
  *validate-rollback-bridge-evidence.py*) printf 'validator %s\n' "$*" >> "$FAKE_DOCKER_LOG"; [ ! -e "$FAKE_BRIDGE_INVALID" ]; exit ;;
  *fleet-parity.py*) exit 0 ;;
  *) exec /usr/bin/python3 "$@" ;;
esac
`,
  );
  await chmod(fakePython, 0o755);
  await writeFile(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await chmod(join(bin, 'sleep'), 0o755);
  const fixtureRollbackSource = (await readFile(rollback, 'utf8'))
    .replace(/^ROOT=.*$/mu, `ROOT=${shellQuote(join(repository, 'ops'))}`)
    .replace(
      /^system_path=\/usr\/local\/sbin:.*$/mu,
      `system_path=${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    )
    .replaceAll('"$ROOT/scripts/compose.sh"', shellQuote(fixtureCompose))
    .replaceAll('"$ROOT/scripts/stack-health.sh"', shellQuote(fixtureHealth));
  await writeFile(fixtureRollback, fixtureRollbackSource, { mode: 0o755 });
  await chmod(fixtureRollback, 0o755);
  const environment = { ...process.env };
  Object.assign(environment, {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    FAKE_DOCKER_LOG: log,
    FAKE_CURRENT_ID: currentId,
    FAKE_PREVIOUS_ID: previousId,
    FAKE_CURRENT_REF: current,
    FAKE_PREVIOUS_REF: previous,
    FAKE_CURRENT_CONSOLE_ID: currentConsoleId,
    FAKE_PREVIOUS_CONSOLE_ID: previousConsoleId,
    FAKE_CURRENT_CONSOLE_REF: currentConsole,
    FAKE_PREVIOUS_CONSOLE_REF: previousConsole,
    FAKE_RUNNING: running,
    FAKE_COMPOSE_MODEL: composeModel,
    FAKE_COMPOSE_ROLES: composeRoles,
    FAKE_WRITER_STATE: writerState,
    FAKE_DISPATCHER_STOPPED: dispatcherStopped,
    FAKE_MISMATCH: mismatch,
    FAKE_CURRENT_SCHEMA: currentSchema,
    FAKE_PIN_HELPER: copiedPin,
    FAKE_FORWARD_COMMIT: '7'.repeat(40),
    FAKE_FORWARD_SOURCE: `sha256:${'8'.repeat(64)}`,
    FAKE_PREVIOUS_MANIFEST: previousManifest,
    FAKE_PREVIOUS_MANIFEST_SHA: previousManifestSha,
    FAKE_BRIDGE_EVIDENCE: bridgeEvidence,
    FAKE_BRIDGE_SHA: `sha256:${'3'.repeat(64)}`,
    CAUCE_ENV_FILE: envFile,
    CAUCE_CURRENT_RUNTIME_IMAGE: 'ambient/current-runtime:mutable',
    CAUCE_PREVIOUS_RUNTIME_IMAGE: previous,
    CAUCE_CURRENT_CONSOLE_IMAGE: 'ambient/current-console:mutable',
    CAUCE_CURRENT_OVERRIDE_MANIFEST: '/ambient/current.manifest',
    CAUCE_CURRENT_OVERRIDE_MANIFEST_SHA256: `sha256:${'6'.repeat(64)}`,
    CAUCE_CURRENT_ROLLBACK_BASELINE_FILE: '/ambient/current-baseline.json',
    CAUCE_CURRENT_ROLLBACK_BASELINE_SHA256: `sha256:${'0'.repeat(64)}`,
    CAUCE_ROLLBACK_CONFIRM:
      `release-selectors:runtime:${current}|${currentConsole}|${currentManifest}|${currentManifestSha}|${baseline}|${baselineSha}`
      + `|${writerSnapshot}|${writerSnapshotSha}`
      + `->${previous}|${currentConsole}|${previousManifest}|${previousManifestSha}|${baseline}|${baselineSha}`
      + `|${writerSnapshot}|${writerSnapshotSha}`,
    // These hostile caller values must not win over the canonical env file.
    CAUCE_RUNTIME_IMAGE: 'ambient/runtime:mutable',
    CAUCE_CONSOLE_IMAGE: 'ambient/console:mutable',
    CAUCE_COMPOSE_OVERRIDE_MANIFEST: '/ambient/manifest',
    CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256: `sha256:${'7'.repeat(64)}`,
    CAUCE_COMPOSE_OVERRIDES_DIR: '/ambient/overrides',
    CAUCE_LOCAL_POSTGRES: '1',
    COMPOSE_PROJECT_NAME: 'attacker-project',
    COMPOSE_PROFILES: 'shadow,attacker-profile',
    DOCKER_HOST: 'tcp://attacker.invalid:2375',
    DOCKER_CONTEXT: 'attacker-context',
    PRIVATE_PATH: 'ambient-interpolation-wins',
  });
  return {
    directory, environment, log, envFile, currentManifest, previousManifest, rollback: fixtureRollback,
    currentManifestSha, previousManifestSha, bridgeEvidence, baseline,
    writerSnapshot, writerSnapshotSha, dispatcherStopped, dispatcherRemoved, writersRemoved,
    lostForwardEnable, lostInverseEnable, bridgeInvalid,
  };
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('runtime rollback', () => {
  test('persists image and manifest, recreates the exact running set, and never invokes migrator', async () => {
    const fixture = await harness(
      ['gateway', 'dispatcher', 'outbox-metrics', 'console', 'terminal-relay', 'telegram-bridge'].join('\n'),
    );
    const result = spawnSync(fixture.rollback, ['runtime'], { encoding: 'utf8', env: fixture.environment });
    const calls = await readFile(fixture.log, 'utf8');
    expect(result.status, `${result.stderr}\n${calls}`).toBe(0);
    expect(result.stdout).toContain('completed for 3 running service(s)');
    expect(result.stdout + result.stderr).not.toContain('never-print-this-value');
    const env = await readFile(fixture.envFile, 'utf8');
    expect(env).toContain(`CAUCE_RUNTIME_IMAGE=${previous}\n`);
    expect(env).toContain(`CAUCE_CONSOLE_IMAGE=${currentConsole}\n`);
    expect(env).toContain(`CAUCE_COMPOSE_OVERRIDE_MANIFEST=${fixture.previousManifest}\n`);
    expect(env).toContain(`CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256=${fixture.previousManifestSha}\n`);
    expect(calls).toContain('terminal-relay');
    expect(calls).toContain('telegram-bridge');
    expect(calls).toContain(`--expected-repository-digest ${previous}`);
    expect(calls).toContain(`--expected-image-id ${previousId}`);
    expect(calls).not.toContain('deploy/migrate.mjs');
    expect(calls).toContain('--no-deps --wait --wait-timeout 180');
    expect(calls).toMatch(
      /stop --timeout 45 gateway dispatcher console[\s\S]*stop --timeout 45 telegram-bridge terminal-relay[\s\S]*pin-operation swap/u,
    );
    const bridgeUp = calls.split('\n').find((line) => line.includes(' up -d '));
    expect(bridgeUp).toContain('gateway');
    expect(bridgeUp).toContain('outbox-metrics');
    expect(bridgeUp).toContain('console');
    expect(bridgeUp).not.toContain('dispatcher');
    expect(calls).not.toContain('exec -T dispatcher');
    expect(await readFile(fixture.dispatcherStopped, 'utf8')).toBe('');
    expect(await readFile(fixture.dispatcherRemoved, 'utf8')).toBe('');
    expect(await readFile(fixture.writersRemoved, 'utf8')).toBe('');
    expect(calls).toContain('rm -f dispatcher telegram-bridge terminal-relay');
    expect(calls).toContain('control project=cauce-v3-prod profiles= host=unix:///var/run/docker.sock context= interpolation=');
    expect(calls).not.toContain('attacker-project');
    expect(calls).not.toContain('attacker.invalid');
    expect(calls).not.toContain('ambient-interpolation-wins');
  });

  test.each([
    ['wrong project', 'COMPOSE_PROJECT_NAME=attacker-project'],
    ['unsupported profile', 'COMPOSE_PROFILES=shadow,attacker-profile'],
    ['env-file daemon redirect', 'DOCKER_HOST=tcp://attacker.invalid:2375'],
    ['env-file context redirect', 'DOCKER_CONTEXT=attacker-context'],
  ])('%s in the private env fails closed before Docker or selector CAS', async (_label, poison) => {
    const fixture = await harness(['gateway', 'dispatcher', 'outbox-metrics'].join('\n'));
    const original = await readFile(fixture.envFile, 'utf8');
    const key = poison.slice(0, poison.indexOf('='));
    const existing = new RegExp(`^${key}=.*$`, 'mu');
    const poisoned = existing.test(original) ? original.replace(existing, poison) : `${original}${poison}\n`;
    await writeFile(fixture.envFile, poisoned, { mode: 0o600 });

    const result = spawnSync(fixture.rollback, ['runtime'], {
      encoding: 'utf8', env: fixture.environment,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unsafe Docker/Compose controls');
    expect(await readFile(fixture.envFile, 'utf8')).toBe(poisoned);
    const calls = await readFile(fixture.log, 'utf8').catch(() => '');
    expect(calls).not.toMatch(/(?:pull| up -d |SWAP|swap)/u);
  });

  test('rolls back only console through the complete selector CAS without probing schema', async () => {
    const fixture = await harness('console');
    Object.assign(fixture.environment, {
      CAUCE_PREVIOUS_CONSOLE_IMAGE: previousConsole,
      CAUCE_ROLLBACK_CONFIRM:
        `release-selectors:console:${current}|${currentConsole}|${fixture.currentManifest}|${fixture.currentManifestSha}|${fixture.baseline}|${baselineSha}`
        + `|${fixture.writerSnapshot}|${fixture.writerSnapshotSha}`
        + `->${current}|${previousConsole}|${fixture.currentManifest}|${fixture.currentManifestSha}|${fixture.baseline}|${baselineSha}`
        + `|${fixture.writerSnapshot}|${fixture.writerSnapshotSha}`,
    });
    const result = spawnSync(fixture.rollback, ['console'], { encoding: 'utf8', env: fixture.environment });
    expect(result.status, result.stderr).toBe(0);
    const env = await readFile(fixture.envFile, 'utf8');
    expect(env).toContain(`CAUCE_RUNTIME_IMAGE=${current}\n`);
    expect(env).toContain(`CAUCE_CONSOLE_IMAGE=${previousConsole}\n`);
    expect(env).toContain(`CAUCE_COMPOSE_OVERRIDE_MANIFEST=${fixture.currentManifest}\n`);
    expect(env).toContain(`CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256=${fixture.currentManifestSha}\n`);
    const calls = await readFile(fixture.log, 'utf8');
    expect(calls).not.toContain('deploy/schema-version.mjs');
    expect(calls).toContain(`pull ${previousConsole}`);
    expect(calls).not.toContain(' up -d --no-build --no-deps --wait --wait-timeout 180 gateway');
  });

  test('refuses a legacy console before quiesce or CAS when no active bridge gate can prove read-only', async () => {
    const fixture = await harness('console', '', '037_console_publish_intent_indexes.sql', 'pass', 'absent');
    Object.assign(fixture.environment, {
      CAUCE_PREVIOUS_CONSOLE_IMAGE: previousConsole,
      CAUCE_ROLLBACK_CONFIRM:
        `release-selectors:console:${current}|${currentConsole}|${fixture.currentManifest}|${fixture.currentManifestSha}|${fixture.baseline}|${baselineSha}`
        + `|${fixture.writerSnapshot}|${fixture.writerSnapshotSha}`
        + `->${current}|${previousConsole}|${fixture.currentManifest}|${fixture.currentManifestSha}|${fixture.baseline}|${baselineSha}`
        + `|${fixture.writerSnapshot}|${fixture.writerSnapshotSha}`,
    });

    const result = spawnSync(fixture.rollback, ['console'], { encoding: 'utf8', env: fixture.environment });
    const calls = await readFile(fixture.log, 'utf8');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('lacks compatible multi-intent publish journal capability');
    expect(calls).not.toMatch(/ stop |SWAP/u);
  });

  test('admits a legacy console only when the running gateway proves the bridge read-only gate', async () => {
    const fixture = await harness(
      ['gateway', 'console'].join('\n'), '', '037_console_publish_intent_indexes.sql',
      'pass', 'absent', true,
    );
    Object.assign(fixture.environment, {
      CAUCE_PREVIOUS_CONSOLE_IMAGE: previousConsole,
      CAUCE_ROLLBACK_CONFIRM:
        `release-selectors:console:${current}|${currentConsole}|${fixture.currentManifest}|${fixture.currentManifestSha}|${fixture.baseline}|${baselineSha}`
        + `|${fixture.writerSnapshot}|${fixture.writerSnapshotSha}`
        + `->${current}|${previousConsole}|${fixture.currentManifest}|${fixture.currentManifestSha}|${fixture.baseline}|${baselineSha}`
        + `|${fixture.writerSnapshot}|${fixture.writerSnapshotSha}`,
    });

    const result = spawnSync(fixture.rollback, ['console'], { encoding: 'utf8', env: fixture.environment });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('only because the active gateway proved');
    const calls = await readFile(fixture.log, 'utf8');
    expect(calls).toContain('exec -T gateway node --input-type=module -');
  });

  test('rolls back runtime, console, and manifest as one complete release transition', async () => {
    const fixture = await harness(['gateway', 'dispatcher', 'outbox-metrics', 'console'].join('\n'));
    Object.assign(fixture.environment, {
      CAUCE_PREVIOUS_CONSOLE_IMAGE: previousConsole,
      CAUCE_ROLLBACK_CONFIRM:
        `release-selectors:release:${current}|${currentConsole}|${fixture.currentManifest}|${fixture.currentManifestSha}|${fixture.baseline}|${baselineSha}`
        + `|${fixture.writerSnapshot}|${fixture.writerSnapshotSha}`
        + `->${previous}|${previousConsole}|${fixture.previousManifest}|${fixture.previousManifestSha}|${fixture.baseline}|${baselineSha}`
        + `|${fixture.writerSnapshot}|${fixture.writerSnapshotSha}`,
    });
    const result = spawnSync(fixture.rollback, ['release'], { encoding: 'utf8', env: fixture.environment });
    expect(result.status, result.stderr).toBe(0);
    const env = await readFile(fixture.envFile, 'utf8');
    expect(env).toContain(`CAUCE_RUNTIME_IMAGE=${previous}\n`);
    expect(env).toContain(`CAUCE_CONSOLE_IMAGE=${previousConsole}\n`);
    expect(env).toContain(`CAUCE_COMPOSE_OVERRIDE_MANIFEST=${fixture.previousManifest}\n`);
    expect(env).toContain(`CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256=${fixture.previousManifestSha}\n`);
    const calls = await readFile(fixture.log, 'utf8');
    const bridgeUp = calls.split('\n').find((line) => line.includes(' up -d '));
    expect(bridgeUp).toBeDefined();
    expect(bridgeUp).not.toContain('dispatcher');
    expect(await readFile(fixture.dispatcherStopped, 'utf8')).toBe('');
  });

  test('compensates both durable selectors and services after target verification fails', async () => {
    const fixture = await harness(
      ['gateway', 'dispatcher', 'outbox-metrics', 'terminal-relay'].join('\n'),
      'gateway',
    );
    const result = spawnSync(fixture.rollback, ['runtime'], { encoding: 'utf8', env: fixture.environment });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('prior durable release selectors and running services were restored');
    const env = await readFile(fixture.envFile, 'utf8');
    expect(env).toContain(`CAUCE_RUNTIME_IMAGE=${current}\n`);
    expect(env).toContain(`CAUCE_COMPOSE_OVERRIDE_MANIFEST=${fixture.currentManifest}\n`);
    expect(env).toContain(`CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256=${fixture.currentManifestSha}\n`);
    const calls = await readFile(fixture.log, 'utf8');
    expect(calls.match(/ up -d /gu)).toHaveLength(4);
    expect(calls).toMatch(/up -d[^\n]*gateway outbox-metrics console[\s\S]*stop --timeout 45 gateway dispatcher console[\s\S]*pin-operation swap/u);
    expect(calls).toMatch(/up -d[^\n]*dispatcher gateway outbox-metrics[\s\S]*up -d[^\n]*terminal-relay[\s\S]*writer-state restore lock=4[\s\S]*up -d[^\n]*outbox-metrics/u);
    await expect(readFile(fixture.dispatcherStopped, 'utf8')).rejects.toThrow();
  });

  test('re-admits a target whose durable selector CAS response was lost', async () => {
    const fixture = await harness(['gateway', 'dispatcher', 'outbox-metrics'].join('\n'));
    await writeFile(fixture.lostForwardEnable, '1\n');
    const result = spawnSync(fixture.rollback, ['runtime'], { encoding: 'utf8', env: fixture.environment });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('lost selector-CAS response after target state became durable');
    expect(await readFile(fixture.envFile, 'utf8')).toContain(`CAUCE_RUNTIME_IMAGE=${previous}\n`);
  });

  test('re-admits an inverse CAS whose response was lost and completes service recovery', async () => {
    const fixture = await harness(
      ['gateway', 'dispatcher', 'outbox-metrics', 'terminal-relay'].join('\n'),
      'gateway',
    );
    await writeFile(fixture.lostInverseEnable, '1\n');
    const result = spawnSync(fixture.rollback, ['runtime'], { encoding: 'utf8', env: fixture.environment });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('lost inverse-CAS response after prior state became durable');
    expect(result.stderr).toContain('prior durable release selectors and running services were restored');
    expect(await readFile(fixture.envFile, 'utf8')).toContain(`CAUCE_RUNTIME_IMAGE=${current}\n`);
  });

  test('fails before durable mutation when a mandatory service was not running', async () => {
    const fixture = await harness(['gateway', 'dispatcher'].join('\n'));
    const result = spawnSync(fixture.rollback, ['runtime'], { encoding: 'utf8', env: fixture.environment });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('mandatory service was not running');
    expect(await readFile(fixture.envFile, 'utf8')).toContain(`CAUCE_RUNTIME_IMAGE=${current}\n`);
    const calls = await readFile(fixture.log, 'utf8');
    expect(calls).not.toContain(' up -d ');
  });

  test('fails before durable mutation when the bridge evidence gate rejects the target image', async () => {
    const fixture = await harness(
      ['gateway', 'dispatcher', 'outbox-metrics'].join('\n'),
    );
    await writeFile(fixture.bridgeInvalid, '1\n');
    const result = spawnSync(fixture.rollback, ['runtime'], { encoding: 'utf8', env: fixture.environment });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('lacks exact passing rollback bridge evidence');
    expect(await readFile(fixture.envFile, 'utf8')).toContain(`CAUCE_RUNTIME_IMAGE=${current}\n`);
    const calls = await readFile(fixture.log, 'utf8');
    expect(calls).not.toContain(' up -d ');
  });

  test.each([
    '029_reconcile_declared_fleet.sql',
    '030_dlq_causal_reconciliation.sql',
    '031_connection_session_fencing.sql',
    '032_terminal_session_claim_fencing.sql',
    '033_terminal_browser_owner_fencing.sql',
    '034_terminal_relay_instance_fencing.sql',
    '035_agent_profile_runtime_adoption.sql',
    '036_shadow_router_target_phase.sql',
  ])('refuses bridge evidence against obsolete database schema %s', async (obsoleteSchema) => {
    const fixture = await harness(
      ['gateway', 'dispatcher', 'outbox-metrics'].join('\n'), '', obsoleteSchema,
    );
    const result = spawnSync(fixture.rollback, ['runtime'], { encoding: 'utf8', env: fixture.environment });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('valid only for exact schema 037');
    expect(await readFile(fixture.envFile, 'utf8')).toContain(`CAUCE_RUNTIME_IMAGE=${current}\n`);
  });

  test('restores every writer and refuses selector CAS when schema-037 terminal/profile/shadow/journal preflight fails', async () => {
    const source = await readFile(rollback, 'utf8');
    for (const exactFragment of [
      "(18,'claim_target_started','boolean',true,'false'::text)",
      "constraint_record.conname='shadow_router_inbox_claim_phase_shape'",
      '3744b38b5e27f0def89f983afce9987b6bfb225a120dbec432fdb426008a262c',
      '7c24fde424d76277733cb0403399378cc88942a186fff9754afa3355fc11f54c',
      'ce8ca46fd783f4d05d00ce59fad7d08c2ebf26bfd8c47c38b3082b4164dc84fa',
      '12c9f73d21b93bdf6f283b156c35590ccd082183f69833d3b245123166ae7eb5',
      "WHERE status='processing') AS shadow_processing_count",
      "version='037_console_publish_intent_indexes.sql'",
      'audit_events_console_publish_key_037_idx',
      'audit_events_console_publish_nonce_037_idx',
      'audit_events_console_publish_rate_037_idx',
      'audit_events_console_publish_head_037_idx',
      "SET LOCAL plan_cache_mode='force_generic_plan'",
    ]) {
      expect(source).toContain(exactFragment);
    }
    const fixture = await harness(
      ['gateway', 'dispatcher', 'outbox-metrics', 'terminal-relay'].join('\n'),
      '', '037_console_publish_intent_indexes.sql', 'fail',
    );
    const result = spawnSync(fixture.rollback, ['runtime'], {
      encoding: 'utf8', env: fixture.environment,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('terminal fences were not fully drained');
    expect(await readFile(fixture.envFile, 'utf8')).toContain(`CAUCE_RUNTIME_IMAGE=${current}\n`);
    const calls = await readFile(fixture.log, 'utf8');
    expect(calls).toMatch(/stop --timeout 45 terminal-relay[\s\S]*node --input-type=module -[\s\S]*up -d[^\n]*terminal-relay/u);
    expect(calls).not.toContain('SWAP');
  });

  test('evidence cycle runs the shared locked transaction and compensates a real probe outage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cauce-rollback-evidence-cycle-'));
    scratch.push(directory);
    const evidenceRoot = join(directory, 'transaction');
    const bin = join(directory, 'bin');
    const state = join(directory, 'runtime.state');
    const candidateGeneration = join(directory, 'candidate.generation');
    const postgresState = join(directory, 'postgres.state');
    const log = join(directory, 'docker.log');
    await mkdir(evidenceRoot, { mode: 0o700 });
    await mkdir(bin);
    await writeFile(state, 'none\n');
    await writeFile(candidateGeneration, '0\n');
    await writeFile(postgresState, 'up\n');
    const fakeDocker = join(bin, 'docker');
    await writeFile(fakeDocker, `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = inspect ]; then
  last=; for value in "$@"; do last=$value; done
  case " $* " in
    *'.State.Health'*) printf 'healthy\n' ;;
    *)
      case "$last" in
        cid-candidate-*) printf '%s\n' "$FAKE_CANDIDATE_ID" ;;
        cid-bridge) printf '%s\n' "$FAKE_BRIDGE_ID" ;;
        *) exit 1 ;;
      esac ;;
  esac
  exit 0
fi
[ "$1" = compose ] || exit 1
last=; for value in "$@"; do last=$value; done
case " $* " in
  *' ps -q candidate '*) printf 'cid-candidate-%s\n' "$(sed -n '1p' "$FAKE_CANDIDATE_GENERATION")"; exit 0 ;;
  *' ps -q bridge '*) printf 'cid-bridge\n'; exit 0 ;;
  *' ps --services --status running '*)
    runtime=$(sed -n '1p' "$FAKE_RUNTIME_STATE")
    [ "$runtime" = none ] || printf '%s\n' "$runtime"
    [ "$(sed -n '1p' "$FAKE_POSTGRES_STATE")" = up ] && printf 'postgres\n'
    exit 0 ;;
  *' stop '*' postgres '*) printf 'down\n' > "$FAKE_POSTGRES_STATE"; exit 0 ;;
  *' stop '*' candidate '*) [ "$(sed -n '1p' "$FAKE_RUNTIME_STATE")" != candidate ] || printf 'none\n' > "$FAKE_RUNTIME_STATE"; exit 0 ;;
  *' stop '*' bridge '*) [ "$(sed -n '1p' "$FAKE_RUNTIME_STATE")" != bridge ] || printf 'none\n' > "$FAKE_RUNTIME_STATE"; exit 0 ;;
  *' up -d '*' postgres '*) printf 'up\n' > "$FAKE_POSTGRES_STATE"; exit 0 ;;
  *' up -d '*' candidate '*)
    generation=$(sed -n '1p' "$FAKE_CANDIDATE_GENERATION")
    generation=$((generation + 1))
    printf '%s\n' "$generation" > "$FAKE_CANDIDATE_GENERATION"
    printf 'candidate\n' > "$FAKE_RUNTIME_STATE"
    exit 0 ;;
  *' up -d '*' bridge '*) printf 'bridge\n' > "$FAKE_RUNTIME_STATE"; exit 0 ;;
  *' exec -T candidate node /rollback-probes/database-health.mjs '*|*' exec -T bridge node /rollback-probes/database-health.mjs '*)
    [ "$(sed -n '1p' "$FAKE_POSTGRES_STATE")" = up ]; exit ;;
esac
exit 1
`, { mode: 0o755 });
    await chmod(fakeDocker, 0o755);
    const candidate = `registry.invalid/cauce/runtime@sha256:${'1'.repeat(64)}`;
    const bridge = `registry.invalid/cauce/bridge@sha256:${'2'.repeat(64)}`;
    const candidateId = `sha256:${'3'.repeat(64)}`;
    const bridgeId = `sha256:${'4'.repeat(64)}`;
    const result = spawnSync(rollback, ['evidence-cycle'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        FAKE_DOCKER_LOG: log,
        FAKE_RUNTIME_STATE: state,
        FAKE_CANDIDATE_GENERATION: candidateGeneration,
        FAKE_POSTGRES_STATE: postgresState,
        FAKE_CANDIDATE_ID: candidateId,
        FAKE_BRIDGE_ID: bridgeId,
        CAUCE_ROLLBACK_EVIDENCE_MODE: 'isolated-compose-v1',
        CAUCE_ROLLBACK_EVIDENCE_ROOT: evidenceRoot,
        CAUCE_ROLLBACK_EVIDENCE_PROJECT: `cauce-rollback-bridge-${'5'.repeat(16)}`,
        CAUCE_ROLLBACK_EVIDENCE_COMPOSE_FILE: join(repository, 'ops/compose.rollback-bridge.yaml'),
        CAUCE_ROLLBACK_EVIDENCE_CANDIDATE_IMAGE: candidate,
        CAUCE_ROLLBACK_EVIDENCE_BRIDGE_IMAGE: bridge,
        CAUCE_ROLLBACK_EVIDENCE_CANDIDATE_ID: candidateId,
        CAUCE_ROLLBACK_EVIDENCE_BRIDGE_ID: bridgeId,
      },
    });
    expect(result.status, `${result.stderr}\n${await readFile(log, 'utf8')}`).toBe(0);
    const observed: unknown = JSON.parse(result.stdout);
    expect(observed).toEqual({
      candidateImageRestored: true,
      composeRecreateObserved: true,
      failureInjection: 'postgres-unavailable-after-selector-swap',
      failureObserved: true,
      lostForwardCasResponseRecovered: true,
      rollbackAction: 'rollback-sh-shared-transaction',
      selectorCasRestored: true,
      servicesRestored: true,
      status: 'passed',
      transitionLockScope: 'selector-deploy-health-compensation',
    });
    const selector = await readFile(join(evidenceRoot, 'release.env'), 'utf8');
    expect(selector).toContain(`CAUCE_RUNTIME_IMAGE=${candidate}\n`);
    expect(selector).toContain(`CAUCE_COMPOSE_OVERRIDE_MANIFEST=${join(evidenceRoot, 'candidate.manifest')}\n`);
    expect(selector).toMatch(/CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256=sha256:[a-f0-9]{64}\n/u);
    const calls = await readFile(log, 'utf8');
    expect(calls).toContain('stop --timeout 10 postgres');
    expect(calls.match(/up -d --force-recreate --no-build --no-deps --wait --wait-timeout 60 candidate/gu)).toHaveLength(2);
    expect(calls).toContain('up -d --force-recreate --no-build --no-deps --wait --wait-timeout 60 bridge');
  });
});
