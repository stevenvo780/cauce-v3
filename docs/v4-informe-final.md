# Informe final de Cauce V4

**Estado: V4 no está terminada.** Ninguno de los nueve criterios de cierre de [`GOAL.md`](../GOAL.md) §12 se cumple entero. Este informe separa tres niveles: lo implementado, lo probado en local y lo verificado en el despliegue. No presenta como cerrado nada que siga abierto. Cada marca sale de `GOAL.md`; aquí se resume con su evidencia.

Los niveles son los de `GOAL.md`:

- **Implementado** (`[código]`): el código y sus pruebas focales existen en el árbol.
- **Probado en local** (`[local real]`): se ejecutó con PostgreSQL, Docker, Git o Chromium reales.
- **Verificado en el despliegue** (`[desplegado]`): comprobado en producción y registrado en `deploy/HISTORIAL.md`.

## Versión desplegada

| Dato | Valor | Fuente |
|---|---|---|
| Commit | `87c7eece` (`main` = `dev`) | filas `20261013T092959Z` y `20261013T103436Z` de `deploy/HISTORIAL.md` |
| Runtime | `sha256:4b8a957d3cfe281bff47183197ceffd5f48342ebd0c6a0dfa54b7ae1c205060c` | misma fila |
| Consola | `sha256:05fcc0d2c6e8d9a80fcd5d5099d61128f0571b5b9f7f6181340206c974b0ed78` | misma fila |
| Esquema | 079: 22 migraciones (058→079) en una transacción tras un backup fresco | misma fila |
| Controlador de flota | `87c7eece`, 145 pines, ningún contenedor que migrar | fila `20261013T103436Z` |
| Enclave de autoridad firmada | instalado: socket root:1000 `0660`, emisor listo, otros uid rechazados | fila `20261013T103436Z` |

El recibo de gates de `87c7eece` es secuencial y tiene nueve comandos con `exit` 0. Es anterior a la incorporación del barrido de huérfanos como paso del gate, de modo que ese candidato no lo ejecutó. Lo integrado en la rama después de `87c7eece` no está desplegado.

## Entornos comprobados

| Entorno | Qué se comprobó | Nivel |
|---|---|---|
| Host de desarrollo | Matriz `pnpm test` 12/12, cobertura, testcontainers, `qa:layout` en Chromium, empaquetado del runtime en Docker, `ops:validate` y `arch:validate` sobre `87c7eece`; ensayo de migraciones sobre el dump de producción | probado en local |
| VPS central | `deploy.sh` completo, humo, controlador de flota y enclave | verificado en el despliegue, solo en lo que registra HISTORIAL |
| Hospital (Praxis) | Sigue con código que no está en V4 (`GOAL.md` §0) | sin V4 |
| server1 y server2 | Ningún agente migrado (`GOAL.md` §5) | nada verificado |

## Ubicación de los agentes

No se ha migrado ningún agente. Gaia, Hegel, Hades y Argos siguen en la VPS principal y los agentes de Praxis siguen en el hospital. Tras el despliegue de `87c7eece`, el humo registró la flota de la VPS con 14/14. De los diez requisitos de `GOAL.md` §5 solo está cumplido uno: la relocalización entre hosts, probada en local con PostgreSQL.

## Resultado de las pruebas

Gate de `87c7eece` (recibo secuencial, 9/9 con `exit` 0):

| Comando | Duración |
|---|---|
| `pnpm typecheck` | 26 s |
| `pnpm lint` | 171 s |
| `pnpm test` | 5 694 s |
| `pnpm coverage:ratchet` | 4 336 s |
| `pnpm qa:testcontainers` | 808 s |
| `pnpm qa:layout` | 196 s |
| `pnpm qa:runtime-packaging` | 39 s |
| `pnpm ops:validate` | 446 s |
| `pnpm arch:validate` | 1 s |

- **Matriz `pnpm test`**: 12/12 suites en verde. Pruebas ejecutadas: `test:unit` 7 590, `test:services` 3 915, `test:runtime-role` 3 967, `test:store-hardening` 2 148, `test:gateway-hardening` 248, `test:e2e` 182, `test:terminal-pty` 134, `test:integration` 85, y `test:container-supervisor` y `test:container-cutover` una cada una. `test:pty` y `test:ops` imprimen su propio recuento.
- **Cobertura de líneas**: 94,50 % fusionada (97 210 de 102 869). La consola tiene 95,41 % y su base es 94,69 %, así que el mínimo del trinquete es 94,49 %. `adapter-sdk` tiene 92,12 %. Ningún paquete bajó.
- **Gate paralelo**: [`scripts/release-gates.sh`](../scripts/release-gates.sh) reparte los nueve gates en carriles paralelos, cada uno un checkout del mismo commit. Ya pasó sus pruebas unitarias y un humo con worktrees reales. Todavía no ha certificado ningún candidato real.
- **Pendiente**: `typecheck`, `lint` y `test:unit` sobre el HEAD final con log durable; un gate completo del SHA final; el recorrido autenticado de los flujos esenciales en producción. El procedimiento está en el [ciclo del candidato](operacion.md#desplegar-v4).

## Los tres niveles por sección

Conteo de las casillas de `GOAL.md` en `edc40aff`. «Sin nivel» son casillas marcadas que no declaran nivel de evidencia.

| Sección de `GOAL.md` | Implementado | Probado en local | Desplegado | Sin nivel | Abiertas |
|---|---:|---:|---:|---:|---:|
| 1. Multiempresa, registro y aislamiento | 2 | 5 | 0 | 0 | 5 |
| 2. Credenciales y cuotas por agente | 4 | 3 | 0 | 1 | 2 |
| 3. Mis cuotas | 3 | 3 | 0 | 0 | 2 |
| 4. Oficina | 3 | 3 | 0 | 0 | 1 |
| 5. Migración a servidores locales | 0 | 1 | 0 | 0 | 9 |
| 6. Recursos, Docker y CLI | 2 | 4 | 0 | 0 | 4 |
| 7. Harnesses | 2 | 1 | 0 | 0 | 4 |
| 8. Archivos y contextos | 1 | 5 | 0 | 0 | 4 |
| 9. Auditoría y diagnóstico | 1 | 2 | 0 | 1 | 0 |
| 10. UI/UX, pruebas y documentación | 1 | 2 | 0 | 0 | 2 |
| 11. Ejecución y despliegue | 1 | 2 | 0 | 1 | 3 |
| Trabajo a portar | 2 | 2 | 0 | 1 | 2 |
| 12. Criterios de cierre (cláusulas) | 1 | 12 | 1 | 0 | 26 |
| Mejoras incorporadas | 0 | 0 | 0 | 10 | 6 |
| **Total** | **23** | **45** | **1** | **14** | **70** |

### Verificado en el despliegue

Solo lo que registran las filas de `87c7eece` en `deploy/HISTORIAL.md`:

- `deploy.sh` completo desde un clon limpio de `main` con recibo de gates verde, migraciones 058→079 aplicadas tras un backup fresco y esquema 079.
- Humo: nueve servicios sanos, flota 14/14, relay sin bucle y ruta de documentos con 401 sin sesión. El único rojo fue el bus, sin tráfico entre agentes de madrugada, y su verde depende de la primera entrega real.
- Semilla idempotente: el super-admin ya existía y la empresa Humanizar tiene dos owners.
- La IP de la consola es el proxy de confianza por defecto.
- Controlador de flota y enclave de autoridad firmada en `87c7eece`.

No se ha verificado en producción ningún flujo autenticado: registro, aislamiento contra el despliegue, cuotas, oficina, contextos, copias ni ordenadores.

### Probado en local, sin verificar en el despliegue

Lo principal:

- Registro público atómico y alta de empresa con owner.
- Aislamiento por familias de rutas y en la base.
- Enrolamiento de ordenadores con identidad firmada.
- CRUD con persistencia en Chromium y PostgreSQL de empresas, clientes, salas, membresías, cuentas, plano e invitaciones.
- Executor contra Docker real.
- «Mis cuotas» con cuentas sin agente y pines persistentes.
- Estados de cuota y cuenta compartida sin saldos independientes.
- Contextos con CAS, historial, diff, restauración, broker Git y transporte a GitHub con contenido sintético.
- Copias con sha256 y restauración en un entorno de prueba.

### Implementado, sin prueba real

Ejemplos:

- Recetas de cuota por harness.
- Ficha del agente con ventanas reales.
- Entorno endurecido de «Mis cuotas».
- Operaciones de flota con CAS y fencing.
- Descriptores de harness y sus comandos.
- Layout estándar de espacios.

## Lo que falta para cerrar, con su impacto

| Criterio de cierre | Qué falta | Impacto |
|---|---|---|
| 1. Multiempresa | Humanizar y Praxis con sus recursos reales; registro usable en producción; guardia adversarial en verde contra el despliegue | No se puede afirmar el aislamiento en producción |
| 2. CRUD | Agentes, ordenadores, personas, entornos de cuota y contextos con efectos remotos; barrido de huérfanos y matriz demostrados | Hay operaciones sin ciclo real comprobado |
| 3. Gestión distribuida | Un ordenador enrolado que ejecute agentes sin el administrador; los cuatro agentes y los de Praxis en servidores locales; terminal por CLI para la flota dinámica | La VPS no se libera y el hospital no se puede apagar |
| 4. Cuotas | Entornos Docker reales desde la web; cuotas por agente en su contenedor; contraste en producción | Las cifras de cuota no están contrastadas en producción |
| 5. Oficina y harnesses | e2e de altas y bajas; harnesses con operaciones reales | Sin prueba de punta a punta |
| 6. Contextos | Espacios reales en la estructura estándar; historial real en GitHub; turno real que aplique la versión; recuperación ensayada en producción | Sin uso real del versionado |
| 7. Copias | Descarga de una copia real desde la consola y su restauración | Recuperación no demostrada con datos reales |
| 8. Pruebas | `typecheck`, `lint` y `test:unit` sobre el HEAD final; gate y cobertura del SHA final; flujos esenciales en producción | El candidato final no está certificado |
| 9. Despliegue y documentación | Guía y operación completas en todas las áreas de §10, sin pendientes críticos | La documentación aún no cubre todo lo exigido |

## Cómo se mantiene este informe

Se actualiza en el paso 13 del [ciclo del candidato](operacion.md#desplegar-v4), con cada despliegue: versión, imágenes y esquema salen de la fila nueva de `deploy/HISTORIAL.md`, y la tabla por sección se vuelve a contar desde `GOAL.md`. Una marca solo cambia de nivel con la evidencia que exige `GOAL.md`.
