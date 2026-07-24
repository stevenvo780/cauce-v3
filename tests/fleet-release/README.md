# Fleet release matrix

This suite reads `ops/manifests/*.yaml` without modifying them and fails unless the fleet is exactly:

- 12 aliases
- 5 OpenClaw, 1 Claude, 1 Hermes, 5 Codex, 0 OpenCode

## Full matrix

```bash
pnpm exec vitest run tests/fleet-release --testTimeout=120000
```

`fleet-release.test.ts` starts the real Fastify gateway and a real ephemeral PostgreSQL, then launches every alias through the five packaged `cauce-adapter-*` binaries. The adapter process is classified as `adapter-authentic`; the CLI executables and loopback OpenClaw API below it are explicitly classified as `harness-double`. Every alias must demonstrate hello, a live fenced lease, correlated ACKs, one retry followed by completion, the harness session contract, and origin relay correlation.

Artifacts are written to `tests/fleet-release/artifacts/`:

- `report.json`, governed by `fleet-release-report.schema.json`
- `junit.xml`
- `binaries.sha256`, containing the five packaged adapter binary digests
- `SHA256SUMS`, covering the generated artifacts

El reporte y su propiedad JUnit incluyen el `sourceDigest` del árbol exacto que forma la imagen
runtime; el gate rechaza evidencia de otra revisión.

## Authentic harness smoke on each host

Run only on the host that owns the listed manifests. The utility uses an empty stdin, an isolated HOME/XDG tree, and an allowlisted environment. It runs only `--version` and `--help`; it does not submit a prompt or inspect auth/session state.

```bash
node tests/fleet-release/host-smoke.mjs \
  --host HOSTNAME \
  --manifest ops/manifests/ALIAS.yaml \
  --manifest ops/manifests/ANOTHER_ALIAS.yaml \
  --out /safe/evidence/HOSTNAME.json
```

Optional executable overrides are single paths, never shell fragments:

```bash
--command openclaw=/usr/local/bin/openclaw
```

Create an inventory matching `host-inventory.schema.json`. Every one of the 12 manifests must be assigned exactly once:

```json
{
  "schemaVersion": 1,
  "controlPlaneHost": "control-plane",
  "hosts": {
    "control-plane": ["ops/manifests/kant.yaml"],
    "adapter-host-a": ["ops/manifests/jarvis.yaml"]
  }
}
```

Aggregate all host evidence:

```bash
node tests/fleet-release/aggregate-host-smoke.mjs \
  --inventory /safe/evidence/inventory.json \
  --evidence /safe/evidence/control-plane.json \
  --evidence /safe/evidence/adapter-host-a.json \
  --out-dir /safe/evidence/aggregate
```

The aggregate `report.json` is governed by `host-smoke-aggregate.schema.json`. The aggregator derives requirements from the assigned manifests. It does **not** require OpenClaw on the control-plane unless that host is assigned an OpenClaw manifest. It fails if any host assigned an OpenClaw manifest lacks passing `harness-authentic` OpenClaw evidence.
