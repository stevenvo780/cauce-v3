#!/usr/bin/env bash
set -euo pipefail

readonly BASE_COMMIT='79d6d8f1eae00e733bf2aeddaffeb592e5944687'
readonly PATCH_SHA256='f6c61ed1c8e2bc3e6c021ad56fa27142f8996571ae250e4484a464756bdb9733'
readonly RESULT_TREE='72cb55a2b4a9413193da69298ebb0c548955d9a6'

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repository=$(git -C "$script_dir/../.." rev-parse --show-toplevel)
patch="$script_dir/rollback-bridge-schema029.patch"
git -C "$repository" cat-file -e "${BASE_COMMIT}^{commit}"
printf '%s  %s\n' "$PATCH_SHA256" "$patch" | sha256sum --check --status

scratch=$(mktemp -d "${TMPDIR:-/tmp}/cauce-rollback-bridge-test.XXXXXX")
worktree="$scratch/source"
core_log="$scratch/core-typecheck.log"
repository_lint="$scratch/repository-eslint.json"
cleanup() {
  rm -f -- "$core_log" "$repository_lint"
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
pnpm install --frozen-lockfile
pnpm typecheck:adapter

if ! pnpm typecheck:core >"$core_log" 2>&1; then
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const lines = readFileSync(process.argv[1], "utf8").split(/\r?\n/u)
      .filter((line) => /error TS\d+:/u.test(line));
    const dispatcher = lines.filter((line) => line.startsWith("services/dispatcher/test/liveness.test.ts(") && line.includes("TS2339")).length;
    const gateway = lines.filter((line) => line.startsWith("services/gateway/src/health-progress.test.ts(") && line.includes("TS2353")).length;
    if (lines.length !== 12 || dispatcher !== 7 || gateway !== 5) {
      process.stderr.write("core typecheck differs from the exact origin/main baseline\n");
      process.stderr.write(lines.join("\n") + "\n");
      process.exit(1);
    }
  ' "$core_log"
fi

pnpm exec eslint \
  packages/protocol/src/schemas.ts \
  packages/store/src/agent-profile.ts \
  packages/store/src/configuration.ts \
  packages/adapter-sdk/src/sdk/engine.ts \
  packages/adapter-sdk/test/engine.test.ts \
  tests/unit/rollback-bridge.test.ts

if ! pnpm exec eslint packages/store/src/repository.ts --format json >"$repository_lint"; then
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const reports = JSON.parse(readFileSync(process.argv[1], "utf8"));
    const messages = reports.flatMap((report) => report.messages);
    if (messages.length !== 1 || messages[0]?.ruleId !== "@typescript-eslint/no-unused-vars" || !messages[0]?.message.includes("_visible")) {
      process.stderr.write("repository lint differs from the exact origin/main baseline\n");
      process.exit(1);
    }
  ' "$repository_lint"
fi

pnpm exec vitest run tests/unit/rollback-bridge.test.ts --reporter=dot
pnpm --filter @cauce/adapter-sdk exec node --test --import tsx test/engine.test.ts
git diff --cached --check
printf 'rollback bridge source verification passed: tree=%s\n' "$tree"
