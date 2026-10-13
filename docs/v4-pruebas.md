# Inventario de pruebas reales de V4

Esta tabla enumera archivos y comandos presentes en el checkout. Los conteos son por los patrones indicados y se recalculan en `tests/unit/docs-v4-pruebas.test.ts`; no cuentan casos ejecutados ni equivalen a un resultado PASS. Las categorías se pueden solapar.

| ID | Categoría | Archivos | Ejecución | Cubre | No cubre todavía |
|---|---|---:|---|---|---|
| unitarias | Pruebas unitarias | 649 | `pnpm test:unit` | Código y contratos aislados; incluye las suites unitarias de paquetes y consola declaradas en el script. | No demuestra por sí sola efectos persistentes de extremo a extremo, runtime remoto ni comportamiento desplegado. |
| postgres | PostgreSQL real con Testcontainers | 224 | `pnpm test` | Pruebas con sufijos `-postgres.test.ts`, `.postgres.test.ts` y `.pg.test.ts`, distribuidas entre servicios, store, integración y e2e. No hay un runner único exclusivo para PostgreSQL. | No acredita todos los recorridos de navegador, autenticación real de proveedores ni comportamiento en producción. |
| navegador | E2E de navegador real | 23 | `pnpm test:e2e` | Archivos `tests/e2e/*real-browser*.test.*`; el runner ejecuta la carpeta completa, incluidos los recorridos V4 presentes en el checkout. | La matriz mantiene 24 pendientes, entre ellos ciclos completos de ordenadores, personas, runtime físico, contextos y la restauración y el borrado de copias desde la consola. GOAL §10 aún marca pendiente versionar el e2e V4, cerrar estados y mejorar la retroalimentación de todas las vistas. |
| fallos | Simulacros de fallo y auxiliares | 10 | `pnpm test:integration && pnpm test:ops` | Archivos con prefijo `failure-drill` bajo `tests/integration` y `ops/tests`, más `test-fault*.sh`. | GOAL §10 mantiene pendientes pruebas de fallo con procesos reales; la matriz deja pendiente `context_git_concurrent_recovery` en navegador y despliegue. Estos simulacros no acreditan por sí solos recuperación en producción. |
| aislamiento | Adversariales y de aislamiento | 50 | `pnpm test:gateway-hardening && pnpm test:store-hardening && pnpm test:services` | Suites `tests/gateway-hardening`, `tests/store-hardening` y la prueba `services/gateway/src/security/route-isolation.postgres.test.ts`. | GOAL §1.3 mantiene pendiente la guardia P0 que enumera todas las rutas `/v3` y prueba IDs cruzados sin mutaciones, además de los efectos remotos entre empresas. |
| ops | Ops y Python | 164 | `pnpm test:ops` | Archivos descubiertos por `ops/tests/run-all.mjs`, incluidos casos Python y shell con sus requisitos de ejecución. | No sustituye las suites de servicios, las pruebas de navegador ni la verificación desplegada; el runner puede marcar casos como omitidos si faltan requisitos de host o Docker. |
| layout | Layout | 12 | `pnpm qa:layout` | Módulos ejecutables `.mjs` de `console/qa`; el gate renderiza rutas en Chromium y compara medidas con sus baselines. | GOAL §10 mantiene pendiente cubrir las rutas V4 en `qa:layout` y resolver estados vacíos, de carga y error con retroalimentación clara. |
| release | Gate de release | 1 | `scripts/release-gates.sh` | Script que declara y ejecuta diez pasos en secuencia (el barrido acotado de huérfanos de las suites desechables y nueve gates pnpm); `scripts/release-gates.sh --list` imprime sus comandos. | Exige un árbol limpio y herramientas disponibles; no despliega ni comprueba el efecto vivo. El barrido no recorre el Docker compartido: solo `ops/tests/test_fleet_orphan_sweep.py` y `ops/tests/test_fleet_executor_container.py`. GOAL §10 todavía marca documentación y recorridos de aceptación como pendientes. |

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

## Límites de aceptación que siguen abiertos

- GOAL §10 deja pendientes los estados vacíos, de carga y error con retroalimentación, el inventario de rutas V4 en `qa:layout`, los fallos con procesos reales y la documentación operativa completa.
- La matriz CRUD mantiene 30 elementos pendientes. Incluye recorridos de navegador para ordenadores, personas, autoridad, runtime, contextos, copias, harnesses, cuotas y oficina; el detalle verificable está en `docs/v4-matriz-crud.json`.
- Los conteos reflejan archivos presentes, no ejecución de comandos ni evidencia de aceptación local o desplegada.
