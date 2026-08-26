#!/usr/bin/env bash
set -euo pipefail

readonly BASE_COMMIT='79d6d8f1eae00e733bf2aeddaffeb592e5944687'
readonly PATCH_SHA256='76cb78aeea04ade9022593d18b2281b5d828711acf17f84fb4e6e419c1f4510a'
readonly RESULT_TREE='cd97103c333d9b7c9cf8efbd9da1bfea0ac836f9'

if [[ $# -ne 1 ]]; then
  printf 'usage: %s OUTPUT.tar\n' "$0" >&2
  exit 64
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repository=$(git -C "$script_dir/../.." rev-parse --show-toplevel)
patch="$script_dir/rollback-bridge-schema029.patch"
output=$(realpath -m -- "$1")
output_parent=$(dirname -- "$output")

[[ -d "$output_parent" ]] || { printf 'output parent does not exist\n' >&2; exit 64; }
[[ ! -e "$output" ]] || { printf 'refusing to overwrite output\n' >&2; exit 64; }
git -C "$repository" cat-file -e "${BASE_COMMIT}^{commit}"
printf '%s  %s\n' "$PATCH_SHA256" "$patch" | sha256sum --check --status

scratch=$(mktemp -d "${TMPDIR:-/tmp}/cauce-rollback-bridge-build.XXXXXX")
worktree="$scratch/source"
temporary_output="${output}.partial.$$"
cleanup() {
  rm -f -- "$temporary_output"
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

export GIT_AUTHOR_NAME='Cauce rollback bridge'
export GIT_AUTHOR_EMAIL='rollback-bridge@invalid'
export GIT_AUTHOR_DATE='2000-01-01T00:00:00Z'
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
export GIT_COMMITTER_DATE="$GIT_AUTHOR_DATE"
synthetic_commit=$(git -C "$worktree" commit-tree "$tree" -p "$BASE_COMMIT" -m 'Cauce schema-037 rollback bridge')
git -C "$worktree" archive --format=tar --output="$temporary_output" "$synthetic_commit"
mv -- "$temporary_output" "$output"
printf 'rollback bridge build context: tree=%s archive=%s\n' "$tree" "$output"
