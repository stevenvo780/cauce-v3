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
| `pnpm test:unit` | Gate rápido: protocol, adapter-sdk, mcp, console, `tests/unit` | Cada commit |
| `pnpm test` (`scripts/test-all.mjs`) | Gate completo: orquesta 8 suites secuenciales, verifica que no haya scripts `test:*` huérfanos | Gate completo |
| `ops/scripts/validate.sh` | Sintaxis de `.sh`/`.mjs` en ops+deploy, shellcheck, YAML/JSON Schema de manifiestos, paridad byte-a-byte G-SNAP | Al tocar fleet/ops |
| `pnpm qa:layout` (`qa/layout-gate.mjs`) | Regresión visual en Chromium a 360/760/1100/1440/1920/2560 px — mide ancho útil, espacio muerto, overflow, scroll, enlaces sin nombre, etiquetas superpuestas | Al tocar console |

## Ratchet (`scripts/calidad.mjs`)

Ratchet determinista controlado por `scripts/calidad-base.json`:

| Métrica | Umbral / comportamiento |
|---|---|
| **Líneas por archivo** | Máximo 800. Archivos por encima quedan congelados en la lista de excepciones (solo puede decrecer). |
| **Fechas en comentarios** | Detecta patrones de fecha — excepciones congeladas solo se reducen. |
| **Densidad de comentarios** | Medida por archivo — solo puede disminuir. |

Excepciones congeladas actuales: **21** archivos en `lineas`, **24** en `fechas`, **810** entradas acotadas en `comentarios`. Cuando un archivo mejora por debajo de su valor congelado, `calidad.mjs` falla exigiendo actualizar la línea base — las mejoras se bloquean permanentemente.

## Suites de test (8 suites en `scripts/test-all.mjs`)

| Suite | Directorio | Qué valida |
|---|---|---|
| Unit | `tests/unit/` (75) | Políticas Docker, probes liveness/readiness, parseo de perfil de agente, cierre source-digest, contratos canary/gate |
| Gateway hardening | `tests/gateway-hardening/` (19) | mTLS, admisión de entrega, correlación WS, reintentos de publish receipt, seguridad |
| Store hardening | `tests/store-hardening/` (9) | PostgreSQL real / Testcontainers: locks, config OCC, migration ledger, admisión terminal, selección de cuentas |
| Integration | `tests/integration/` (4) | End-to-end vertical con PostgreSQL y observabilidad |
| E2E | `tests/e2e/` (2) | Login de console, QA real |
| Terminal PTY | `tests/terminal-pty/` (5) | Protocolo binario PTY, doubles de relay, fixtures vectoriales |
| Package tests | `packages/*/test/` | Por paquete: protocol (unit), store (DB), adapter-sdk (689 node:test), mcp-fleet-monitor |
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
