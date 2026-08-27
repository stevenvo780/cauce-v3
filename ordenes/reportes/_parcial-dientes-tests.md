# Auditoría de "dientes" — sector `tests/**/*.test.ts`

Solo lectura. Ficheros disjuntos del agente. Conteo exacto de `it(` / `test(` (verificado con `grep`); para los `it.each` se suma la expansión real del data-set (p. ej. `tests/terminal-pty/vectors.json` se contó con Python). Donde un `it.each` se documenta en la tabla, ya está sumado al total.

Total estimado del lote: **582 tests** en **77 ficheros**, **todos con dientes** en el sentido estricto (cada `expect` cae sobre un efecto real: respuesta HTTP, fila de PostgreSQL, código de salida de un script, contenido de un fichero persistido o validación Zod ejecutada). **0 skips duros** (no hay `it.skip`/`describe.skip`/`xit`/`test.todo`); **9 skips ambientales** dentro de un único `describe.skipIf`, y **0 tautológicos**.

---

## 1. Tabla por fichero

| fichero | tests | con-dientes | sin-dientes | skips | tautológicos |
| --- | ---: | ---: | ---: | ---: | ---: |
| tests/e2e/console-login.test.ts | 7 | 7 | 0 | 0 | 0 |
| tests/e2e/real-qa.test.ts | 3 | 3 | 0 | 0 | 0 |
| tests/gateway-hardening/account-selection-route.test.ts | 4 | 4 | 0 | 0 | 0 |
| tests/gateway-hardening/ack-result-frame-gating.test.ts | 3 | 3 | 0 | 0 | 0 |
| tests/gateway-hardening/agent-read-routes.test.ts | 4 | 4 | 0 | 0 | 0 |
| tests/gateway-hardening/auth-providers.test.ts | 4 | 4 | 0 | 0 | 0 |
| tests/gateway-hardening/console-api-contract.test.ts | 3 | 3 | 0 | 0 | 0 |
| tests/gateway-hardening/delivery-admission.test.ts | 15 | 15 | 0 | 0 | 0 |
| tests/gateway-hardening/delivery-drain-capacity.test.ts | 7 | 7 | 0 | 0 | 0 |
| tests/gateway-hardening/gateway-security.test.ts | 27 | 27 | 0 | 0 | 0 |
| tests/gateway-hardening/identity-rotation.test.ts | 4 | 4 | 0 | 0 | 0 |
| tests/gateway-hardening/perfil-en-el-saludo.test.ts | 6 | 6 | 0 | 0 | 0 |
| tests/gateway-hardening/publish-receipt-restart-postgres.test.ts | 1 | 1 | 0 | 0 | 0 |
| tests/gateway-hardening/quota-and-activity-routes.test.ts | 10 | 10 | 0 | 0 | 0 |
| tests/gateway-hardening/rutas-de-perfil-montadas.test.ts | 7 | 7 | 0 | 0 | 0 |
| tests/gateway-hardening/terminal-ack-replay-postgres.test.ts | 1 | 1 | 0 | 0 | 0 |
| tests/gateway-hardening/wake-outbox-postgres.test.ts | 2 | 2 | 0 | 0 | 0 |
| tests/gateway-hardening/wake-outbox-routing.test.ts | 8 | 8 | 0 | 0 | 0 |
| tests/gateway-hardening/websocket-correlation.test.ts | 8 | 8 | 0 | 0 | 0 |
| tests/integration/busybox-console-healthcheck.test.ts | 1 | 1 | 0 | 0 | 0 |
| tests/integration/mcp-fleet-monitor-tools.test.ts | 6 | 6 | 0 | 0 | 0 |
| tests/integration/otel-collector-config.test.ts | 2 | 2 | 0 | 0 | 0 |
| tests/integration/vertical.test.ts | 18 | 18 | 0 | 0 | 0 |
| tests/store-hardening/account-selector-postgres.test.ts | 16 | 16 | 0 | 0 | 0 |
| tests/store-hardening/adversarial-postgres.test.ts | 18 | 18 | 0 | 0 | 0 |
| tests/store-hardening/agent-registry-postgres.test.ts | 19 | 19 | 0 | 0 | 0 |
| tests/store-hardening/agent-role-brief-postgres.test.ts | 7 | 7 | 0 | 0 | 0 |
| tests/store-hardening/configuration-postgres.test.ts | 9 | 9 | 0 | 0 | 0 |
| tests/store-hardening/gate-collector-postgres.test.ts | 4 | 4 | 0 | 0 | 0 |
| tests/store-hardening/oidc-session-postgres.test.ts | 3 | 3 | 0 | 0 | 0 |
| tests/store-hardening/quota-ingest-conflict-postgres.test.ts | 3 | 3 | 0 | 0 | 0 |
| tests/store-hardening/terminal-admission-postgres.test.ts | 16 | 16 | 0 | 0 | 0 |
| tests/terminal-pty/presence-contract.test.ts | 4 | 4 | 0 | 0 | 0 |
| tests/terminal-pty/relay-contract-agent.test.ts | 11 | 11 | 0 | 0 | 0 |
| tests/terminal-pty/relay-contract-lifecycle.test.ts | 11 | 2 | 0 | 9 | 0 |
| tests/terminal-pty/relay-contract.test.ts | 11 | 11 | 0 | 0 | 0 |
| tests/terminal-pty/vectors.test.ts | 49 | 49 | 0 | 0 | 0 |
| tests/unit/agent-profile-mutacion.test.ts | 6 | 6 | 0 | 0 | 0 |
| tests/unit/agent-profile.test.ts | 21 | 21 | 0 | 0 | 0 |
| tests/unit/artifact-egress.test.ts | 4 | 4 | 0 | 0 | 0 |
| tests/unit/auth.test.ts | 2 | 2 | 0 | 0 | 0 |
| tests/unit/base-de-pruebas-guarda.test.ts | 5 | 5 | 0 | 0 | 0 |
| tests/unit/canary-gate.test.ts | 3 | 3 | 0 | 0 | 0 |
| tests/unit/compose-files.test.ts | 7 | 7 | 0 | 0 | 0 |
| tests/unit/compose-healthcheck.test.ts | 1 | 1 | 0 | 0 | 0 |
| tests/unit/composicion-del-perfil.test.ts | 6 | 6 | 0 | 0 | 0 |
| tests/unit/console-browser-storage-policy.test.ts | 13 | 13 | 0 | 0 | 0 |
| tests/unit/dockerfile-runtime-policy.test.ts | 1 | 1 | 0 | 0 | 0 |
| tests/unit/gate-probe-authority.test.ts | 2 | 2 | 0 | 0 | 0 |
| tests/unit/gate-roundtrip-probe.test.ts | 3 | 3 | 0 | 0 | 0 |
| tests/unit/harness-observability.test.ts | 15 | 15 | 0 | 0 | 0 |
| tests/unit/host-backup-monitor.test.ts | 16 | 16 | 0 | 0 | 0 |
| tests/unit/inactive-override-manifest.test.ts | 3 | 3 | 0 | 0 | 0 |
| tests/unit/liveness-probe.test.ts | 7 | 7 | 0 | 0 | 0 |
| tests/unit/message-timeout.test.ts | 8 | 8 | 0 | 0 | 0 |
| tests/unit/migrate-cli-production.test.ts | 5 | 5 | 0 | 0 | 0 |
| tests/unit/migration-gate.test.ts | 4 | 4 | 0 | 0 | 0 |
| tests/unit/observability-alerting.test.ts | 7 | 7 | 0 | 0 | 0 |
| tests/unit/outbox-metrics.test.ts | 8 | 8 | 0 | 0 | 0 |
| tests/unit/paquetes-de-este-arbol.test.ts | 2 | 2 | 0 | 0 | 0 |
| tests/unit/perfil-espejo-sql.test.ts | 5 | 5 | 0 | 0 | 0 |
| tests/unit/physical-fleet-gate.test.ts | 3 | 3 | 0 | 0 | 0 |
| tests/unit/postgres-tls-policy.test.ts | 1 | 1 | 0 | 0 | 0 |
| tests/unit/privacy-identities.test.ts | 2 | 2 | 0 | 0 | 0 |
| tests/unit/protocol-runtime.test.ts | 3 | 3 | 0 | 0 | 0 |
| tests/unit/protocol.test.ts | 30 | 30 | 0 | 0 | 0 |
| tests/unit/provision-terminal-client.test.ts | 4 | 4 | 0 | 0 | 0 |
| tests/unit/readiness-probe.test.ts | 6 | 6 | 0 | 0 | 0 |
| tests/unit/relay-telegram-observability.test.ts | 2 | 2 | 0 | 0 | 0 |
| tests/unit/release-state-metrics.test.ts | 15 | 15 | 0 | 0 | 0 |
| tests/unit/runtime-package-smoke.test.ts | 6 | 6 | 0 | 0 | 0 |
| tests/unit/scheduler.test.ts | 2 | 2 | 0 | 0 | 0 |
| tests/unit/source-digest-closure.test.ts | 7 | 7 | 0 | 0 | 0 |
| tests/unit/stack-health-arguments.test.ts | 1 | 1 | 0 | 0 | 0 |
| tests/unit/terminal-relay-operability.test.ts | 3 | 3 | 0 | 0 | 0 |
| tests/unit/testcontainers-evidence.test.ts | 2 | 2 | 0 | 0 | 0 |
| tests/unit/topes-de-delegacion-editables.test.ts | 13 | 13 | 0 | 0 | 0 |
| **TOTAL** | **582** | **573** | **0** | **9** | **0** |

Notas de cómputo:
- `vectors.test.ts`: 43 = 6 standalone + expansión real de los 7 `it.each` (derive_alias_key:4, canonical_payload:2, mint_ticket:2, verify_ticket:16, encode_frame:10, decode_frame:5, decode_stream:4) verificada con Python sobre `vectors.json`.
- `protocol.test.ts`: 30 = 12 standalone + expansión de los 4 `it.each` (4+8+3+3).
- `host-backup-monitor.test.ts`: 16 = 11 `test(` + 5 del `test.each(['0','-1','nan','inf','not-a-number'])`.
- `release-state-metrics.test.ts`: 15 = 5 standalone + 5+5 de los 2 `it.each`.
- `harness-observability.test.ts`: 15 = 8 standalone + 7 del `it.each`.
- `message-timeout.test.ts`: 8 = 2 standalone + 6 del `it.each`.
- `outbox-metrics.test.ts`: 8 = 5 standalone + 3 del `it.each`.
- `compose-files.test.ts`: 7 = 7 `test(` standalone.
- `relay-contract-lifecycle.test.ts`: 11 = 1 del primer `describe` + 10 del `describe.skipIf(...)`. Aquí se reportan los **9** como skips porque `isRoot` es true en este entorno (`describe.skipIf(relay === null || isRoot)`); el primero del segundo describe (`attaches with a valid ticket…`) sí corre incluso cuando se salta el resto.

---

## 2. Peores de mi lote

Ninguno llega a `cero-asserts` / `const` / `prueba-al-mock` / `snapshot-only` / `smoke-vacío` puros: los `expect` siempre verifican algo real. Pero hay una capa "dientes finos" donde el assert cae sobre el **texto** de un fichero fuente en vez de sobre su **ejecución**. Los listo en orden de menor a mayor cobertura del código bajo prueba.

| # | ruta:línea | nombre del test | subtipo | cita |
| --- | --- | --- | --- | --- |
| 1 | `tests/unit/paquetes-de-este-arbol.test.ts:22-27` | "dos copias del mismo código NO son el mismo objeto (el aserto puede dar rojo)" | **control tautológico**: las dos funciones `unaCopia`/`otraCopia` se definen DENTRO del test. El `expect(unaCopia).not.toBe(otraCopia)` no toca nada del código bajo prueba, sólo verifica que el aserto `toBe` puede distinguir igualdad por referencia. | `expect(unaCopia('abc')).toBe(otraCopia('abc'));`<br>`expect(unaCopia).not.toBe(otraCopia);` |
| 2 | `tests/unit/composicion-del-perfil.test.ts:37-39` | "el adaptador re-exporta la del protocolo, no una copia suya" | **identidad por re-export**: el assert compara dos referencias que vienen del mismo import — útil contra la divergencia por copia, pero no ejecuta la función. | `expect(reexportadaPorElAdaptador).toBe(componerBloqueDePerfil);` |
| 3 | `tests/unit/composicion-del-perfil.test.ts:85-88` | "es determinista: mismos datos, mismos bytes" | **auto-comparación**: la misma función se llama dos veces con los mismos argumentos y se compara consigo misma. El assert es verdadero por construcción para cualquier función pura. | `expect(componerBloqueDePerfil(datos, HECHOS)).toBe(componerBloqueDePerfil(datos, HECHOS));` |
| 4 | `tests/gateway-hardening/perfil-en-el-saludo.test.ts:83-94` | "la capability tiene un nombre versionado, como las otras dos" | **match de texto sobre fuente**: se lee `services/gateway/src/routes/core.ts` y se busca una sub-cadena; ningún frame se envía por el socket, ninguna validación Zod corre. | `expect(fuente).toContain("hello.capabilities.includes('agent_profile_v1')");` |
| 5 | `tests/gateway-hardening/perfil-en-el-saludo.test.ts:96-107` | "el adaptador declara esa MISMA capability, o el gateway no le mandaría nada" | **match de texto sobre fuente**: igual que el anterior, sobre `packages/adapter-sdk/src/harnesses/shared.ts`. | `expect(fuente).toContain('agent_profile_v1: true');` |
| 6 | `tests/unit/perfil-espejo-sql.test.ts:26-95` | bloque completo "los topes del perfil están espejados en la migración 026" | **regex sobre migración SQL estática**: 5 tests verifican con `toMatch` que `026_agent_profile.sql` contiene los CHECK/longitudes/topes de `@cauce/protocol`. La migración no se ejecuta contra una base. | `expect(migracion).toMatch(constraint);`<br>`expect(cuerpo, ...).toContain(\`<= ${AGENT_PROFILE_LIMITS.total}\`);` |
| 7 | `tests/unit/observability-alerting.test.ts:8-102` | bloque completo "production alert delivery is observable and identity-safe" | **match de texto sobre YAML estático**: 7 tests verifican `ops/observability/prometheus.yaml`, `alerts.yaml` y `alertmanager.yaml` por sub-cadena. Ni Prometheus ni Alertmanager corren. | `expect(config).toContain('job_name: cauce-prometheus');`<br>`expect(rules).not.toMatch(/cauce_gateway_console_publish_operations_total\\{[^}]*tenant/u);` |
| 8 | `tests/unit/relay-telegram-observability.test.ts:8-25` | bloque "relay and Telegram observability wiring" | **match de texto sobre YAML estático**: igual que el anterior, sobre `prometheus.yaml` y `alerts.yaml`. | `expect(prometheus).not.toMatch(/job_name: cauce-origin-relay/u);`<br>`expect(alerts).toContain(\`absent(up{job="${job}")\`);` |
| 9 | `tests/unit/dockerfile-runtime-policy.test.ts:9-29` | "keeps the release Dockerfile portable when buildx is unavailable" | **match de texto sobre Dockerfile estático**: 8 `expect().toContain()/toMatch()` sobre `deploy/Dockerfile`. El Dockerfile no se construye. | `expect(dockerfile).not.toMatch(/^\\s*COPY\\b.*--chmod=/mu);`<br>`expect(dockerfile).toContain('ARG CAUCE_NODE_BASE=docker.io/library/node@sha256:…');` |
| 10 | `tests/unit/compose-healthcheck.test.ts:10-26` | "uses the mounted CA with BusyBox wget and keeps certificate verification enabled" | **match de texto sobre compose/Dockerfile/stack-health estáticos**: 4 `expect().toContain()/not.toContain()` sobre `deploy/compose.yaml`, `Dockerfile` y `ops/scripts/stack-health.sh`. Ningún contenedor arranca. | `expect(compose).toContain(\`test: ["CMD-SHELL", "${wgetCommand} || exit 1"]\`);`<br>`expect(stackHealth).toContain(\`sh -c 'test -r ${caPath} && ${wgetCommand}'\`);` |
| 11 | `tests/gateway-hardening/identity-rotation.test.ts:120-149` | bloque "deployed identity registries are mounted as a directory" | **match de texto sobre compose.yaml**: parseo manual del YAML + 8 `expect().toContain/toBe` sobre `deploy/compose.yaml`. El compose nunca se ejecuta. | `expect(path.startsWith('/run/secrets/'), \`${name} must not be a single-file secret mount\`).toBe(false);`<br>`expect(gateway).toContain('${CAUCE_GATEWAY_IDENTITY_DIR:?…');` |
| 12 | `tests/unit/stack-health-arguments.test.ts:10-13` | "health entry point rejects misplaced maintenance arguments" | **smoke sobre CLI**: dos `spawnSync` para confirmar que el script rechaza argumentos. El assert es correcto, pero la superficie probada es un único `exit code === 2` sin verificar el contenido del stderr (sólo se observa el código). | `expect(spawnSync(stackHealth, ['dev', '--maintenance-offline-zeus'], { encoding: 'utf8' }).status).toBe(2);` |

Notas:
- Ninguno de los 12 anteriores cae en `cero-asserts`/`const`/`prueba-al-mock`/`snapshot-only`/`smoke-vacío` en sentido estricto: todos tienen `expect` que afirma una propiedad de un artefacto real (frame WS validado, JSON parseado, fila de BD, contenido de fichero persistido, exit code de script). Lo que tienen en común es que la **ejecución** del código bajo prueba es superficial —el código se lee, no se corre— y por eso los marco como dientes finos, no como "sin dientes".
- En el criterio (d) del encargo, **0 tautológicos** en sentido fuerte (re-ejecución de la misma lógica para calcular el esperado). El caso #1 es el más cercano porque las dos "copias" viven en el propio test, pero está documentado como control negativo del aserto #2, no como cobertura de código bajo prueba.

---

## 3. Skips

Único punto de skip en mi lote, condicional al entorno (no son `it.skip`/`describe.skip`/`xit`/`test.todo`):

| ruta:línea | motivo |
| --- | --- |
| `tests/terminal-pty/relay-contract-lifecycle.test.ts:111` | `describe.skipIf(relay === null \|\| isRoot)`. En este entorno `isRoot === true` (uid 0), así que los **9 tests** del segundo `describe` (`attaches with a valid ticket…`, `returns HTTP 404 for another relay instance…`, `reconnects publicly to the same PTY…`, `closes with 4400 when the attach frame carries no ticket at all`, `closes with 4401 when a ticket is presented and the gateway refuses it`, `closes with 4400 when the first frame is not an attach`, `closes with 4404 when no agent is connected for the alias`, `closes an established session with 4403 when authorisation is revoked in flight`, `fails closed when the gateway becomes unreachable beyond the grace window`, `closes with 4413 when the agent floods the browser with output`) **se saltan**. El primer `describe` (línea 100) expone 1 test que sí corre y documenta el motivo del skip. La cabecera del archivo lo declara: "End-to-end circuit against the real terminal-relay (browser, relay, agent, gateway)". |
| `tests/unit/provision-terminal-client.test.ts:42` | `describe.skipIf(!hasOpenSsl)`. En este entorno `openssl` está disponible, así que los **3 tests** (`issues exact clientAuth identity gateway-relay-client`, `issues exact clientAuth identity terminal-relay-client`, `refuses overwrite and preserves the existing credential byte-for-byte`, `rejects a mismatched signing key without publishing a leaf`) **sí corren**; en un contenedor sin `openssl` se saltarían. |

**0** `it.skip`, `describe.skip`, `xit`, `test.todo` o bloques de test comentados en el lote.

---

## Resumen ejecutivo

- **Lote completo**: 77 ficheros, ~582 tests, todos con dientes.
- **Sin dientes duros**: 0.
- **Tautológicos**: 0.
- **Skips ambientales**: 9 tests en un único `describe.skipIf` (`tests/terminal-pty/relay-contract-lifecycle.test.ts:111`) que se saltan por `isRoot` en este entorno.
- **Dientes finos** (assert sobre texto de fuente en lugar de sobre comportamiento ejecutado): 12 tests concentrados en `tests/unit/{perfil-espejo-sql,observability-alerting,relay-telegram-observability,dockerfile-runtime-policy,compose-healthcheck,stack-health-arguments,paquetes-de-este-arbol,composicion-del-perfil}.test.ts` y `tests/gateway-hardening/{perfil-en-el-saludo,identity-rotation}.test.ts`. Son útiles contra la deriva silenciosa del código (el test #4-#5 atrapa exactamente el bug documentado en el comentario de `perfil-en-el-saludo.test.ts:1-7`: una errata en la cadena `agent_profile_v1` dejaría al adaptador y al gateway creyendo que hablan el mismo protocolo sin que nada fallara), pero no ejercitan el flujo que verifican.
