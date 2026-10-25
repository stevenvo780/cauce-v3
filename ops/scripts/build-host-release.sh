#!/usr/bin/env bash
# Builds what `cauce hosts setup` downloads from the gateway: release.tar (executor, host process, real adapter),
# agent-image.tar.gz, quota-image.tar.gz and host-release.json with their pins.
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
git archive HEAD ops/cli ops/scripts ops/container-runtime ops/schemas ops/pty-agent/reap_orphan_agent.py | tar -x -C "$stage"
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
# Without attestations, with a fixed creation time and layer file mtimes clamped to it (rewrite-timestamp), a rebuild
# with a cold cache keeps the portable config digest pinned from docker save; otherwise npm/apt mtimes change every layer.
# The bridge context holds only the committed bridge: the checkout's ops/container-runtime also carried __pycache__,
# whose embedded source mtimes changed that layer and the image Id on every build of unchanged sources.
mkdir "$work/musebridge" "$work/quotareaders"
install -m 0755 "$stage/ops/container-runtime/muse-cauce" "$work/musebridge/muse-cauce"
git archive HEAD ops/cuotas/leer-cuota.mjs ops/cuotas/leer-cuota-grok.mjs ops/cuotas/codex-http-probe.py \
  | tar -x --strip-components=2 -C "$work/quotareaders"
image="cauce-agent-runtime:$(cat ops/agent-runtime/Dockerfile "$work/musebridge/muse-cauce" "$work/quotareaders/"* | sha256sum | cut -c1-16)"
docker build -q --provenance=false --build-context "musebridge=$work/musebridge" --build-context "quotareaders=$work/quotareaders" \
  --build-arg "SOURCE_DATE_EPOCH=$(git log -1 --format=%ct -- ops/agent-runtime/Dockerfile ops/container-runtime/muse-cauce ops/cuotas/leer-cuota.mjs ops/cuotas/leer-cuota-grok.mjs ops/cuotas/codex-http-probe.py)" \
  --output "type=docker,rewrite-timestamp=true,name=$image,dest=$work/agent-image.oci.tar" ops/agent-runtime >/dev/null
# The containerd image store refuses rewrite-timestamp with its default unpack, so export to a tar and load it.
docker load -q -i "$work/agent-image.oci.tar" >/dev/null && rm -f "$work/agent-image.oci.tar"
agy_version=$(sed -n 's/^ARG AGY_VERSION=//p' ops/cuotas/Dockerfile)
agy_sha=$(sed -n 's/^ARG AGY_X86_64_SHA256=//p' ops/cuotas/Dockerfile)
agy_filename="agy-${agy_version}-linux-x86-64"
agy_source="${CAUCE_QUOTA_AGY_CONTEXT:+${CAUCE_QUOTA_AGY_CONTEXT}/$agy_filename}"
agy_source=${agy_source:-$HOME/.local/bin/agy}
mkdir "$work/agybin"
if [[ -f $agy_source && $(sha256sum "$agy_source" | cut -d' ' -f1) == "$agy_sha" ]]; then
  install -m 0555 "$agy_source" "$work/agybin/$agy_filename"
elif [[ -n ${CAUCE_QUOTA_AGY_CONTEXT:-} ]]; then
  echo "quota agy context must contain $agy_filename with the Dockerfile SHA-256" >&2; exit 1
else
  echo 'quota image: pinned agy binary unavailable; agy will not be advertised' >&2
fi
quota_image="cauce-quota-runtime:$(sha256sum ops/cuotas/Dockerfile | cut -c1-16)-$(find "$work/agybin" -type f | wc -l)"
docker build -q --provenance=false --build-context "agybin=$work/agybin" \
  --build-arg "SOURCE_DATE_EPOCH=$(git log -1 --format=%ct -- ops/cuotas/Dockerfile)" \
  --output "type=docker,rewrite-timestamp=true,name=$quota_image,dest=$work/quota-image.oci.tar" ops/cuotas >/dev/null
docker load -q -i "$work/quota-image.oci.tar" >/dev/null && rm -f "$work/quota-image.oci.tar"
docker run --rm --network none -v "$stage/ops/container-runtime:/cauce/lifecycle:ro" --entrypoint python3 "$image" \
  /cauce/lifecycle/cauce-container-runtime.py bundle-digest /cauce/lifecycle >/dev/null
# `codex` on PATH is a Node launcher; the provider login pins its argv[0] with O_NOFOLLOW, so the pin names the native binary.
codex_native=$(docker run --rm --network none --entrypoint sh "$image" -c \
  'find /usr/local/lib/node_modules/@openai/codex -path "*/vendor/*-unknown-linux-musl/bin/codex" -type f')
[[ $codex_native == /usr/local/lib/node_modules/@openai/codex/*/bin/codex && $codex_native != *$'\n'* ]] || {
  echo "expected one native Codex binary in $image, found: ${codex_native:-none}" >&2; exit 1;
}
openclaw_auth_list=/usr/local/lib/node_modules/openclaw/dist/auth-list-DlV7Wk-6.js
openclaw_auth_list_sha=$(docker run --rm --network none --entrypoint sha256sum "$image" "$openclaw_auth_list" | cut -d' ' -f1)
muse_bridge_sha=$(docker run --rm --network none --entrypoint sha256sum "$image" /usr/local/bin/muse-cauce | cut -d' ' -f1)
python3 ops/scripts/host-release.py pack --stage "$stage" --out "$target" --revision "$revision" --epoch "$epoch" \
  --image "$image" --quota-image "$quota_image" --provider "codex=$codex_native" --provider claude=claude --provider grok=grok \
  --provider muse=muse --provider openclaw=openclaw --provider node=node \
  --pin "openclaw_auth_list_source=$openclaw_auth_list" --pin "openclaw_auth_list_sha256=$openclaw_auth_list_sha" \
  --pin "openclaw_bridge_sha256=$(sha256sum "$stage/adapter/packages/adapter-sdk/dist/bridge/openclaw-stdin-bridge.mjs" | cut -d' ' -f1)" \
  --pin "muse_bridge_sha256=$muse_bridge_sha"
