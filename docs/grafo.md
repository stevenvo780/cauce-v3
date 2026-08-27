# Grafo de dependencias del repo

Generado por `pnpm grafo` (determinista — regenerar tras reordenar). Nodo = directorio; arista A→B = ficheros de A que referencian ficheros de B (peso = nº de referencias).

## El grafo (aristas con peso ≥2)

```mermaid
graph LR
  scripts __> apps_console
  scripts __> packages_adapter_sdk
  scripts __> packages_store
  scripts __> services_gateway
  scripts __> ops_scripts
  packages_store __> packages_protocol
  packages_store __> tests_helpers
  services_gateway __> packages_store
  scripts __> services_telegram_bridge
  tests_unit __> ops_scripts
  tests_gateway_hardening __> services_gateway
  scripts __> ops_pty_agent
  packages_adapter_sdk __> packages_protocol
  scripts __> services_terminal_relay
  scripts __> ops_tests
  services_gateway __> packages_protocol
  ops_tests __> ops_scripts
  scripts __> deploy
  scripts __> tests_gateway_hardening
  apps_console __> packages_store
  scripts __> tests_unit
  ops_scripts __> deploy
  tests_unit __> deploy
  tests_unit __> ops_observability
  scripts __> packages_protocol
  scripts __> ops_guardias
  tests_unit __> packages_protocol
  services_telegram_bridge __> packages_store
  services_telegram_bridge __> packages_protocol
  tests_store_hardening __> packages_store
  apps_console __> packages_protocol
  apps_console __> services_gateway
  scripts __> tests_terminal_pty
  tests_gateway_hardening __> packages_protocol
  tests_store_hardening __> tests_helpers
  tests_gateway_hardening __> packages_store
  tests_store_hardening __> services_gateway
  tests_unit __> packages_adapter_sdk
  apps_console __> packages_adapter_sdk
  scripts __> tests_store_hardening
  scripts __> services_dispatcher
  services_dispatcher __> packages_store
  tests_e2e __> services_gateway
  ops_scripts __> ops
  _raiz_ __> scripts
  scripts __> ops_console_legibilidad
  ops_tests __> ops_harness
  _raiz_ __> ops_scripts
  tests_store_hardening __> packages_protocol
  ops_scripts __> services_telegram_bridge
  ops_tests __> deploy
  ops_tests __> services_gateway
  packages_store __> deploy
  scripts __> ops_harness
  scripts __> packages_mcp_fleet_monitor
  tests_terminal_pty __> services_terminal_relay
  tests_unit __> packages_store
  tests_unit __> scripts
  apps_console __> ops_console_legibilidad
  deploy __> ops_observability
  ops __> deploy
  ops_tests __> tests_e2e
  packages_mcp_fleet_monitor __> packages_store
  scripts __> tests_integration
  tests_e2e __> tests_helpers
  tests_gateway_hardening __> tests_helpers
  tests_unit __> ops_schemas
  deploy __> packages_store
  ops_console_legibilidad __> deploy
  ops_scripts __> packages_adapter_sdk
  ops_scripts __> apps_console
  ops_scripts __> ops_observability
  ops_tests __> tests_helpers
  ops_tests __> ops_schemas
  ops_tests __> ops
  ops_tests __> packages_store
  _raiz_ __> ops_harness
  _raiz_ __> ops_tests
  _raiz_ __> services_gateway
  _raiz_ __> packages_store
  packages_store __> packages_adapter_sdk
  scripts __> ops_container_runtime
  scripts __> ops_patches
  scripts __> tests_e2e
  services_gateway __> apps_console
  services_gateway __> tests_helpers
  services_telegram_bridge __> tests_helpers
  tests_integration __> tests_helpers
  tests_integration __> packages_store
  tests_integration __> services_gateway
  tests_store_hardening __> ops_scripts
  tests_terminal_pty __> services_gateway
  tests_unit __> services_gateway
  tests_unit __> ops_guardias
```

## Aristas completas

| Desde | Hacia | Refs |
|---|---|---|
| scripts | apps/console | 136 |
| scripts | packages/adapter-sdk | 125 |
| scripts | packages/store | 73 |
| scripts | services/gateway | 70 |
| scripts | ops/scripts | 64 |
| packages/store | packages/protocol | 59 |
| packages/store | tests/helpers | 42 |
| services/gateway | packages/store | 40 |
| scripts | services/telegram-bridge | 33 |
| tests/unit | ops/scripts | 31 |
| tests/gateway-hardening | services/gateway | 27 |
| scripts | ops/pty-agent | 26 |
| packages/adapter-sdk | packages/protocol | 25 |
| scripts | services/terminal-relay | 25 |
| scripts | ops/tests | 23 |
| services/gateway | packages/protocol | 23 |
| ops/tests | ops/scripts | 18 |
| scripts | deploy | 18 |
| scripts | tests/gateway-hardening | 17 |
| apps/console | packages/store | 16 |
| scripts | tests/unit | 15 |
| ops/scripts | deploy | 14 |
| tests/unit | deploy | 14 |
| tests/unit | ops/observability | 13 |
| scripts | packages/protocol | 11 |
| scripts | ops/guardias | 11 |
| tests/unit | packages/protocol | 11 |
| services/telegram-bridge | packages/store | 10 |
| services/telegram-bridge | packages/protocol | 10 |
| tests/store-hardening | packages/store | 10 |
| apps/console | packages/protocol | 9 |
| apps/console | services/gateway | 9 |
| scripts | tests/terminal-pty | 9 |
| tests/gateway-hardening | packages/protocol | 9 |
| tests/store-hardening | tests/helpers | 9 |
| tests/gateway-hardening | packages/store | 8 |
| tests/store-hardening | services/gateway | 8 |
| tests/unit | packages/adapter-sdk | 8 |
| apps/console | packages/adapter-sdk | 7 |
| scripts | tests/store-hardening | 7 |
| scripts | services/dispatcher | 7 |
| services/dispatcher | packages/store | 7 |
| tests/e2e | services/gateway | 7 |
| ops/scripts | ops | 6 |
| (raiz) | scripts | 6 |
| scripts | ops/console-legibilidad | 6 |
| ops/tests | ops/harness | 5 |
| (raiz) | ops/scripts | 5 |
| tests/store-hardening | packages/protocol | 5 |
| ops/scripts | services/telegram-bridge | 4 |
| ops/tests | deploy | 4 |
| ops/tests | services/gateway | 4 |
| packages/store | deploy | 4 |
| scripts | ops/harness | 4 |
| scripts | packages/mcp-fleet-monitor | 4 |
| tests/terminal-pty | services/terminal-relay | 4 |
| tests/unit | packages/store | 4 |
| tests/unit | scripts | 4 |
| apps/console | ops/console-legibilidad | 3 |
| deploy | ops/observability | 3 |
| ops | deploy | 3 |
| ops/tests | tests/e2e | 3 |
| packages/mcp-fleet-monitor | packages/store | 3 |
| scripts | tests/integration | 3 |
| tests/e2e | tests/helpers | 3 |
| tests/gateway-hardening | tests/helpers | 3 |
| tests/unit | ops/schemas | 3 |
| deploy | packages/store | 2 |
| ops/console-legibilidad | deploy | 2 |
| ops/scripts | packages/adapter-sdk | 2 |
| ops/scripts | apps/console | 2 |
| ops/scripts | ops/observability | 2 |
| ops/tests | tests/helpers | 2 |
| ops/tests | ops/schemas | 2 |
| ops/tests | ops | 2 |
| ops/tests | packages/store | 2 |
| (raiz) | ops/harness | 2 |
| (raiz) | ops/tests | 2 |
| (raiz) | services/gateway | 2 |
| (raiz) | packages/store | 2 |
| packages/store | packages/adapter-sdk | 2 |
| scripts | ops/container-runtime | 2 |
| scripts | ops/patches | 2 |
| scripts | tests/e2e | 2 |
| services/gateway | apps/console | 2 |
| services/gateway | tests/helpers | 2 |
| services/telegram-bridge | tests/helpers | 2 |
| tests/integration | tests/helpers | 2 |
| tests/integration | packages/store | 2 |
| tests/integration | services/gateway | 2 |
| tests/store-hardening | ops/scripts | 2 |
| tests/terminal-pty | services/gateway | 2 |
| tests/unit | services/gateway | 2 |
| tests/unit | ops/guardias | 2 |
| apps/console | deploy | 1 |
| apps/console | ops/pty-agent | 1 |
| deploy | packages/protocol | 1 |
| deploy | packages/adapter-sdk | 1 |
| deploy | services/gateway | 1 |
| deploy | services/dispatcher | 1 |
| deploy | services/telegram-bridge | 1 |
| deploy | services/terminal-relay | 1 |
| ops | ops/harness | 1 |
| ops/console-legibilidad | apps/console | 1 |
| ops/guardias | ops/scripts | 1 |
| ops/pty-agent | services/gateway | 1 |
| ops/scripts | ops/pty-agent | 1 |
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
| packages/store | services/gateway | 1 |
| packages/store | services/telegram-bridge | 1 |
| scripts | ops/openclaw-gateway | 1 |
| scripts | tests/helpers | 1 |
| services/dispatcher | deploy | 1 |
| services/terminal-relay | tests/terminal-pty | 1 |
| tests/e2e | packages/adapter-sdk | 1 |
| tests/e2e | services/dispatcher | 1 |
| tests/e2e | ops/scripts | 1 |
| tests/e2e | ops/harness | 1 |
| tests/gateway-hardening | tests/store-hardening | 1 |
| tests/gateway-hardening | deploy | 1 |
| tests/helpers | packages/store | 1 |
| tests/integration | packages/adapter-sdk | 1 |
| tests/integration | packages/protocol | 1 |
| tests/integration | services/dispatcher | 1 |
| tests/store-hardening | services/telegram-bridge | 1 |
| tests/store-hardening | tests/gateway-hardening | 1 |
| tests/terminal-pty | ops/pty-agent | 1 |
| tests/unit | services/telegram-bridge | 1 |
| tests/unit | tests/helpers | 1 |
| tests/unit | services/dispatcher | 1 |
| tests/unit | ops/harness | 1 |
| tests/unit | tests/e2e | 1 |
| tests/unit | apps/console | 1 |
| (raiz) | packages/protocol | 1 |
| (raiz) | packages/adapter-sdk | 1 |

## Hubs (los 15 ficheros más referenciados)

- packages/protocol/src/index.ts ← 146
- packages/store/src/index.ts ← 125
- apps/console/src/api/types.ts ← 120
- packages/adapter-sdk/src/sdk/types.ts ← 73
- tests/helpers/postgres.ts ← 67
- apps/console/src/components/ui.tsx ← 47
- apps/console/src/mocks/server.ts ← 43
- apps/console/src/test/render.tsx ← 41
- apps/console/src/lib.ts ← 41
- services/gateway/src/auth.ts ← 41
- packages/store/src/db.ts ← 39
- packages/adapter-sdk/src/sdk/durable-store.ts ← 33
- services/telegram-bridge/src/types.ts ← 32
- apps/console/src/api/context.tsx ← 30
- apps/console/src/api/use-resource.ts ← 28

## Candidatos huérfanos (fuente sin UNA referencia entrante detectada — verificar antes de tocar)

- apps/console/src/features/terminal/terminal.worker.ts
- apps/console/src/features/topology/HyperGraph.tsx
- apps/console/src/main.tsx
- ops/guardias/telegram-bridge.override.yaml
- ops/manifests/argos.yaml
- ops/manifests/atlas.yaml
- ops/manifests/dedalo.yaml
- ops/manifests/hegel.yaml
- ops/manifests/iza.yaml
- ops/manifests/janus.yaml
- ops/manifests/jarvis.yaml
- ops/manifests/kratos.yaml
- ops/manifests/midas.yaml
- ops/manifests/salva.yaml
- ops/manifests/seneca.yaml
- ops/manifests/socrates.yaml
- ops/manifests/vulcano.yaml
- ops/manifests/zeus.yaml
- ops/schemas/alias-manifest.schema.json
- ops/schemas/dlq-no-replay-resolution-request.schema.json
- ops/schemas/dlq-safe-list.schema.json
- ops/schemas/telegram-manual-replay-request.schema.json
- ops/schemas/telegram-replay-inspect-request.schema.json
- ops/schemas/telegram-replay-inspect.schema.json
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
| apps/console | 285 |
| packages/adapter-sdk | 146 |
| packages/store | 86 |
| services/gateway | 76 |
| ops/scripts | 60 |
| services/telegram-bridge | 41 |
| tests/unit | 40 |
| services/terminal-relay | 34 |
| deploy | 26 |
| ops/tests | 26 |
| ops/pty-agent | 22 |
| tests/gateway-hardening | 18 |
| ops/manifests | 15 |
| packages/protocol | 13 |
| services/dispatcher | 11 |
| ops/guardias | 10 |
| tests/terminal-pty | 10 |
| tests/store-hardening | 9 |
| ops/schemas | 7 |
| packages/mcp-fleet-monitor | 7 |
| scripts | 7 |
| ops/console-legibilidad | 6 |
| (raiz) | 6 |
| ops/harness | 4 |
| ops/observability | 4 |
| tests/integration | 4 |
| ops | 3 |
| ops/patches | 2 |
| tests/e2e | 2 |
| .github | 1 |
| ops/container-runtime | 1 |
| ops/openclaw-gateway | 1 |
| tests/helpers | 1 |
