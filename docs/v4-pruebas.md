# Inventario de pruebas reales de V4

Esta tabla enumera archivos y comandos presentes en el checkout. Los conteos son por los patrones indicados y se recalculan en `tests/unit/docs-v4-pruebas.test.ts`; no cuentan casos ejecutados ni equivalen a un resultado PASS. Las categorías se pueden solapar.

| ID | Categoría | Archivos | Ejecución | Cubre | No cubre todavía |
|---|---|---:|---|---|---|
| unitarias | Pruebas unitarias | 654 | `pnpm test:unit` | Código y contratos aislados; incluye las suites unitarias de paquetes y consola declaradas en el script. | No demuestra por sí sola efectos persistentes de extremo a extremo, runtime remoto ni comportamiento desplegado. |
| postgres | PostgreSQL real con Testcontainers | 228 | `pnpm test` | Pruebas con sufijos `-postgres.test.ts`, `.postgres.test.ts` y `.pg.test.ts`, distribuidas entre servicios, store, integración y e2e. No hay un runner único exclusivo para PostgreSQL. | No acredita todos los recorridos de navegador, autenticación real de proveedores ni comportamiento en producción. |
| navegador | E2E de navegador real | 25 | `pnpm test:e2e` | Archivos `tests/e2e/*real-browser*.test.*`; el runner ejecuta la carpeta completa, incluidos los recorridos V4 presentes en el checkout. El inventario por archivo y caso está en la sección «E2E de navegador real». | La matriz mantiene 24 pendientes, entre ellos ciclos completos de ordenadores, personas, runtime físico y contextos. GOAL §10 aún marca pendiente cerrar estados y mejorar la retroalimentación de todas las vistas. |
| fallos | Simulacros de fallo y auxiliares | 10 | `pnpm test:integration && pnpm test:ops` | Archivos con prefijo `failure-drill` bajo `tests/integration` y `ops/tests`, más `test-fault*.sh`. | GOAL §10 mantiene pendientes pruebas de fallo con procesos reales; la matriz deja pendiente `context_git_concurrent_recovery` en navegador y despliegue. Estos simulacros no acreditan por sí solos recuperación en producción. |
| aislamiento | Adversariales y de aislamiento | 50 | `pnpm test:gateway-hardening && pnpm test:store-hardening && pnpm test:services` | Suites `tests/gateway-hardening`, `tests/store-hardening` y la prueba `services/gateway/src/security/route-isolation.postgres.test.ts`. | GOAL §1.3 mantiene pendiente la guardia P0 que enumera todas las rutas `/v3` y prueba IDs cruzados sin mutaciones, además de los efectos remotos entre empresas. |
| ops | Ops y Python | 167 | `pnpm test:ops` | Archivos descubiertos por `ops/tests/run-all.mjs`, incluidos casos Python y shell con sus requisitos de ejecución. | No sustituye las suites de servicios, las pruebas de navegador ni la verificación desplegada; el runner puede marcar casos como omitidos si faltan requisitos de host o Docker. |
| layout | Layout | 12 | `pnpm qa:layout` | Módulos ejecutables `.mjs` de `console/qa`; el gate renderiza rutas en Chromium y compara medidas con sus baselines. | GOAL §10 mantiene pendiente resolver en todas las vistas los estados vacíos, de carga y error con retroalimentación clara. |
| release | Gate de release | 1 | `scripts/release-gates.sh` | Script que declara y ejecuta diez pasos: primero el barrido acotado de huérfanos de las suites desechables y después nueve gates pnpm en carriles paralelos, cada uno un checkout del mismo commit (`CAUCE_RELEASE_GATES_JOBS`, por defecto según CPU y memoria; `1` los corre en secuencia); `scripts/release-gates.sh --list` imprime sus comandos. | Exige un árbol limpio y herramientas disponibles; no despliega ni comprueba el efecto vivo. El barrido no recorre el Docker compartido: solo `ops/tests/test_fleet_orphan_sweep.py` y `ops/tests/test_fleet_executor_container.py`. GOAL §10 todavía marca documentación y recorridos de aceptación como pendientes. |

## Conteos reproducibles

Ejecutar desde la raíz del repositorio. Cada comando imprime el número de archivos que corresponde al alcance de la fila.

- `unitarias`: `find tests/unit packages/protocol/test packages/store/src packages/adapter-sdk/test packages/mcp-fleet-monitor services/decisiones/test console -type d \( -name '.*' -o -name __pycache__ -o -name coverage -o -name dist -o -name node_modules \) -prune -o -type f \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.test.mjs' -o -name '*.test.js' \) -print | wc -l`
- `postgres`: `find tests packages services -type d \( -name '.*' -o -name __pycache__ -o -name coverage -o -name dist -o -name node_modules \) -prune -o -type f \( -name '*-postgres.test.ts' -o -name '*.postgres.test.ts' -o -name '*.pg.test.ts' \) -print | wc -l`
- `navegador`: `find tests/e2e -maxdepth 1 -type f -name '*real-browser*.test.*' -print | wc -l`
- `fallos`: `find tests/integration ops/tests -type d \( -name '.*' -o -name __pycache__ -o -name coverage -o -name dist -o -name node_modules \) -prune -o -type f \( -name 'failure-drill*' -o -name 'test-fault*.sh' \) -print | wc -l`
- `aislamiento`: `find tests/gateway-hardening tests/store-hardening services/gateway/src/security/route-isolation.postgres.test.ts -type f -name '*.test.ts' -print | wc -l`
- `ops`: `node ops/tests/run-all.mjs --list | wc -l`
- `layout`: `find console/qa -maxdepth 1 -type f -name '*.mjs' -print | wc -l`
- `release`: `find scripts -maxdepth 1 -type f -name 'release-gates.sh' -print | wc -l`

## E2E de navegador real

Este inventario sustituye la cifra histórica «17 e2e de vistas V3 y un recorrido V4 de 12 pasos fuera del repo», que ningún recibo acredita. Lo verificable es lo versionado: los archivos `tests/e2e/*real-browser*.test.*` y sus casos `it(`. El recorrido V4 que estaba fuera del repo es hoy `tests/e2e/v4-console-real-browser.test.ts`, con 13 casos. `tests/unit/docs-v4-pruebas.test.ts` recalcula estas tablas. Contar un caso no equivale a un resultado PASS.

| Grupo | Archivos | Casos |
|---|---:|---:|
| V4 (`v4-*`) | 12 | 61 |
| V3 y V3.5 (resto) | 13 | 21 |

| Archivo V4 | Casos | Recorrido |
|---|---:|---|
| `tests/e2e/v4-company-admins-real-browser.test.ts` | 2 | Autoridad de empresa: dueños y administradores. |
| `tests/e2e/v4-console-real-browser.test.ts` | 13 | Recorrido V4 completo de la consola en Chromium y PostgreSQL. |
| `tests/e2e/v4-context-files-real-browser.test.ts` | 1 | Archivos de contexto. |
| `tests/e2e/v4-contexts-real-browser.test.ts` | 1 | Contextos y versiones. |
| `tests/e2e/v4-crud-matriz-real-browser.test.ts` | 9 | Matriz CRUD: ordenadores, cuentas, registro de agente y partes del plano. |
| `tests/e2e/v4-humanizar-session-real-browser.test.ts` | 4 | Sesión de las personas de Humanizar en un clon. |
| `tests/e2e/v4-office-real-browser.test.ts` | 13 | Oficina: salas y agentes de alta a baja, re-login, segundo navegador y cansancio en campus, plano y ficha. |
| `tests/e2e/v4-people-real-browser.test.ts` | 6 | Personas y acceso web. |
| `tests/e2e/v4-purge-real-browser.test.ts` | 1 | Purga real de un agente. |
| `tests/e2e/v4-quota-descriptor-real-browser.test.ts` | 1 | Cuota por descriptor aprobado: un pin alterado retira el lector de «Mis cuotas» y rechaza crear y consultar antes de encolar. |
| `tests/e2e/v4-quota-environments-real-browser.test.ts` | 7 | Entornos de cuota. |
| `tests/e2e/v4-space-backups-real-browser.test.ts` | 3 | Copia de espacio desde el panel: exportación física firmada de más de 32 MiB, descarga verificada por tamaño y SHA-256, restauración con hashes iguales y rechazo entre empresas. |

Conteo reproducible desde la raíz:

```sh
find tests/e2e -maxdepth 1 -type f -name 'v4-*real-browser*.test.*' -print | wc -l
grep -cE '^\s*it\(' tests/e2e/*real-browser*.test.ts
```

## Límites de aceptación que siguen abiertos

- GOAL §10 deja pendientes los estados vacíos, de carga y error con retroalimentación en todas las vistas, los fallos con procesos reales y la documentación operativa completa.
- La matriz CRUD mantiene 24 elementos pendientes. Incluye recorridos de navegador para ordenadores, personas, autoridad, runtime, contextos, harnesses, cuotas y oficina; el detalle verificable está en `docs/v4-matriz-crud.json`.
- Los conteos reflejan archivos presentes, no ejecución de comandos ni evidencia de aceptación local o desplegada.
