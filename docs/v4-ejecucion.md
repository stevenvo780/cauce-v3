# Relevo de Cauce V4 a Claude

La ejecución autónoma queda **pausada por petición del dueño**. El goal y el seguimiento `recuperar-cauce-v4` están pausados; se conserva su intervalo de treinta minutos. Los autores y revisores cerraron sus procesos. Este cierre guarda código y documentación para publicarlos en Git; no continúa el despliegue ni las migraciones.

**Avance estimado: 55 %; pendiente: 45 %.** Es una estimación de trabajo, no un porcentaje de aceptación: los **97 requisitos siguen `unverified`** y ninguno de los nueve criterios finales está completamente acreditado. La especificación vinculante es [el objetivo del dueño](v4-objetivo-del-dueno.md); la [matriz local](v4-matriz-local.md) separa implementación, evidencia local y aceptación publicada.

## Dónde retomar

- Checkout principal aislado R: `directorio privado de trabajo del operador/worktrees/cauce-v4-complete/cauce-v3`, rama `codex/v4-complete`.
- Checkout de reparaciones F: `directorio privado de trabajo del operador/worktrees/cauce-v4-gate-fixes/cauce-v3`, rama `codex/v4-gate-fixes`. Aquí se guarda la última reparación de cobertura y este relevo.
- Estado privado S: `directorio de estado del operador/cauce-v3/v4-complete-20261011`. Contiene `OBJETIVO.md`, `aceptacion.json`, `checkpoint.json`, recibos, planes y respaldos. No subir este directorio completo a Git.
- Informes de sectores: `R/.superpowers/sdd/v4-ejecucion/`, ignorados por Git. Son evidencia histórica; prevalecen el checkpoint de relevo y los recibos finales.
- PR de referencia: [151](https://github.com/stevenvo780/cauce-v3/pull/151). Consultar las referencias remotas y el recibo privado de publicación antes de asumir qué SHA está en `main` o `dev`.

Antes de repetir una acción, comprobar Git, recibos, PID con su tiempo de inicio, locks, trabajos cloud y recursos físicos existentes. No duplicar ensayos, backups, importaciones ni envíos cuyo resultado sea desconocido. El checkout compartido `/datos/workspaces/personal/cauce-v3` permanece fuera del área de escritura de este relevo.

## Implementación guardada

| Frente | Trabajo incorporado | Lo que todavía necesita demostrar |
|---|---|---|
| Empresas y autoridad | Registro, empresa/dueño, membresías, permisos, revocación, recursos por empresa y operaciones durables | Humanizar/Praxis reales, registro/enrolamiento publicados y rechazo entre empresas |
| Cuotas | Parsers y snapshot por cuenta/límite/modelo, cuentas compartidas, freshness, unknown/error/stale, pausas y Mis cuotas | Autenticación y consulta actuales desde la máquina propietaria; ciclo Docker y actualización de CLI desde la web |
| Oficina y consola | Salas/asignaciones dinámicas, layout persistente, detalle/contextos/cuotas, estados visuales y navegación móvil | Persistencia entre navegadores y efectos remotos con recursos reales |
| Contextos y harnesses | Estructura de espacios, historial/diff/restore, CAS/outbox, broker Git y helpers de perfiles | Contextos productivos en GitHub, todas las vías de edición y adopción/consumo por agentes reales |
| Operación | CLI de plataforma, transferencia idempotente, backups/restore, contratos de terminal/Telegram y herramientas de verificación | Export/import real de Praxis, espacios grandes completos, operaciones físicas y proveedor actual |

Las [guías CLI](v4-cli.md), [espacios/contextos](v4-archivos-contextos.md), [consola](v4-consola.md) y [autenticación runtime](v4-autenticacion-runtime.md) describen contratos y límites. El comando de cuotas del dueño es literalmente **`coutas`**. Mantener cuentas y perfiles separados; una cuenta compartida tiene una cuota compartida, no saldos independientes por agente.

## Evidencia local y límites

El último candidato anterior al cierre, `533d245e2bd2c39e10399e6807ddda753b1d336a`, tiene mínimos en verde y una matriz exacta de **12 PASS / 0 FAIL**. Sus recibos son `S/minimum-F-533d245e/receipt.json` y `S/final-matrix-533d245e-exact/receipt.json`. Estos resultados pertenecen a ese candidato, no al commit posterior de relevo.

Su release terminó **exit 1 en cobertura**, después de seis etapas aprobadas. La consola medía 87,16 % frente al piso 94,69 %, con tolerancia de 0,20 puntos. No alcanzó construcción/empaquetado runtime ni produjo una imagen de release aprobada. Se preserva el negativo en `S/release-gates-20261012T162919Z/receipt.json` y su revisión en `S/release-533d-independent-review/receipt.json`.

La reparación final añade pruebas de render Canvas2D nativo, entrada DOM y chat, con `@napi-rs/canvas` fijado como dependencia de desarrollo. Las revisiones cruzadas cerraron sin hallazgos; focales **32/32 y 26/26**, lint estricto focal en verde. La medición completa posterior de consola pasó **286 suites / 2.966 pruebas**, exit 0, **35.929/37.809 líneas: 95,02 %**. Recibos: `S/coverage-office-console-diagnostic-v2/` y `S/coverage-office-independent-review/`. Baseline, exclusiones y controles productivos no se rebajaron. Esta medición es local de consola; el gate global del commit de entrega y sus códigos quedan en el recibo privado de cierre. El release final sigue pendiente aunque los gates de integración pasen.

La nueva migración aditiva 065 y su down reparan el replay de ACL tras restore sin ACL. Los SQL anteriores permanecieron intactos. El clon `cauce-v4-restore-20261011` está en **064, ledger 37**: cuando exista release e imagen aprobados, aplicar **sólo 065 → ledger 38** y verificar el replay; no reimportar el dump. Los planes privados de restore/export/stage siguen vinculados a 533d y necesitan una nueva vinculación revisada al SHA final.

El respaldo predeploy cerró aprobado: seis artefactos, **250.950.042 bytes**, hashes iguales entre origen y destino y restore real sin red exterior. Evidencia: `S/backup-predeploy-run-20261012T170921Z/`. Destino vigente: `stev@100.64.0.1:directorio del operador/cauce-v3-respaldo/offsite/db`; el NAS anterior está lleno. No equivale a un snapshot global de todos los espacios vivos.

El controlador privado R4 recupera únicamente el prefijo de holds propios del esquema baseline antes de migración; revisión independiente de **22 casos del autor + 12 adversariales**. Evidencia: `S/controller-partial-hold-recovery-r4-independent-review/`. No habilita el wiring V2 ni una congelación global; no copiar sus hardcodes como implementación productiva.

El observador USER R3 tiene revisión de transporte y un ensayo físico único de contenedor/unidad propios con **4/4 observaciones pre/post**, exit 0 y limpieza registrada. Evidencia: `S/observer-own-resource-drill-r3/`. Su revisión final quedó **INCOMPLETE_STOPPED_BY_USER**, sin APPROVE; confirmó 21/21 lecturas de ausencia, pero quedan cotejos. `S/observer-own-resource-drill-r3-independent-review/PENDING.md` los enumera; su script de auditoría es un borrador con sintaxis pendiente. El ensayo no acredita parada de escritores de la flota.

La siguiente vinculación de fuentes quedó como borrador sin ejecutar en `S/next-source-repin-office-blueprint/`. La cadena anterior válida es `S/continue-release-after-matrix-533d245e.py`; la genérica permanece vinculada a un candidato más antiguo. No reutilizar identidades, GREEN, IID ni cantidades de otra fuente.

## Qué falta, en orden

1. Comprobar el commit publicado y el recibo de cierre. Conservar negativos históricos. Pasar los gates de release aplicables al nuevo SHA; construir/verificar imagen inmutable y empaquetado con usuario normal.
2. Revisar y terminar observador/controlador físico, wiring V2 y freeze de escritores; preservar la recuperación ante respuesta perdida y verificar la nueva vinculación de planes. Completar restore/export/stage en el clon existente.
3. Resolver las asignaciones humanas todavía pendientes: cuenta/modelo/pagador de Gaia/Hegel/Hades/Argos y dueño/recursos de Praxis. La pregunta ya está planteada; no elegir otra cuenta por un fallo ni copiar autenticaciones.
4. Desplegar el candidato verificado con respaldo y reversión. Migrar Gaia, Hegel, Hades y Argos a servidores locales medidos; verificar identidad, datos, permisos, comunicación, terminal, cuotas y contexto antes de liberar origen y medir el ahorro de VPS.
5. Recorrer los nueve criterios y los 97 requisitos con evidencia publicada: empresas/registro/aislamiento, CRUD remoto, gestión distribuida, cuotas/Mis cuotas, oficina/harnesses, archivos/contextos, backup/recuperación, pruebas y documentación final. Corregir y repetir los flujos afectados.

Todavía no hay despliegue V4 ni migración física de esos cuatro agentes. Las cuentas reales, los efectos distribuidos y la aceptación publicada siguen pendientes. Un registro, ACK, health, mock o prueba focal no cierra esos requisitos. La limpieza de este relevo consolida la cronología repetida; se conservan objetivos, matrices, contratos y runbooks con consumidores. Git guarda el contenido anterior.
