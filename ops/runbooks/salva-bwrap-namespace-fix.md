# Runbook: Salva bwrap namespace error fix

## Problem

The `salva` adapter (tenant Isa, harness codex, container ws-isa) failed with `bwrap: No permissions to create a new namespace` when trying to execute `codex --version` or any CLI command. This was despite:
- The container supporting user namespaces (`unprivileged_userns_clone=1`)
- Manual execution of `codex` working fine
- Atlas and Dedalo adapters working normally

## Root Cause

The root container (`ws-isa`) mounted `/datos/agents/isa-config/.local` as `/home/dev/.local`, but this directory was incomplete. It contained only 24 binaries in `.local/bin/`, while the reference mount `/datos/agents/shared/.local` had 124 binaries — a difference of 100 missing tools/scripts that the SDK and Codex CLI require to execute properly.

The bwrap sandbox sandbox creation failed because critical tools or scripts were missing from the SDK's execution environment when it tried to spawn the `codex` process.

## Solution

Synchronize missing files from the shared agent config to salva's private config:

```bash
# On kratos (host):
rsync -av /datos/agents/shared/.local/bin/ /datos/agents/isa-config/.local/bin/
rsync -av /datos/agents/shared/.local/share/ /datos/agents/isa-config/.local/share/ \
  --exclude='__pycache__' --exclude='*.pyc'

# Restart the adapter:
ssh kratos "systemctl --user restart cauce-v3-container-salva.service"
```

## Verification

- `docker exec -u dev ws-isa codex --version` returns `codex-cli 0.144.5` (no bwrap error)
- `docker exec -u dev ws-isa bash -c 'echo test > /tmp/test.txt && cat /tmp/test.txt'` succeeds
- `salva` processes deliveries from the bus successfully

## Prevention

If this issue recurs after a container recreation:
1. Ensure `/datos/agents/isa-config/.local/` is synchronized with `/datos/agents/shared/.local/` before starting the adapter.
2. Consider mounting `/datos/agents/shared/.local` directly instead of a private copy, unless there's a specific reason for isolation.
3. If a private mount is required, keep it synchronized with the shared version regularly.

## Impact

This fix is **reversible**: if the root cause is later found and fixed in the container definition or the agent config, the synchronized files in `/datos/agents/isa-config/.local` will simply be redundant but harmless.
