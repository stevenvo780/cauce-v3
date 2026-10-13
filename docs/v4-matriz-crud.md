# Matriz CRUD verificable de Cauce V4

La fuente de datos es [`v4-matriz-crud.json`](v4-matriz-crud.json). El validador comprueba las operaciones declaradas frente a las rutas registradas, los controles de la consola y los nombres de prueba citados:

```sh
pnpm exec vitest run tests/unit/crud-matrix.test.ts
```

Las referencias E2E indican que el caso existe en el árbol; no afirman que se haya ejecutado ni que haya pasado. Los estados `covered`, `pending` y `not_applicable` se aplican a cada operación de la matriz, no a la aceptación completa de V4.

## Oficina

| Entidad | Operación | Evidencia de navegador |
|---|---|---|
| Salas | Crear y leer | Crea dos salas y las muestra en el plano y el campus. |
| Salas | Actualizar | Renombra una sala, asigna el agente y lo mueve a otra. |
| Salas | Eliminar | Explica el bloqueo de una sala ocupada y elimina la sala después de reasignar el agente. |
| Membresías | Crear y actualizar | Asigna el agente y lo mueve entre salas desde la UI. |
| Membresías | Leer | Relee la asignación tras iniciar sesión de nuevo y desde otra persona de la empresa. |
| Membresías | Eliminar | Comprueba que una sala ocupada no deje un agente huérfano. |

Casos: `tests/e2e/v4-office-real-browser.test.ts` — “crea dos salas desde la UI y las refleja en el plano editable y el campus”; “renombra la sala y asigna el agente allí antes de moverlo a otra sala”; “mantiene la sala y asignación tras re-login, y las comparte con otra persona de la empresa”; “la baja de una sala ocupada explica sus dependencias y no deja un agente huérfano”; “reasigna el agente desde la UI, elimina la sala vacía y conserva la asignación válida”. Estos casos no recorren editar o quitar partes del plano; `office_parts.U/D` siguen pendientes.

## Personas

`tests/e2e/v4-people-real-browser.test.ts` — “crea una persona operadora, aplica su rol, cambia a lector y revoca su acceso al desactivarla” cubre alta, lectura del inventario, cambio durable de rol y revocación al retirar; “una empresa distinta no lista a la persona y su edición directa recibe 404” comprueba aislamiento. `people.C/R` están cubiertas. `people.U` conserva pendiente la restauración desde navegador; `people.D` conserva pendiente la purga y la protección del último administrador.

## Contextos

`tests/e2e/v4-contexts-real-browser.test.ts` — “edita, rechaza secretos, restaura y aplica aislamiento entre personas y empresas” añade y edita un archivo, relee el historial durable, restaura una versión como otra nueva y comprueba aislamiento. También intenta aplicar la versión y recibe `503`, dejándola pendiente; no acredita adopción por el agente. `tests/e2e/v4-context-files-real-browser.test.ts` — “desde la ficha retira un archivo del contexto y lo recupera al restaurar” quita un archivo desde la ficha del agente, comprueba la versión nueva en el historial, la relee tras recargar y por la API, y restaura la versión anterior con el archivo. `context_versions.C`, `context_files.C/R/U/D` y `context_restore.U` están cubiertas. Siguen pendientes recuperar sincronización Git (`context_sync.U`) y un recibo de aplicación correlacionado (`context_application.U`).

## Entornos de cuota

`tests/e2e/v4-quota-environments-real-browser.test.ts` — “el dueño crea, edita y elimina su entorno con confirmación persistida” recorre las mutaciones y la relectura en PostgreSQL. El helper de la prueba finaliza operaciones mediante el repositorio con recibos de fixture; no ejecuta ni verifica un contenedor de proveedor real. Por eso el CRUD de metadatos queda documentado y siguen pendientes la ejecución física, autenticación, consulta y eliminación sin recursos huérfanos (`quota_environment_execution_browser`). La prueba de consola `tests/e2e/v4-console-real-browser.test.ts` — “entornos de cuotas: crear y editar rechazan entradas inválidas y aceptan las válidas” aporta además las validaciones de formulario.

## Consola V4

`tests/e2e/v4-console-real-browser.test.ts` aporta recorridos de empresa (“empresa: renombra la propia, crea otra con su dueño y rechaza entradas inválidas”; “retiro: B retira su empresa, se conserva el dato y su autoridad queda en none con 403 en lo protegido”), invitaciones de ordenador (“ordenadores: rechaza una invitación inválida o fuera de la partición de su empresa, entrega la válida una sola vez y la cancela”) y persistencia del plano (“plano: rechaza una parte sin nombre, guarda con CAS y persiste tras cerrar sesión y en un segundo contexto”). La invitación prueba `host_enrollments`, no el CRUD del ordenador; la autoridad empresarial positiva aún requiere asignación, cambio y revocación comprobados desde navegador.

## Pendientes conservados

Las razones completas permanecen en el JSON. Entre las filas que estos recorridos no cierran están: `people_crud_browser` (restauración, purga y último administrador), `host_crud_browser` (CRUD del ordenador), `company_admins_lifecycle_browser` (ciclo positivo de autoridad), `office_parts_lifecycle_browser` (edición y baja de partes), `quota_environment_execution_browser` (efecto físico y proveedor), `context_git_concurrent_recovery` (recuperación Git desde navegador) y `context_application_browser` (adopción confirmada por el agente).
