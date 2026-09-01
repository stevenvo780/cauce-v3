# Grafo de dependencias del repo

Generado por `pnpm grafo` (determinista — regenerar tras reordenar). Nodo = directorio; arista A→B = ficheros de A que referencian ficheros de B (peso = nº de referencias).

## El grafo (aristas con peso ≥2)

```mermaid
graph LR
  scripts __> packages_adapter_sdk
  scripts __> console
  scripts __> packages_store
  packages_store __> packages_protocol
  scripts __> services_gateway
  scripts __> ops_scripts
  tests_unit __> services_gateway
  services_gateway __> packages_store
  scripts __> tests_unit
  packages_store __> tests_helpers
  services_gateway __> packages_protocol
  scripts __> ops_tests
  scripts __> services_telegram_bridge
  tests_gateway_hardening __> services_gateway
  tests_unit __> ops_scripts
  packages_adapter_sdk __> packages_protocol
  scripts __> ops_pty_agent
  scripts __> services_terminal_relay
  ops_tests __> ops_scripts
  console __> packages_store
  scripts __> tests_gateway_hardening
  scripts __> packages_protocol
  scripts __> deploy_runtime
  tests_unit __> packages_store
  tests_unit __> packages_protocol
  tests_unit __> ops_observability
  ops_scripts __> ops
  tests_gateway_hardening __> packages_store
  tests_unit __> services_telegram_bridge
  console __> packages_protocol
  services_telegram_bridge __> packages_store
  services_telegram_bridge __> packages_protocol
  tests_gateway_hardening __> packages_protocol
  tests_store_hardening __> packages_store
  ops_scripts __> deploy
  scripts __> ops_guardias
  scripts __> tests_terminal_pty
  services_dispatcher __> packages_store
  tests_store_hardening __> tests_helpers
  tests_store_hardening __> services_gateway
  tests_unit __> packages_adapter_sdk
  console __> services_gateway
  console __> packages_adapter_sdk
  _raiz_ __> scripts
  scripts __> tests_store_hardening
  tests_e2e __> services_gateway
  ops_tests __> ops
  tests_unit __> deploy
  tests_unit __> deploy_runtime
  ops_tests __> ops_harness
  _raiz_ __> ops_scripts
  scripts __> services_dispatcher
  tests_gateway_hardening __> tests_helpers
  tests_store_hardening __> packages_protocol
  ops_scripts __> services_telegram_bridge
  ops_tests __> deploy_runtime
  ops_tests __> services_gateway
  scripts __> deploy
  scripts __> ops_harness
  scripts __> packages_mcp_fleet_monitor
  tests_integration __> tests_helpers
  tests_terminal_pty __> services_terminal_relay
  tests_unit __> services_dispatcher
  tests_unit __> scripts
  deploy __> ops_observability
  deploy_runtime __> packages_store
  ops_tests __> tests_e2e
  packages_mcp_fleet_monitor __> packages_store
  scripts __> tests_integration
  tests_e2e __> tests_helpers
  tests_unit __> ops_schemas
  ops_scripts __> packages_adapter_sdk
  ops_scripts __> packages_protocol
  ops_scripts __> console
  ops_scripts __> ops_observability
  ops_tests __> tests_helpers
  ops_tests __> ops_schemas
  ops_tests __> packages_store
  _raiz_ __> ops_harness
  _raiz_ __> ops_tests
  _raiz_ __> services_gateway
  _raiz_ __> packages_store
  _raiz_ __> console
  packages_store __> deploy
  packages_store __> packages_adapter_sdk
  scripts __> ops_container_runtime
  scripts __> ops_patches
  scripts __> tests_e2e
  services_dispatcher __> tests_helpers
  services_gateway __> tests_helpers
  services_telegram_bridge __> tests_helpers
  tests_e2e __> ops_harness
  tests_integration __> packages_store
  tests_integration __> services_gateway
  tests_store_hardening __> ops_scripts
  tests_terminal_pty __> services_gateway
  tests_unit __> ops_guardias
```

## Aristas completas

| Desde | Hacia | Refs |
|---|---|---|
| scripts | packages/adapter-sdk | 149 |
| scripts | console | 138 |
| scripts | packages/store | 85 |
| packages/store | packages/protocol | 80 |
| scripts | services/gateway | 80 |
| scripts | ops/scripts | 68 |
| tests/unit | services/gateway | 57 |
| services/gateway | packages/store | 50 |
| scripts | tests/unit | 48 |
| packages/store | tests/helpers | 42 |
| services/gateway | packages/protocol | 39 |
| scripts | ops/tests | 36 |
| scripts | services/telegram-bridge | 33 |
| tests/gateway-hardening | services/gateway | 33 |
| tests/unit | ops/scripts | 31 |
| packages/adapter-sdk | packages/protocol | 30 |
| scripts | ops/pty-agent | 29 |
| scripts | services/terminal-relay | 25 |
| ops/tests | ops/scripts | 21 |
| console | packages/store | 19 |
| scripts | tests/gateway-hardening | 19 |
| scripts | packages/protocol | 17 |
| scripts | deploy/runtime | 16 |
| tests/unit | packages/store | 16 |
| tests/unit | packages/protocol | 13 |
| tests/unit | ops/observability | 13 |
| ops/scripts | ops | 12 |
| tests/gateway-hardening | packages/store | 11 |
| tests/unit | services/telegram-bridge | 11 |
| console | packages/protocol | 10 |
| services/telegram-bridge | packages/store | 10 |
| services/telegram-bridge | packages/protocol | 10 |
| tests/gateway-hardening | packages/protocol | 10 |
| tests/store-hardening | packages/store | 10 |
| ops/scripts | deploy | 9 |
| scripts | ops/guardias | 9 |
| scripts | tests/terminal-pty | 9 |
| services/dispatcher | packages/store | 9 |
| tests/store-hardening | tests/helpers | 9 |
| tests/store-hardening | services/gateway | 8 |
| tests/unit | packages/adapter-sdk | 8 |
| console | services/gateway | 7 |
| console | packages/adapter-sdk | 7 |
| (raiz) | scripts | 7 |
| scripts | tests/store-hardening | 7 |
| tests/e2e | services/gateway | 7 |
| ops/tests | ops | 6 |
| tests/unit | deploy | 6 |
| tests/unit | deploy/runtime | 6 |
| ops/tests | ops/harness | 5 |
| (raiz) | ops/scripts | 5 |
| scripts | services/dispatcher | 5 |
| tests/gateway-hardening | tests/helpers | 5 |
| tests/store-hardening | packages/protocol | 5 |
| ops/scripts | services/telegram-bridge | 4 |
| ops/tests | deploy/runtime | 4 |
| ops/tests | services/gateway | 4 |
| scripts | deploy | 4 |
| scripts | ops/harness | 4 |
| scripts | packages/mcp-fleet-monitor | 4 |
| tests/integration | tests/helpers | 4 |
| tests/terminal-pty | services/terminal-relay | 4 |
| tests/unit | services/dispatcher | 4 |
| tests/unit | scripts | 4 |
| deploy | ops/observability | 3 |
| deploy/runtime | packages/store | 3 |
| ops/tests | tests/e2e | 3 |
| packages/mcp-fleet-monitor | packages/store | 3 |
| scripts | tests/integration | 3 |
| tests/e2e | tests/helpers | 3 |
| tests/unit | ops/schemas | 3 |
| ops/scripts | packages/adapter-sdk | 2 |
| ops/scripts | packages/protocol | 2 |
| ops/scripts | console | 2 |
| ops/scripts | ops/observability | 2 |
| ops/tests | tests/helpers | 2 |
| ops/tests | ops/schemas | 2 |
| ops/tests | packages/store | 2 |
| (raiz) | ops/harness | 2 |
| (raiz) | ops/tests | 2 |
| (raiz) | services/gateway | 2 |
| (raiz) | packages/store | 2 |
| (raiz) | console | 2 |
| packages/store | deploy | 2 |
| packages/store | packages/adapter-sdk | 2 |
| scripts | ops/container-runtime | 2 |
| scripts | ops/patches | 2 |
| scripts | tests/e2e | 2 |
| services/dispatcher | tests/helpers | 2 |
| services/gateway | tests/helpers | 2 |
| services/telegram-bridge | tests/helpers | 2 |
| tests/e2e | ops/harness | 2 |
| tests/integration | packages/store | 2 |
| tests/integration | services/gateway | 2 |
| tests/store-hardening | ops/scripts | 2 |
| tests/terminal-pty | services/gateway | 2 |
| tests/unit | ops/guardias | 2 |
| console | scripts | 1 |
| deploy/runtime | packages/protocol | 1 |
| deploy/runtime | packages/adapter-sdk | 1 |
| deploy/runtime | services/gateway | 1 |
| deploy/runtime | services/dispatcher | 1 |
| deploy/runtime | services/telegram-bridge | 1 |
| deploy/runtime | services/terminal-relay | 1 |
| ops | ops/harness | 1 |
| ops/pty-agent | services/gateway | 1 |
| ops/pty-agent | ops/scripts | 1 |
| ops/scripts | ops/pty-agent | 1 |
| ops/scripts | services/gateway | 1 |
| ops/scripts | tests/gateway-hardening | 1 |
| ops/scripts | ops/harness | 1 |
| ops/scripts | ops/schemas | 1 |
| ops/tests | ops/container-runtime | 1 |
| ops/tests | ops/guardias | 1 |
| ops/tests | ops/manifests | 1 |
| ops/tests | ops/observability | 1 |
| ops/tests | services/dispatcher | 1 |
| ops/tests | services/telegram-bridge | 1 |
| ops/tests | services/terminal-relay | 1 |
| ops/tests | packages/protocol | 1 |
| ops/tests | packages/adapter-sdk | 1 |
| (raiz) | deploy | 1 |
| (raiz) | services/dispatcher | 1 |
| (raiz) | services/telegram-bridge | 1 |
| packages/adapter-sdk | packages/store | 1 |
| packages/mcp-fleet-monitor | tests/integration | 1 |
| packages/mcp-fleet-monitor | packages/protocol | 1 |
| packages/store | services/telegram-bridge | 1 |
| packages/store | deploy/runtime | 1 |
| scripts | deploy/postgres | 1 |
| scripts | ops/openclaw-gateway | 1 |
| scripts | tests/helpers | 1 |
| services/dispatcher | deploy | 1 |
| services/terminal-relay | packages/protocol | 1 |
| services/terminal-relay | tests/terminal-pty | 1 |
| tests/e2e | packages/adapter-sdk | 1 |
| tests/e2e | services/dispatcher | 1 |
| tests/e2e | ops/scripts | 1 |
| tests/gateway-hardening | tests/store-hardening | 1 |
| tests/gateway-hardening | deploy | 1 |
| tests/gateway-hardening | packages/adapter-sdk | 1 |
| tests/helpers | packages/store | 1 |
| tests/integration | packages/adapter-sdk | 1 |
| tests/integration | packages/protocol | 1 |
| tests/store-hardening | services/telegram-bridge | 1 |
| tests/store-hardening | tests/gateway-hardening | 1 |
| tests/terminal-pty | ops/pty-agent | 1 |
| tests/unit | tests/helpers | 1 |
| tests/unit | deploy/console | 1 |
| tests/unit | tests/terminal-pty | 1 |
| tests/unit | ops/pty-agent | 1 |
| tests/unit | ops/harness | 1 |
| tests/unit | tests/e2e | 1 |
| tests/unit | console | 1 |
| (raiz) | packages/protocol | 1 |
| (raiz) | packages/adapter-sdk | 1 |

## Hubs (los 15 ficheros más referenciados)

- packages/protocol/src/index.ts ← 193
- packages/store/src/index.ts ← 152
- console/src/api/types.ts ← 125
- packages/adapter-sdk/src/sdk/types.ts ← 92
- tests/helpers/postgres.ts ← 73
- console/src/mocks/server.ts ← 62
- console/src/test/render.tsx ← 61
- services/gateway/src/auth.ts ← 61
- packages/store/src/db.ts ← 52
- console/src/components/ui.tsx ← 45
- console/src/lib.ts ← 43
- packages/adapter-sdk/src/sdk/durable-store.ts ← 43
- packages/adapter-sdk/src/harnesses/index.ts ← 33
- services/telegram-bridge/src/types.ts ← 32
- packages/store/test/helpers.ts ← 31

## Candidatos huérfanos (fuente sin UNA referencia entrante detectada — verificar antes de tocar)

- console/qa/layout-baseline.json
- console/src/features/terminal/terminal.worker.ts
- console/src/main.tsx
- grupos.json
- ops/flota-fisica.json
- ops/generated/fleet.json
- ops/guardias/catalogo-mouseion-health.sh
- ops/guardias/telegram-bridge.override.yaml
- ops/manifests/argos.yaml
- ops/manifests/atlas.yaml
- ops/manifests/gaia.yaml
- ops/manifests/hegel.yaml
- ops/manifests/heraclito.yaml
- ops/manifests/iza.yaml
- ops/manifests/janus.yaml
- ops/manifests/jarvis.yaml
- ops/manifests/kratos.yaml
- ops/manifests/salva.yaml
- ops/manifests/socrates.yaml
- ops/manifests/tales.yaml
- ops/manifests/zeus.yaml
- ops/schemas/alias-manifest.schema.json
- ops/scripts/fleet_derive.py
- ops/telegram-runtime/config.json
- packages/adapter-sdk/manifests/claude.json
- packages/adapter-sdk/manifests/codex.json
- packages/adapter-sdk/manifests/fake.json
- packages/adapter-sdk/manifests/hermes.json
- packages/adapter-sdk/manifests/openclaw.json
- packages/adapter-sdk/manifests/opencode.json
- packages/adapter-sdk/scripts/chmod-bins.mjs
- packages/adapter-sdk/scripts/copy-bridges.mjs
- packages/adapter-sdk/scripts/package-smoke.mjs
- pnpm-lock.yaml
- pnpm-workspace.yaml

## Tamaño por nodo

| Nodo | Ficheros |
|---|---|
| console | 325 |
| packages/adapter-sdk | 183 |
| packages/store | 110 |
| services/gateway | 102 |
| tests/unit | 77 |
| ops/scripts | 66 |
| services/telegram-bridge | 43 |
| ops/tests | 42 |
| services/terminal-relay | 35 |
| ops/pty-agent | 27 |
| packages/protocol | 22 |
| tests/gateway-hardening | 20 |
| deploy/runtime | 18 |
| ops/manifests | 14 |
| services/dispatcher | 12 |
| ops/guardias | 11 |
| tests/terminal-pty | 10 |
| tests/store-hardening | 9 |
| deploy | 8 |
| scripts | 8 |
| (raiz) | 7 |
| packages/mcp-fleet-monitor | 7 |
| ops | 5 |
| ops/harness | 5 |
| ops/observability | 4 |
| tests/integration | 4 |
| ops/patches | 2 |
| ops/schemas | 2 |
| tests/e2e | 2 |
| tests/helpers | 2 |
| deploy/console | 1 |
| deploy/postgres | 1 |
| ops/container-runtime | 1 |
| ops/generated | 1 |
| ops/openclaw-gateway | 1 |
| ops/telegram-runtime | 1 |
