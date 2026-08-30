# CODEX 3 · Gateway

## Commits

- Código y pruebas: `e0aedfa`
- Reporte: este fichero queda incluido en un segundo commit; su propio hash se informa en el
  handoff porque un commit no puede contener autorreferencialmente su hash.

## Gate literal

`pnpm typecheck 2>&1 | tail -3`

```text
$ tsc --noEmit
$ pnpm --filter @cauce/console typecheck
$ tsc -b --pretty false
```

`npx eslint -c eslint.estricto.config.js services/gateway/src --max-warnings 0`

Este comando no produjo salida y terminó con código 0.

`CAUCE_TEST_DATABASE_URL="postgresql://cauce@127.0.0.1:5432/cauce_test" pnpm --filter @cauce/gateway test 2>&1 | grep -E "Test Files|Tests |FAIL"`

```text
 Test Files  35 passed (35)
      Tests  595 passed (595)
```

`CAUCE_TEST_DATABASE_URL="postgresql://cauce@127.0.0.1:5432/cauce_test" npx vitest run tests/gateway-hardening --testTimeout=120000 2>&1 | grep -E "Test Files|Tests "`

```text
 Test Files  19 passed (19)
      Tests  120 passed (120)
```

`node scripts/calidad.mjs 2>&1 | tail -3`

```text
calidad: VERDE (1132 ficheros; trinquete: 21 >800, 11 con fechas, 901 con comentarios acotados)
```

## Los ocho ficheros supuestamente «sin test»

Antes de escribir pruebas ejecuté la suite completa del gateway con cobertura V8 sobre
`services/gateway/src/**/*.ts`. La suite de partida dio:

```text
Test Files  33 passed (33)
     Tests  570 passed (570)
Duration  23.00s
```

La búsqueda literal solicitada no produjo salida:

```text
rg -n "relay-probe|schema-profile-runtime|schema-terminal|schema-delivery|path-policy|schema-console-publish-intent|chain-gates-legado|routes/console/phase4|console/phase4" --glob '*.test.*' .
```

El resultado instrumental fue **0 de 8 realmente sin cubrir** y **8 de 8 cubiertos por suites que
no nombran el módulo**. La métrica «nadie lo menciona» no discriminó cobertura en esta muestra. Sí
sirvió como señal de profundidad: cuatro estaban cubiertos parcialmente y cuatro tenían una
cobertura fuerte, incluidos negativos contra PostgreSQL real.

| Fichero | Líneas iniciales | Funciones | Ramas | Vía indirecta y decisión |
|---|---:|---:|---:|---|
| `console/agent-documents/relay-probe.ts` | 56,84 % (162/285) | 75 % | 81,39 % | `agent-documents.read.test.ts`; faltaba escritura individual y por lote, añadidas. |
| `health/schema-profile-runtime.ts` | 93,33 % (28/30) | 100 % | 90,90 % | `health-progress.test.ts` y `health-schema-runtime.test.ts`, con negativos de literales y PostgreSQL real; no añadí una prueba redundante. |
| `health/schema-terminal.ts` | 100 % (65/65) | 100 % | 100 % | Mismas suites, con las tres sondas, permisos y deriva de constraints/índices; no añadí una prueba redundante. |
| `health/schema-delivery.ts` | 100 % (42/42) | 100 % | 100 % | Mismas suites, con admisión, wake y negativos estructurales/permisos; no añadí una prueba redundante. |
| `console/agent-documents/path-policy.ts` | 72,81 % (75/103) | 75 % | 81,48 % | `agent-documents.test.ts`; faltaba la ruta escribible medida, añadida con enlace y destino sensible. |
| `health/schema-console-publish-intent.ts` | 100 % (21/21) | 100 % | 100 % | `health-schema037.pg.test.ts`, con ledger, índice, definición, predicado y autoridad alterados; no añadí una prueba redundante. |
| `routes/chain-gates-legado.ts` | 53,33 % (32/60) | 100 % | 28,57 % | `buildGateway` desde `chain-gates-legado.test.ts`; añadí answer/cancel, métodos ausentes y permiso. |
| `routes/console/phase4.ts` | 83,58 % (56/67) | 100 % | 41,66 % | `buildGateway`; añadí capability disponible/ausente, revisiones inválidas y composición de observabilidad. |

La cobertura completa posterior pasó 35 ficheros y 595 pruebas. El efecto sobre los cuatro
objetivos parciales fue:

| Fichero | Líneas antes | Líneas después | Funciones después |
|---|---:|---:|---:|
| `relay-probe.ts` | 56,84 % | 82,80 % (236/285) | 100 % |
| `path-policy.ts` | 72,81 % | 92,23 % (95/103) | 100 % |
| `chain-gates-legado.ts` | 53,33 % | 95 % (57/60) | 100 % |
| `phase4.ts` | 83,58 % | 94,02 % (63/67) | 100 % |

Las pruebas nuevas usan nombres en español, valores exactos y controles negativos. PostgreSQL real
se mantuvo en los contratos `health/schema-*`; los dobles nuevos corresponden a la frontera HTTP del
terminal-relay o a repositorios inyectados, no a valores de base de datos sustituibles.

## Mutantes

Los tres cambios fueron temporales y se restauraron mediante el cambio inverso. Los SHA-256 de los
tres ficheros después de restaurar coincidieron exactamente con los guardados antes de mutar.

### `relay-probe.ts`

Mutación: `answer.path !== path` → `answer.path === path`.

```text
❯ src/console/agent-documents.write.test.ts (8 tests | 2 failed) 8ms
  × la escritura gobernada exige evidencia exacta del relay > acepta sólo el ACK que acredita ruta, operación, huella y bytes solicitados 5ms
  × la escritura gobernada exige evidencia exacta del relay > rechaza un ACK con ruta distinta de la solicitud 1ms
 Test Files  1 failed (1)
      Tests  2 failed | 6 passed (8)
MUTANT_EXIT=1
```

### `path-policy.ts`

Mutación: `resolved !== requested` → `resolved === requested`.

```text
❯ src/console/agent-documents.write.test.ts (8 tests | 3 failed) 8ms
  × el lote gobernado acredita cada fichero una sola vez > devuelve los dos ACK completos en el orden solicitado 3ms
  × el lote gobernado acredita cada fichero una sola vez > rechaza un lote cuyo ACK repite una ruta y omite otra 1ms
  × la ruta de perfil queda cerrada al destino medido > acepta el fichero exacto y rechaza enlaces aunque su nombre solicitado sea válido 1ms
 Test Files  1 failed (1)
      Tests  3 failed | 5 passed (8)
MUTANT_EXIT=1
```

### `routes/console/phase4.ts`

Mutación: `terminalCapability?.available === true` → `!== true`.

```text
❯ src/routes/console/phase4.test.ts (6 tests | 2 failed) 43ms
  × fase cuatro de la consola > publica la capacidad terminal exacta sólo después de autorizar control 32ms
  × fase cuatro de la consola > falla explícitamente cuando el backend terminal no está configurado 2ms
 Test Files  1 failed (1)
      Tests  2 failed | 4 passed (6)
MUTANT_EXIT=1
```

Restauración comprobada:

```text
b29ca5d150752aacb8b4b237f5559dab40bfdbbd6193e8665e28d36752bc0936  services/gateway/src/console/agent-documents/relay-probe.ts
94342f80c935445829d05b5e016848f8c8a2f59be205d8f671578f724b369d34  services/gateway/src/console/agent-documents/path-policy.ts
12f74b2c0cb9099fd8032b2291d3e72d44e8d88fd02772bbc638e7d9c0a3a250  services/gateway/src/routes/console/phase4.ts

Test Files  2 passed (2)
     Tests  14 passed (14)
```

## Exports cuyo único consumidor parecía ser un test

El censo reproducible no devuelve 24. En el snapshot estable devuelve **28 declaraciones de
producción**; en el árbol posterior aparecen además **8 exports de un fixture de pruebas**, para un
total sintáctico de 36. No encontré una regla coherente que produzca 24. El criterio fue AST de
declaraciones exportadas, cero ficheros consumidores de producción, un solo contexto de prueba y
búsqueda de uso adicional dentro del módulo declarante.

Los 28 de producción tienen uso dentro de su propio módulo: **27 se conservan** y solo se privatiza
`ProfileRuntimeError`, cuyo supuesto consumidor no importa el símbolo y únicamente compara el texto
de `error.name`. No hubo código muerto ni consumidor productivo faltante.

| Símbolo | Uso propio | Clasificación y decisión |
|---|---:|---|
| `AgentObservation` | Sí | Contrato nominal del resultado público de `AgentRegistry`; se conserva. |
| `TICKET_VERSION` | Sí | Constante del contrato wire probada directamente; se conserva. |
| `RESUME_TOKEN_VERSION` | Sí | Constante del contrato wire probada directamente; se conserva. |
| `RESUME_HKDF_SALT` | Sí | Dominio criptográfico usado por el módulo y probado directamente; se conserva. |
| `DEFAULT_TERMINAL_WS_PATH` | Sí | Valor por defecto usado por el parser de configuración; se conserva. |
| `DEFAULT_TERMINAL_GRANTS_FILE` | Sí | Valor por defecto usado por el parser de configuración; se conserva. |
| `DEFAULT_TICKET_TTL_SECONDS` | Sí | Límite usado por el parser de configuración; se conserva. |
| `MAX_TICKET_TTL_SECONDS` | Sí | Límite usado por el parser de configuración; se conserva. |
| `DEFAULT_SESSION_TTL_SECONDS` | Sí | Límite usado por el parser de configuración; se conserva. |
| `MAX_SESSION_TTL_SECONDS` | Sí | Límite usado por el parser de configuración; se conserva. |
| `DEFAULT_CLAIM_LEASE_SECONDS` | Sí | Límite usado por el parser de configuración; se conserva. |
| `MIN_CLAIM_LEASE_SECONDS` | Sí | Margen mínimo del contrato usado por el parser; se conserva. |
| `MAX_CLAIM_LEASE_SECONDS` | Sí | Límite usado por el parser de configuración; se conserva. |
| `DEFAULT_MAX_SESSIONS_PER_OPERATOR` | Sí | Límite usado por el parser de configuración; se conserva. |
| `DEFAULT_OPERATOR_HEADER` | Sí | Valor por defecto usado por el parser de configuración; se conserva. |
| `HttpGovernanceRelayClientOptions` | Sí | Tipo de entrada del cliente público; su consumidor es soporte de pruebas, se conserva. |
| `ProfileRuntimeError` | Sí | Helper interno; el test solo menciona el string del nombre. Se elimina únicamente `export`. |
| `DocumentsResponse` | Sí | Contrato HTTP interno usado y probado; se conserva. |
| `AgentDirectiveDeps` | Sí | Frontera de inyección legítima con implementación productiva y doble de prueba; se conserva. |
| `RespuestaDelPerfil` | Sí | Contrato HTTP usado por la ruta y probado; se conserva. |
| `PerfilAplicado` | Sí | Contrato HTTP usado por la ruta y probado; se conserva. |
| `TopeSuperado` | Sí | Contrato de error usado por la ruta y probado; se conserva. |
| `GatewayOptions` | Sí | Contrato público de `buildGateway`; se conserva. |
| `OidcSessionStore` | Sí | Frontera de almacenamiento con PostgreSQL productivo y doble en memoria; se conserva. |
| `LoginThrottle` | Sí | Clase con estado e inyección para límites deterministas; se conserva. |
| `messageVisible` | Sí | Política interna de privacidad usada por el módulo y probada directamente; se conserva. |
| `parsePasswordHash` | Sí | Parser interno usado por `verifyPassword` y probado directamente; se conserva. |
| `isAttributedHuman` | Sí | Política interna usada por `publishPriorityDecision` y probada directamente; se conserva. |

Los ocho adicionales viven en `console/agent-profile.fixtures.ts` y son auxiliares legítimos, no
fuentes de producción:

| Símbolo | Uso en el fixture | Decisión |
|---|---:|---|
| `PERFIL_BODY` | Sí | Conservar, cuerpo canónico compartido por la suite. |
| `REPLACE_PROFILE` | No | Conservar, doble explícito consumido por la suite. |
| `RUNTIME_VERIFICATION` | Sí | Conservar, evidencia canónica del fixture. |
| `RUNTIME_ADOPTION` | No | Conservar, doble explícito consumido por la suite. |
| `preparedRuntime` | Sí | Conservar, constructor de runtime preparado. |
| `runtimePreflight` | Sí | Conservar, constructor de preflight. |
| `PREPARE_RUNTIME` | No | Conservar, doble explícito consumido por la suite. |
| `MARK_PROFILE_APPLIED` | No | Conservar, doble explícito consumido por la suite. |

Al leer los ficheros grandes aparecieron otros exports redundantes que no pertenecían a ese censo:
`ProfileRuntimeAdoptionAck` y `BaseDeLaVistaPrevia` quedan privados; se retira la reexportación de
`CorePublishHandler` y `CoreRoutePhases` desde `routes/core.ts`, sin borrar sus contratos vivos.

## Simplificación de los ficheros grandes

- `terminal/session-control.ts`: no encontré capa de delegación, implementación única artificial ni
  opciones muertas. La estructura transaccional tiene decisiones distintas y se conserva. Tras el
  merge compartido quedó en 791 líneas, bajo el tope 800; se retiraron comentarios narrativos y se
  mantuvo la autorización de base de datos añadida concurrentemente.
- `console/agent-profile.routes.ts`: se eliminó una IIFE alrededor de `self_role`; el valor se
  normaliza una vez. Se privatizaron contratos que no salían del módulo y se preservó la validación
  literal de evidencia de adopción.
- `routes/core.ts`: los dos manejos idénticos de fallo de heartbeat se consolidaron en
  `rejectHeartbeat`; se retiró una reexportación intermedia sin consumidores.
- `console/agent-documents.routes.ts`: `destino` devolvía `{ actor, target }` aunque ningún llamante
  usaba `actor`; ahora devuelve `target`. El límite duplicado `256 * 1024` usa
  `MAX_DOCUMENT_BYTES`.
- `console/relay-governance-client.ts`: cuatro copias del mismo manejo de overflow, autorización,
  estado HTTP y errores de transporte se consolidaron en `parseHttpResult` y
  `relayCommunicationError`. La clase conserva estado y frontera de transporte; no era ceremonia.

No encontré un objeto de opciones con campos sin usar, builder ceremonial ni dos implementaciones
de dominio equivalentes en esos cinco ficheros.

## `eslint-disable`

La orden decía cinco, pero había **8 directivas repartidas en 5 ficheros**: una en `app.ts`, una en
`password-auth.test.ts`, una en `terminal.plugin.test.ts`, tres en `routes/core.ts` y dos en
`routes/core/outbox.ts`.

Quedan **4 directivas**:

- `app.ts`: protege llamadas JavaScript que pueden omitir una opción obligatoria para TypeScript;
  razón única, se conserva.
- `terminal.plugin.test.ts`: el primer `beforeEach` alcanza el helper antes de inicializar `app`;
  razón única de lifecycle de prueba, se conserva.
- `routes/core.ts`, drenaje: una petición concurrente puede cambiar `drainAgain` durante el `await`;
  razón única de concurrencia, se conserva.
- `routes/core.ts`, hello: `closed` y el socket pueden cambiar durante el heartbeat; razón única de
  concurrencia, se conserva.

Las cuatro retiradas repetían razones que sí pedían helper: los estados de socket usan
`isSocketOpen`, el estado terminal del ACK usa `isExpectedWakeStatus`, y el test de password expone
los spies concretos en vez de desactivar `unbound-method` para todo el fichero.

## Diferencias entre el árbol y la orden

1. Los ocho tamaños medidos eran 410/292/285/232/174/128/97/76, una línea menos cada uno que los
   411/293/286/233/175/129/98/77 de la orden.
2. El censo reproducible fue 28 de producción, no 24; el árbol posterior tenía además ocho exports
   de fixture.
3. Había ocho directivas `eslint-disable` en cinco ficheros, no cinco directivas.
4. Durante el trabajo se integró `origin/main` en `dev` y hubo conflictos compartidos en dos
   ficheros del gateway. La resolución conservó tanto las simplificaciones como los controles nuevos
   de permiso de base de datos; después HEAD siguió avanzando por commits de otras zonas.
5. La orden asigna la rama `dev`; el `AGENTS.md` general aún habla de `main`. Mandó la orden explícita
   y todo este trabajo permaneció en `dev`.
6. El gate de partida sí coincidió en gateway (33/570) y hardening (19/120). Tras las pruebas y el
   merge compartido, gateway pasó a 35/595; hardening siguió en 19/120.
7. `session-control.ts` pasó de las 781 líneas indicadas a 791 por controles de seguridad integrados
   concurrentemente, todavía nueve líneas por debajo del límite.
8. La cobertura focal avisó que `vitest` era 3.2.7 y `@vitest/coverage-v8` 3.2.4; las pruebas y el
   informe se generaron, y este diff no modificó dependencias.
9. Durante la convivencia, el gate global quedó temporalmente rojo por
   `console/src/App.tsx:225` y por un comentario extra en consola y otro en adapter-sdk. Eran cambios
   fuera de zona; sus dueños los corrigieron y no se hizo commit hasta repetir el gate completo en
   verde.

## Qué NO probé

Qué NO probé:

- las suites que necesitan Docker/Testcontainers, incluidos
  `packages/store/test/migration-integrity-postgres.test.ts`,
  `tests/integration/otel-collector-config.test.ts` y
  `tests/integration/busybox-console-healthcheck.test.ts`;
- despliegue, contenedores, unidades systemd, base productiva ni terminal-relay vivo;
- una campaña mutante exhaustiva: se ejecutaron exactamente los tres mutantes exigidos;
- E2E del navegador o cambios de la consola, porque están fuera de `services/gateway/**`.

## Revisión independiente

El revisor adversarial emitió `APPROVE`, sin hallazgos bloqueantes ni medios. Confirmó lint estricto,
7 ficheros/89 pruebas focales verdes y 3 ficheros/22 pruebas nuevas o ampliadas verdes. Dejó como
riesgo residual bajo que los errores HTTP comunes de `parseHttpResult` se prueban mediante lectura y
listado y no se duplican expresamente en cada método de escritura; los cuatro llamantes usan el
mismo helper.
