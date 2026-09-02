# Calidad y gates

> Véase también: [AGENTS.md](../AGENTS.md) · [arquitectura.md §6](arquitectura.md)

## Filosofía

El proyecto emplea un sistema **ratchet**: los números de calidad solo pueden mejorar, nunca retroceder. Las listas de excepciones congeladas registran la deuda técnica actual y solo pueden reducirse.

## Jerarquía de gates

Todo commit que toque código **debe pasar el gate antes de hacer commit**. Commits que solo tocan archivos `.md` están exentos.

| Comando | Qué ejecuta | Cuándo |
|---|---|---|
| `pnpm typecheck` | TypeScript strict (core, adapter, mcp, console) | Cada commit |
| `pnpm lint` | ESLint por zona + `lint:estricto:zonas` (console, terminal-relay, telegram-bridge, dispatcher, tests) + `ruff check` (Python) + ratchet `scripts/calidad.mjs` | Cada commit |
| `pnpm lint:cycles` | AST de imports/reexportaciones runtime, incluidas entradas del workspace; baseline cero de ciclos | Dentro de `pnpm lint` |
| `pnpm test:unit` | Gate rápido: protocol, adapter-sdk, mcp, console, `tests/unit` | Cada commit |
| `pnpm test` (`scripts/test-all.mjs`) | Gate completo: orquesta 9 suites secuenciales, verifica que no haya scripts `test:*` huérfanos | Gate completo |
| `pnpm test:ops` | Descubre y ejecuta en serie las 31 pruebas directas de `ops/tests`; no abandona al primer rojo | Al tocar ops |
| `ops/scripts/validate.sh` | Sintaxis de `.sh`/`.mjs` en ops+deploy, ShellCheck obligatorio, YAML/JSON Schema de manifiestos, paridad byte-a-byte G-SNAP | Al tocar fleet/ops |
| `pnpm qa:layout` (`qa/layout-gate.mjs`) | Regresión visual en Chromium a 360/760/1100/1440/1920/2560 px — mide ancho útil, espacio muerto, overflow, scroll, enlaces sin nombre, etiquetas superpuestas | Al tocar console |
| `pnpm arch:validate` / `pnpm arch:visual-check` | Valida la especificación Archify fijada y revisa el mapa navegable en temas y viewports múltiples | Al cambiar límites o dependencias |
| `pnpm arch:refresh` | Sella la revisión fijada del mapa con el `HEAD` actual y re-renderiza el HTML | Al commitear un cambio en alguna ruta citada como fuente por un componente del mapa |

## Ratchet (`scripts/calidad.mjs`)

Ratchet determinista controlado por `scripts/calidad-base.json`:

| Métrica | Umbral / comportamiento |
|---|---|
| **Líneas por archivo** | Máximo 800. Archivos por encima quedan congelados en la lista de excepciones (solo puede decrecer). |
| **Fechas en comentarios** | Detecta patrones de fecha — excepciones congeladas solo se reducen. |
| **Densidad de comentarios** | Medida por archivo — solo puede disminuir. |

Excepciones congeladas actuales: **21** archivos en `lineas`, **11** en `fechas`, **922** entradas acotadas en `comentarios`. Los valores existentes solo pueden bajar o conservarse; `--update` recoge una poda revisada de la línea base y las ampliaciones fallan.

## Suites de test (9 suites en `scripts/test-all.mjs`)

| Suite | Directorio | Qué valida |
|---|---|---|
| Unit | `tests/unit/` (80) | Políticas Docker, probes liveness/readiness, parseo de perfil de agente, cierre source-digest, contratos canary/gate |
| Operación | `ops/tests/` (31) | Generadores, CLI, supervisor, cutover, watchdog, permisos y evidencia operacional con fixtures herméticos |
| Gateway hardening | `tests/gateway-hardening/` (19) | mTLS, admisión de entrega, correlación WS, reintentos de publish receipt, seguridad |
| Store hardening | `tests/store-hardening/` (9) | PostgreSQL real / Testcontainers: locks, config OCC, migration ledger, admisión terminal, selección de cuentas |
| Integration | `tests/integration/` (4) | End-to-end vertical con PostgreSQL y observabilidad |
| E2E | `tests/e2e/` (3) | Login de console, QA real y fixture de fan-out concurrente entre adapters |
| Terminal PTY | `tests/terminal-pty/` (5) | Protocolo binario PTY, doubles de relay, fixtures vectoriales |
| Package tests | `packages/*/test/` | Por paquete: protocol (unit), store (DB), adapter-sdk (`node:test`), mcp-fleet-monitor |
| Service tests | `services/*/` | gateway, dispatcher, telegram-bridge, terminal-relay |

## Cobertura (`pnpm test:coverage` → `scripts/cobertura.mjs`)

**Un solo comando, una sola cifra.** No es un gate por commit: cuesta lo que cuesta `pnpm test`
más la instrumentación, así que vive en `SEPARATELY_GATED` de `scripts/test-all.mjs` y se corre
bajo demanda.

Tres dominios de medición, porque son tres ejecutores que no caben en un proceso, y **una sola
corrida por dominio**:

| Dominio | Qué mide | Cómo |
|---|---|---|
| raíz | `packages/**` + `services/**` | vitest (node), las 13 rutas de suite en UNA invocación |
| consola | `console/src/**` | vitest propio de `console/` (jsdom + plugin react) |
| adapter-sdk | `packages/adapter-sdk/src/**` | `node --test` sobre `dist`, remapeado por source maps |

Raíz y consola cubren ficheros disjuntos, así que sus totales se suman sin fusionar mapas.
adapter-sdk va **declarado aparte**: sus 689 tests corren con `node --test` y ninguna corrida de
vitest los ve, así que instrumentado por vitest sale al 2-4 % cuando por su método está al 90,7 %.

### Por qué no se mide por zonas

Porque ya se midió así y mintió. Con sólo las suites por paquete,
`services/gateway/src/routes/core.ts` sale al **9,3 %**; con `tests/gateway-hardening`, que es
quien lo cubre, está al **79,4 %**. Una tabla zona→suites no la vigila nadie y vuelve a mentir en
cuanto una suite se mueve.

Y no se puede medir por zonas y sumar: con el provider v8, los mapas de sentencia de un fichero
coinciden entre corridas (0 desajustes medidos sobre cuatro), pero los de rama y función no
(1294 y 9036), porque se construyen con lo que realmente se ejecutó. Sumar zonas sólo puede dar
líneas, nunca ramas.

### Dos trampas de la herramienta, ya cerradas en el script

- **`coverage.reportOnFailure` de vitest vale `false` por defecto.** Con un solo test rojo la
  corrida entera no escribe informe: el repositorio se queda sin número al primer rojo.
- **`--test-coverage-include` de node se aplica dos veces**, al fichero en disco y a la ruta del
  source map. Con uno solo de los dos patrones la tabla sale vacía e informa `all files 100.00`,
  que se lee como nota perfecta y no como medición que no ocurrió.

El orquestador borra los `dist` relevantes antes de compilar y falla con código distinto de cero si
un build, una suite o un informe falla. Puede imprimir una tabla parcial para diagnóstico, pero esa
tabla nunca acredita un gate verde.

## Mensajería adversarial y OpenCode

El round-trip de adapters del QA real cubre fan-out de dos ramas que deben solaparse, duplicado
idempotente, conflicto por duplicado mutado y una delegación negativa hacia un agente en línea de
otro tenant que no aparece en `routing_targets` ni recibe entrega. `pnpm qa:opencode-cli` acredita
solo instalación y superficie de comandos de un OpenCode real (`--version` y `run --help`) dentro de
un HOME aislado: no hereda credenciales, no autentica, no invoca modelos y no ejecuta prompts.

## G-SNAP (paridad de snapshots generados)

`ops/scripts/validate.sh` regenera `container-aliases.json` y `manifests/` desde `ops/flota.json` en un directorio temporal y exige coincidencia byte-a-byte con lo que está commiteado — gate contra edición manual de archivos generados.

## Dominios de source digest (`ops/scripts/source-digest.py`)

| Dominio | Cubre | Respalda |
|---|---|---|
| `runtime` | Manifiestos raíz + `packages/` + `services/` + `deploy/` | Identidad de fuente runtime para Testcontainers |
| `console` | Manifiestos raíz + `console/` + `deploy/` | Identidad de fuente de imagen console |
| `testcontainers` | E2E, helper, runner, schema, validator | Evidencia `harnessDigest` de Testcontainers |
| `verification` | Tests, orquestación, fuentes ops | Cierre global del gate |
| `full` | Unión de los cuatro anteriores | Fallback por defecto |
