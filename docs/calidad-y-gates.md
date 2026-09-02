# Calidad y gates

> Véase también: [AGENTS.md](../AGENTS.md) · [arquitectura.md §6](arquitectura.md)

## Filosofía

El proyecto emplea un sistema **ratchet**: los números de calidad solo pueden mejorar, nunca retroceder. Las listas de excepciones congeladas registran la deuda técnica actual y solo pueden reducirse.

Cuando un número tiene que subir —a veces tiene que subir— no se sube de tapadillo: se nombra.
`pnpm qa:layout` es el único gate con una vía explícita para eso (`--allow-regression`, abajo), y
está hecha para incomodar. Los demás solo aceptan bajadas.

## Jerarquía de gates

Todo commit que toque código **debe pasar el gate antes de hacer commit**. Commits que solo tocan archivos `.md` están exentos.

| Comando | Qué ejecuta | Cuándo |
|---|---|---|
| `pnpm typecheck` | TypeScript strict (core, adapter, mcp, console) | Cada commit |
| `pnpm lint` | ESLint por zona + `lint:estricto:zonas` (console, terminal-relay, telegram-bridge, dispatcher, tests) + `ruff check` (Python) + ratchet `scripts/calidad.mjs` | Cada commit |
| `pnpm lint:cycles` | AST de imports/reexportaciones runtime, incluidas entradas del workspace; baseline cero de ciclos | Dentro de `pnpm lint` |
| `pnpm test:unit` | Gate rápido: protocol, adapter-sdk, mcp, console, `tests/unit` | Cada commit |
| `pnpm test:core` | Escalón de Postgres: preflight de la base + `test:services` + `test:gateway-hardening` | Cada commit que toque `services/**` |
| `pnpm test` (`scripts/test-all.mjs`) | Gate completo: orquesta 11 suites secuenciales, cuenta tests ejecutados y saltados por suite, y verifica que ningún guion `test:*`/`qa:*`/`coverage:*` quede huérfano | Gate completo |
| `pnpm test:ops` | Descubre y ejecuta en serie las 31 pruebas directas de `ops/tests`; no abandona al primer rojo | Al tocar ops |
| `ops/scripts/validate.sh` | Sintaxis de `.sh`/`.mjs` en ops+deploy, ShellCheck obligatorio, YAML/JSON Schema de manifiestos, paridad byte-a-byte G-SNAP | Al tocar fleet/ops |
| `pnpm qa:layout` (`console/qa/layout-gate.mjs`) | Regresión de maquetado en Chromium a 360/760/1100/1440/1920/2560 px — desperdicio horizontal, accesibilidad de la nav, desperdicio vertical y objetivos de pliegue por ruta (abajo) | Al tocar console |
| `pnpm arch:validate` / `pnpm arch:visual-check` | Valida la especificación Archify fijada y revisa el mapa navegable en temas y viewports múltiples | Al cambiar límites o dependencias |
| `pnpm arch:refresh` | Sella la revisión fijada del mapa con el `HEAD` actual y re-renderiza el HTML | Al commitear un cambio en alguna ruta citada como fuente por un componente del mapa |

## `test:core`: el escalón de Postgres por commit

Entre `pnpm test:unit` (segundos, sin base) y `pnpm test` (la matriz entera) faltaba un peldaño: las
zonas que sólo cubren las suites con base de datos se editaban a ciegas. `pnpm test:core` es ese
peldaño y cuesta **51 s medidos de reloj** —≈35 s de `test:services` y ≈16 s de
`test:gateway-hardening`, 1300 tests entre los dos—, que es lo que puede pagar un commit sin
dejar de commitear seguido.

Cubre exactamente las zonas flojas del árbol: `terminal-relay`, `telegram-bridge` y el `gateway`.
Empieza por `node scripts/preflight-postgres.mjs`, que falla en cerrado **antes** de que ninguna
suite abra un pool: sin `CAUCE_TEST_DATABASE_URL`, con una base cuyo nombre no empieza por
`cauce_test`, con el clúster parado o con una base que no existe (lo comprueba con una conexión real
por `psql`; sin `psql` sólo dice que el servidor responde), imprime dos líneas en español que dicen
qué falta y cómo arrancarlo (`sudo pg_ctlcluster 16 main start`, procedimiento en
[entorno-de-desarrollo-con-base-real.md](entorno-de-desarrollo-con-base-real.md)). Sin ese preflight
el operador recibía una pila de conexión de `pg` dentro de una suite en rojo.

Dos cosas hay que decirlas en voz alta:

- **Su verde no sustituye al gate de release.** `test:core` corre por la ruta de la base externa
  (`CAUCE_TEST_DATABASE_URL`), y esa ruta es justamente la que `CAUCE_REQUIRE_TESTCONTAINERS=1`
  **rechaza** (`tests/helpers/postgres.ts:438`). El gate de release aprovisiona con Testcontainers;
  son dos caminos distintos y el verde de uno no acredita al otro.
- **`packages/store/test` se queda fuera por coste**: 277 s medidos, casi cinco minutos metidos en
  casi cualquier commit de código, contra la regla de commits inmediatos de `AGENTS.md`. Quien
  cierra esa ventana es el nocturno `cauce-v3-ci-local.timer`, que corre la matriz completa.

`test:core` vive en `SEPARATELY_GATED` de `scripts/test-all.mjs`, no en `SUITES`: sus dos mitades ya
están en la matriz y meterlo dentro las correría dos veces en cada `pnpm test`.

## Matriz honesta: ejecutados, saltados y el veredicto `VACIA`

Una suite que salta todos sus ficheros salía `PASS` y nadie lo veía. Ahora `scripts/test-all.mjs`
lee la salida de cada suite mientras pasa —la re-emite entera, el nocturno la sigue leyendo del
journal— y cuenta los resúmenes de vitest y de `node --test`:

```
PASS     test:gateway-hardening    15.7s  (137 ejecutados, 0 saltados)
VACIA    test:store-hardening       3.1s  (0 ejecutados, 214 saltados)
PASS     test:ops                  22.4s  (conteo no disponible)
```

- **`VACIA`**: la suite terminó en verde sin ejecutar ni un test. Se imprime como veredicto propio,
  no como `PASS`. Con `CAUCE_REQUIRE_TESTCONTAINERS=1` exportado —la corrida que afirma
  aprovisionar todo lo que necesita— una suite `VACIA` pone la corrida entera en rojo; sin esa
  variable se anota y no falla, porque saltar por capacidad ausente es legítimo en un portátil.
- **`(conteo no disponible)`**: `test:pty` (unittest de Python) y `test:ops` (runner propio) no
  imprimen un resumen que este script sepa leer, y fingir que se parsea lo que no se parsea sería
  peor que no contar.

`scripts/test-all.mjs` también comprueba que cada `--filter` de un guion `test:*`/`qa:*`/`coverage:*`
nombre a un paquete que existe. `--fail-if-no-match` no cierra ese agujero: con varios filtros pnpm
sale 0 si al menos uno casa, así que un paquete renombrado dejaba de correrse con el gate en verde.

## Ratchet (`scripts/calidad.mjs`)

Ratchet determinista controlado por `scripts/calidad-base.json`:

| Métrica | Umbral / comportamiento |
|---|---|
| **Líneas por archivo** | Máximo 800. Archivos por encima quedan congelados en la lista de excepciones (solo puede decrecer). |
| **Fechas en comentarios** | Detecta patrones de fecha — excepciones congeladas solo se reducen. |
| **Densidad de comentarios** | Medida por archivo — solo puede disminuir. |

Las excepciones congeladas viven en `scripts/calidad-base.json` y el gate imprime sus tres conteos
en cada corrida; aquí no se fija un número que envejece con cada tramo. Los valores existentes solo
pueden bajar o conservarse; `--update` recoge una poda revisada de la línea base y las ampliaciones
fallan.

## Gate de maquetado (`pnpm qa:layout`)

Los tests unitarios de la consola corren en jsdom, que no aplica CSS ni calcula geometría, y las
guardas de hoja leen el CSS como **texto**: ninguna de las dos ve la caja renderizada. Este gate
levanta la consola con mocks y la recorre con Chromium de verdad: las diez rutas de `ROUTES` —`/`,
`/live`, `/accounts`, `/messages`, el hilo `/messages/<tenant>/<alias>`, `/queues`,
`/observability`, `/config`, `/terminal`, `/ayuda`— más los dos estados del cajón de `/live`, a
360/760/1100/1440/1920/2560 px sobre una ventana de 1000 px de alto.
Necesita Chromium, así que no forma parte de `pnpm test`: está declarado en `SEPARATELY_GATED` de
`scripts/test-all.mjs` y se corre aparte al tocar `console/`.

Vigila dos cosas distintas, con dos mecanismos distintos.

### Presupuestos: por viewport y por ruta

`console/qa/layout-baseline.json` registra dos capas. Para cada ancho, el **peor caso** de hueco
lateral, desborde, recorte, recorte fuera del alcance del teclado, enlaces de nav sin nombre,
rótulos solapados, portadores pequeños y pantallas de scroll, con la ruta y el selector culpables.
Y, dentro de cada ancho, los mismos números **ruta a ruta**: `pantallas`, `foldDesaprovechado`,
`objetoPrincipalTop` y `objetoPrincipalBajoElPliegue`. Las dos capas hacen de trinquete: el peor
caso por viewport esconde una ruta que empeora detrás de otra que mejora, y no puede ver una ruta
que pierde su objeto principal.

Cada presupuesto tiene su tolerancia de ruido. La de `pantallasMaximas` va en proporción (0,1 de
pantalla) y no en píxeles, porque una tolerancia en píxeles dejaría pasar una vista que crece de una
pantalla a tres; las de ruta son más flojas a propósito (0,2 pantallas, 64 px en
`objetoPrincipalTop`) porque el reloj de los mocks envejece la columna de tiempos entre corridas.

`foldDesaprovechado` es la banda muerta **bajo** el contenido —la que el hueco lateral nunca vio—,
medida hasta lo último realmente pintado dentro de `main`: un `<details>` plegado sigue reportando
caja para lo que oculta, así que solo cuenta lo visible. `objetoPrincipalTop` y
`objetoPrincipalBajoElPliegue` miden el elemento que la vista marca con `data-objeto-principal`; una
ruta que tenía objeto principal en la línea base y aparece sin él sale en rojo, porque su medida
pasa a ser nula y no cero.

### Objetivos de v3.1

Un peor caso por viewport no sabe expresar un criterio de aceptación por ruta, así que `OBJETIVOS`
los declara aparte, en el propio gate:

| Objetivo | Dónde | Tope |
|---|---|---|
| `pantallas` | `/live`, `/accounts` y los dos estados del cajón, a 1440/1920/2560 | ≤ 2 pantallas de scroll |
| `foldDesaprovechado` | `/` en los seis anchos | ≤ 400 px de banda muerta |
| `objetoPrincipalBajoElPliegue` | `/live`, el hilo de `/messages` y `/terminal` | 0: el objeto principal empieza sobre el pliegue |

`PENDIENTES` lista lo que hoy no llega, con el valor medido cuando se registró. De ahí salen cuatro
rojos y ninguno es opinable:

- un incumplimiento que **no** está en `PENDIENTES` — regresión nueva;
- una entrada de `PENDIENTES` que empeora más allá de su margen;
- una entrada que **ya cumple** el objetivo — roja hasta que se borre, para que la deuda saldada no
  siga reservada;
- una ruta que el objetivo nombra y no declara `data-objeto-principal` — sin objeto la medida vale
  cero por falta de qué medir, y ese cero se leería como aprobado.

### Subir un valor registrado

`pnpm qa:layout:update` lee primero la línea base y **se niega** a subir ningún presupuesto:
imprime cada rechazo, conserva el valor registrado y termina en rojo, porque el fichero que acaba de
escribir ya no describe esa corrida. La única vía sancionada es nombrar lo que sube:

```bash
node console/qa/layout-gate.mjs --update --allow-regression=1920.recorteMaximo
```

La clave es `<viewport>.<presupuesto>` para el peor caso y `<viewport>.<ruta>.<presupuesto>` para
una medida de ruta, y admite lista separada por comas. Es deliberadamente incómodo: `--update`
reescribía antes todos los viewports de golpe, así que una regresión entraba de polizón junto a una
mejora y se convertía en el suelo nuevo. Una mejora también obliga a actualizar: el gate falla si el
número mejoró y la línea base sigue tolerando el valor viejo.

## Suites de test (11 suites en `scripts/test-all.mjs`)

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

### Trinquete de cobertura (`pnpm coverage:ratchet`)

`node scripts/cobertura.mjs --trinquete` compara el porcentaje de **líneas por paquete** contra
`scripts/cobertura-base.json` y sale 1 si alguno cae más de 0,20 puntos, si un dominio no se pudo
medir, o si un paquete declarado no tiene cifra. Vuelve a correr la matriz entera bajo
instrumentación, así que —igual que `pnpm test:coverage`— vive en `SEPARATELY_GATED` y **no** es un
gate por commit: lo corren el nocturno y el cierre de versión.

| Guion | Qué hace |
|---|---|
| `pnpm coverage:ratchet` | Exige la base: sólo puede subir, nunca bajar |
| `pnpm coverage:seed` | **Re-siembra** la base con lo medido, incluso a la baja |

`{"lineas_pct": null, "pendiente_de_siembra": true}` es el marcador de un paquete que aún no tiene
cifra: entra en la base **sólo por siembra**, y mientras esté marcado el trinquete sale en rojo a
propósito. No es una excepción tolerada, es una deuda con nombre.

**Ritual de cierre.** La re-siembra es el único camino sancionado para que un número baje, y por eso
se hace a la vista:

1. Poner el árbol **verde de verdad** —`pnpm test` completo, sin suites `VACIA`—, porque una suite
   que no corrió baja la cobertura sin que nadie haya tocado el código.
2. `pnpm coverage:seed`. Escribe lo medido tal cual, retira las claves rancias y **nombra en
   `stderr` cada bajada que escribe**; un dominio que no se midió no congela cifra: conserva la
   anterior o queda pendiente de siembra, y la corrida sale 1.
3. Leer esa lista de bajadas antes de commitear la base. Si hay una que no se sabe explicar, la base
   no se commitea.
4. `pnpm coverage:ratchet` en verde: a partir de ahí ese es el suelo nuevo.

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
