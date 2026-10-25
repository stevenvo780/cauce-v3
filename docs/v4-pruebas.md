# Inventario de pruebas reales de V4

> Histórico: este inventario, sus conteos y pendientes pertenecen al cierre anterior; para verificar y operar la versión actual, consulta [Calidad y gates](calidad-y-gates.md) y [Operación](operacion.md).

Esta tabla enumera archivos y comandos presentes en el checkout. Los conteos corresponden a los patrones indicados (la metaprueba histórica `tests/unit/docs-v4-pruebas.test.ts` que los recalculaba se retiró en el commit `1899fde1` por doctrina de no vigilar documentos); no cuentan casos ejecutados ni equivalen a un resultado PASS. Las categorías se pueden solapar.

## Laboratorio para exploración manual

`scripts/qa-lab.sh up <nombre>` reserva un cupo en `lab`, `lab2` o `lab3` y mantiene PostgreSQL migrado, gateway, consola HTTPS, terminal-relay y un ordenador con ejecutor sobre un Docker dedicado. Imprime la URL accesible desde la torre y el correo `zz-canary-qa-<nombre>@example.test`. La contraseña sintética queda únicamente en `.delegados/v4/recibos/qa0-entorno-exploracion-1025/<nombre>/password`, con permisos 0600. El nombre admite letras minúsculas, números y guiones, empieza por letra y tiene hasta 20 caracteres. `CAUCE_QA_CONTEXT=lab2` permite elegir un contexto explícito.

Usa `scripts/qa-lab.sh status <nombre>` para comprobar la disponibilidad y `scripts/qa-lab.sh down <nombre>` para cerrar y verificar la retirada de sus recursos. Los recursos creados llevan el prefijo `zz-canary-qa-` y etiquetas de tarea e instancia; cada laboratorio usa un daemon independiente. En `lab2` y `lab3` se prepara un espejo temporal del código y las dependencias, sin archivos privados ni variables de entorno del operador. La consola usa una autoridad TLS efímera del laboratorio; el navegador debe confiar en esa autoridad para el recorrido.

El lanzador exige 8 GB libres en los sistemas de archivos de `/tmp` y `/var/lib/docker` de la VM. Reserva un cupo de E2E hasta cerrar el laboratorio; reintenta la reserva dieciocho veces, con pausas de diez segundos. En `lab2` y `lab3` mantiene un túnel SSH y anuncia una URL local. La sonda de `status` comprueba PostgreSQL, el ordenador y la presencia del relay, verificando la CA guardada en `ca.crt` junto al recibo.

El arranque reutiliza los fixtures de las pruebas reales y el SDK con un proveedor sintético: no necesita cuentas de proveedores. No ejecuta un recorrido de aceptación. El agente que lo explore debe guardar sus capturas y contrastar cada acción con PostgreSQL y el Docker dedicado. `ready.json` identifica el contenedor y la base sin publicar credenciales. El adaptador de contexto permite cargar los fixtures fuera de Vitest y rechaza registrar hooks de pruebas.

## Inventario por categoría

| ID | Categoría | Archivos | Ejecución | Cubre | No cubre todavía |
|---|---|---:|---|---|---|
| unitarias | Pruebas unitarias | 662 | `pnpm test:unit` | Código y contratos aislados; incluye las suites unitarias de paquetes y consola declaradas en el script. | No demuestra por sí sola efectos persistentes de extremo a extremo, runtime remoto ni comportamiento desplegado. |
| postgres | PostgreSQL real con Testcontainers | 229 | `pnpm test` | Pruebas con sufijos `-postgres.test.ts`, `.postgres.test.ts` y `.pg.test.ts`, distribuidas entre servicios, store, integración y e2e. No hay un runner único exclusivo para PostgreSQL. | No acredita todos los recorridos de navegador, autenticación real de proveedores ni comportamiento en producción. |
| navegador | E2E de navegador real | 26 | `pnpm test:e2e` | Archivos `tests/e2e/*real-browser*.test.*`; el runner ejecuta la carpeta completa, incluidos los recorridos V4 presentes en el checkout. El inventario por archivo y caso está en la sección «E2E de navegador real». | La matriz mantiene 23 pendientes, entre ellos ciclos completos de ordenadores, personas y contextos; el runtime físico en Docker local ya tiene su ciclo y falta repetirlo en server2. GOAL §10 aún marca pendiente cerrar estados y mejorar la retroalimentación de todas las vistas. |
| fallos | Simulacros de fallo y auxiliares | 10 | `pnpm test:integration && pnpm test:ops` | Archivos con prefijo `failure-drill` bajo `tests/integration` y `ops/tests`, más `test-fault*.sh`. | GOAL §10 mantiene pendientes pruebas de fallo con procesos reales; la matriz deja pendiente `context_git_concurrent_recovery` en navegador y despliegue. Estos simulacros no acreditan por sí solos recuperación en producción. |
| aislamiento | Adversariales y de aislamiento | 50 | `pnpm test:gateway-hardening && pnpm test:store-hardening && pnpm test:services` | Suites `tests/gateway-hardening`, `tests/store-hardening` y la prueba `services/gateway/src/security/route-isolation.postgres.test.ts`. | GOAL §1.3 mantiene pendiente la guardia P0 que enumera todas las rutas `/v3` y prueba IDs cruzados sin mutaciones, además de los efectos remotos entre empresas. |
| ops | Ops y Python | 172 | `pnpm test:ops` | Archivos descubiertos por `ops/tests/run-all.mjs`, incluidos casos Python y shell con sus requisitos de ejecución. | No sustituye las suites de servicios, las pruebas de navegador ni la verificación desplegada; el runner puede marcar casos como omitidos si faltan requisitos de host o Docker. |
| layout | Layout | 13 | `pnpm qa:layout` | Módulos ejecutables `.mjs` de `console/qa`; el gate renderiza rutas en Chromium y compara medidas con sus baselines. | GOAL §10 mantiene pendiente resolver en todas las vistas los estados vacíos, de carga y error con retroalimentación clara. |
| release | Gate de release | 1 | `scripts/release-gates.sh` | Por defecto, el gate que bloquea un despliegue: cuatro gates pnpm sin Docker ni navegadores (typecheck, lint, test:unit y empaquetado) en carriles paralelos, cada uno un checkout del mismo commit (`CAUCE_RELEASE_GATES_JOBS`). Con `CAUCE_RELEASE_GATES_NIVEL=completo` ejecuta además el barrido acotado de huérfanos y las suites de pila completa, como ejecución opcional que no bloquea. | Exige un árbol limpio y herramientas disponibles; no despliega ni comprueba el efecto vivo. El barrido no recorre el Docker compartido: solo `ops/tests/test_fleet_orphan_sweep.py` y `ops/tests/test_fleet_executor_container.py`. GOAL §10 todavía marca documentación y recorridos de aceptación como pendientes. |

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

Este inventario sustituye la cifra histórica «17 e2e de vistas V3 y un recorrido V4 de 12 pasos fuera del repo», que ningún recibo acredita. Lo verificable es lo versionado: los archivos `tests/e2e/*real-browser*.test.*` y sus casos `it(`. El recorrido V4 que estaba fuera del repo es hoy `tests/e2e/v4-console-real-browser.test.ts`, con 13 casos (la metaprueba `tests/unit/docs-v4-pruebas.test.ts` fue retirada). Contar un caso no equivale a un resultado PASS.

| Grupo | Archivos | Casos |
|---|---:|---:|
| V4 (`v4-*`) | 13 | 62 |
| V3 y V3.5 (resto) | 13 | 21 |

| Archivo V4 | Casos | Recorrido |
|---|---:|---|
| `tests/e2e/v4-company-admins-real-browser.test.ts` | 2 | Autoridad de empresa: dueños y administradores. |
| `tests/e2e/v4-console-real-browser.test.ts` | 13 | Recorrido V4 completo de la consola en Chromium y PostgreSQL. |
| `tests/e2e/v4-context-files-real-browser.test.ts` | 1 | Archivos de contexto. |
| `tests/e2e/v4-contexts-real-browser.test.ts` | 1 | Contextos y versiones. |
| `tests/e2e/v4-crud-matriz-real-browser.test.ts` | 9 | Matriz CRUD: ordenadores, cuentas, registro de agente y partes del plano. |
| `tests/e2e/v4-fleet-cycle-real-browser.test.ts` | 1 | Ciclo físico de un agente desde la web sobre un ordenador enrolado sin superadministrador y Docker local: alta, update de configuración y asignaciones, stop, contexto aplicado al iniciar con ACK, retiro y purga, con el contenedor leído tras cada paso y cero recursos al final. `CAUCE_FLEET_CYCLE_TARGET=server2` deja preparado el mismo recorrido. |
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
- La matriz CRUD mantiene 23 elementos pendientes. Incluye recorridos de navegador para ordenadores, personas, autoridad, runtime, contextos, harnesses, cuotas y oficina; el detalle verificable está en `docs/v4-matriz-crud.json` (las metapruebas `tests/unit/crud-matrix.test.ts` y `tests/unit/v4-matriz-crud.test.ts` fueron retiradas en el commit `4a9f2aee`).
- Los conteos reflejan archivos presentes, no ejecución de comandos ni evidencia de aceptación local o desplegada.
