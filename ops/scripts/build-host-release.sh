#!/usr/bin/env bash
# Builds what `cauce hosts setup` downloads from the gateway: release.tar (executor, host process, real adapter),
# agent-image.tar.gz (ops/agent-runtime with the pinned provider CLIs) and host-release.json with their pins.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
target=${1:?usage: build-host-release.sh /absolute/new/directory [ /absolute/approved-descriptors.json ]}
approvals=${2:-}
[[ $target == /* && ! -e $target ]] || { echo 'destination must be absolute and must not exist' >&2; exit 1; }
[[ -z $approvals || ( $approvals == /* && -f $approvals && ! -L $approvals ) ]] || {
  echo 'descriptor approval map must be an absolute regular file' >&2; exit 1;
}
for tool in git node pnpm python3 docker; do
  command -v "$tool" >/dev/null || { echo "missing $tool: build on a host with the repository toolchain and copy the directory" >&2; exit 1; }
done
cd "$repo_root"
[[ -z $(git status --porcelain) ]] || { echo 'commit the release sources before building' >&2; exit 1; }
[[ -x node_modules/.bin/esbuild ]] || { echo 'run pnpm install --frozen-lockfile first' >&2; exit 1; }
revision=$(git rev-parse HEAD)
epoch=$(git log -1 --format=%ct HEAD)
work=$(mktemp -d "${TMPDIR:-/tmp}/cauce-host-release.XXXXXX")
trap 'chmod -R u+w "$work" 2>/dev/null || true; rm -rf "$work"' EXIT
stage=$work/stage
mkdir "$stage"
git archive HEAD ops/cli ops/scripts ops/container-runtime ops/schemas | tar -x -C "$stage"
mkdir -p "$stage/services/gateway/dist/fleet"
NODE_PATH="$repo_root/services/gateway/node_modules:$repo_root/packages/store/node_modules:$repo_root/packages/protocol/node_modules:$repo_root/node_modules" \
  node_modules/.bin/esbuild services/gateway/src/fleet/main.ts --bundle --platform=node --format=esm --target=node22 \
  --external:pg-native --log-level=error --outfile="$stage/services/gateway/dist/fleet/main.js" \
  "--alias:@cauce/store=$repo_root/packages/store/src/index.ts" "--alias:@cauce/protocol=$repo_root/packages/protocol/src/index.ts" \
  '--banner:js=import{createRequire as __cauceRequire}from"node:module";const require=__cauceRequire(import.meta.url);'
ops/scripts/build-adapter-release.sh "$stage/adapter" ${approvals:+"$approvals"}
# pnpm records the build directory and time in these; the adapter never reads them, and they would change every build.
chmod -R u+w "$stage/adapter"
find "$stage/adapter" \( -name .modules.yaml -o -path '*/node_modules/.bin' \) -prune -exec rm -rf {} +
image="cauce-agent-runtime:$(sha256sum ops/agent-runtime/Dockerfile | cut -c1-16)"
# Without attestations and with a fixed creation time, a cached rebuild keeps the Id and computers skip the download.
docker build -q --provenance=false --build-arg "SOURCE_DATE_EPOCH=$(git log -1 --format=%ct -- ops/agent-runtime/Dockerfile)" \
  -t "$image" ops/agent-runtime >/dev/null
docker run --rm --network none -v "$stage/ops/container-runtime:/cauce/lifecycle:ro" --entrypoint python3 "$image" \
  /cauce/lifecycle/cauce-container-runtime.py bundle-digest /cauce/lifecycle >/dev/null
python3 ops/scripts/host-release.py pack --stage "$stage" --out "$target" --revision "$revision" --epoch "$epoch" \
  --image "$image" --provider codex=codex --provider claude=claude --provider grok=grok
