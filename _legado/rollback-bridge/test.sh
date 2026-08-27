#!/usr/bin/env bash
set -euo pipefail

readonly BASE_COMMIT='79d6d8f1eae00e733bf2aeddaffeb592e5944687'
readonly PATCH_SHA256='78c561b9a80e734ae9a7afbb0fcef5232b83f1c10c2dd6e3923ddac124a043b0'
readonly RESULT_TREE='4036d502d7d8a788ffe1a81aef8b74462b63e012'

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repository=$(git -C "$script_dir/../.." rev-parse --show-toplevel)
patch="$script_dir/rollback-bridge-schema029.patch"
[[ -x $script_dir/build.sh ]] || {
  printf 'rollback bridge build entrypoint is not executable\n' >&2
  exit 1
}
git -C "$repository" cat-file -e "${BASE_COMMIT}^{commit}"
printf '%s  %s\n' "$PATCH_SHA256" "$patch" | sha256sum --check --status
node --test "$script_dir/publish.test.mjs"
python3 -m py_compile \
  "$repository/ops/scripts/produce-rollback-bridge-evidence.py" \
  "$repository/ops/scripts/validate-rollback-bridge-evidence.py"
pnpm --dir "$repository" exec vitest run \
  tests/unit/rollback-bridge-producer.test.ts \
  tests/unit/rollback-bridge-evidence.test.ts \
  tests/unit/rollback-baseline.test.ts \
  packages/store/test/agent-profile-runtime-adoption-migration-postgres.test.ts \
  packages/store/test/agent-profile-runtime-adoption-postgres.test.ts \
  tests/store-hardening/shadow-router-target-phase-postgres.test.ts \
  --reporter=dot

scratch=$(mktemp -d "${TMPDIR:-/tmp}/cauce-rollback-bridge-test.XXXXXX")
worktree="$scratch/source"
cleanup() {
  if [[ -d "$worktree" ]]; then
    git -C "$repository" worktree remove --force "$worktree" >/dev/null 2>&1 || true
  fi
  rmdir -- "$scratch" >/dev/null 2>&1 || true
}
trap cleanup EXIT

git -C "$repository" worktree add --detach "$worktree" "$BASE_COMMIT" >/dev/null
git -C "$worktree" apply --check "$patch"
git -C "$worktree" apply "$patch"
git -C "$worktree" add --all
tree=$(git -C "$worktree" write-tree)
[[ "$tree" == "$RESULT_TREE" ]] || {
  printf 'resulting bridge tree mismatch: expected %s, observed %s\n' "$RESULT_TREE" "$tree" >&2
  exit 1
}

cd "$worktree"
node --check deploy/fleet-snapshot.mjs
grep -Fq 'deploy/fleet-snapshot.mjs' deploy/Dockerfile
for runtime_input in \
  deploy/local-readiness-probe.mjs \
  deploy/migration-integrity.mjs \
  deploy/schema-version.mjs \
  deploy/reconcile-stale-console-outbox.mjs \
  deploy/reconcile-stale-console-outbox-core.mjs; do
  [[ -f $runtime_input ]] || {
    printf 'rollback bridge runtime build input is absent: %s\n' "$runtime_input" >&2
    exit 1
  }
done
if grep -Eq '^[[:space:]]*COPY[[:space:]].*--chmod=' deploy/Dockerfile; then
  printf 'rollback bridge Dockerfile still requires COPY --chmod\n' >&2
  exit 1
fi
if grep -Eq '^[[:space:]]*RUN[[:space:]].*apk[[:space:]]+add' deploy/Dockerfile; then
  printf 'rollback bridge Dockerfile still performs a mutable apk install\n' >&2
  exit 1
fi
grep -Fq 'FROM ${CAUCE_PYTHON_BASE} AS python-runtime' deploy/Dockerfile
grep -Fq 'COPY --from=python-runtime /usr/local /usr/local' deploy/Dockerfile
grep -Fq 'io.cauce.target-platform=${CAUCE_TARGET_PLATFORM}' deploy/Dockerfile
grep -Fq 'io.cauce.rollback-bridge.read-only=server-v2' deploy/Dockerfile
grep -Fq 'deploy/rollback-bridge-http-probe.mjs' deploy/Dockerfile
node --check deploy/rollback-bridge-http-probe.mjs
pnpm install --frozen-lockfile
pnpm typecheck:adapter
pnpm typecheck:core

pnpm exec eslint \
  packages/protocol/src/schemas.ts \
  packages/store/src/agent-profile.ts \
  packages/store/src/configuration.ts \
  packages/store/src/db.ts \
  packages/store/src/migration-integrity.ts \
  deploy/fleet-snapshot.mjs \
  deploy/liveness-probe.mjs \
  deploy/runtime-package-smoke.mjs \
  packages/adapter-sdk/src/sdk/engine.ts \
  packages/adapter-sdk/test/engine.test.ts \
  services/dispatcher/src/config.ts \
  services/dispatcher/src/main.ts \
  services/dispatcher/src/metrics.ts \
  services/dispatcher/test/liveness.test.ts \
  services/gateway/src/app.ts \
  services/gateway/src/health.ts \
  services/gateway/src/health-progress.test.ts \
  services/gateway/src/main.ts \
  services/gateway/src/rollback-bridge-read-only.ts \
  services/gateway/src/rollback-bridge-read-only.test.ts \
  services/gateway/src/wake-pump-telemetry.ts \
  services/shadow-router/src/errors.ts \
  services/shadow-router/src/http.ts \
  services/shadow-router/src/index.ts \
  services/shadow-router/src/main.ts \
  services/shadow-router/src/progress.ts \
  services/shadow-router/src/repository.ts \
  services/shadow-router/src/router.ts \
  services/shadow-router/src/target.ts \
  services/shadow-router/src/types.ts \
  services/shadow-router/src/worker.ts \
  services/shadow-router/test/http-health.test.ts \
  services/shadow-router/test/progress.test.ts \
  services/shadow-router/test/repository-health.test.ts \
  services/shadow-router/test/router.test.ts \
  services/shadow-router/test/worker-health.test.ts \
  tests/store-hardening/shadow-router-target-phase-postgres.test.ts \
  tests/unit/liveness-probe.test.ts \
  packages/store/src/repository.ts \
  tests/unit/rollback-bridge.test.ts

pnpm exec vitest run \
  tests/unit/liveness-probe.test.ts \
  tests/unit/rollback-bridge.test.ts \
  packages/store/test/console-publish-intent-migration-postgres.test.ts \
  services/gateway/src/health-progress.test.ts \
  services/gateway/src/rollback-bridge-read-only.test.ts \
  --reporter=dot
pnpm --filter @cauce/dispatcher test
pnpm --filter @cauce/adapter-sdk exec node --test --import tsx test/engine.test.ts

git diff --cached --check
printf 'rollback bridge source verification passed: tree=%s\n' "$tree"
