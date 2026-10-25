# Matriz CRUD verificable de Cauce V4

> Histórico: esta matriz y sus validadores describen un proceso de aceptación retirado; usa la [guía V4](v4-guia.md), [Calidad y gates](calidad-y-gates.md) y [Operación](operacion.md) para el uso y la comprobación actuales.

La fuente de datos es [`v4-matriz-crud.json`](v4-matriz-crud.json). El validador comprobaba históricamente las operaciones declaradas frente a las rutas registradas, los controles de la consola y los nombres de prueba citados (`tests/unit/crud-matrix.test.ts`, retirado en el commit `4a9f2aee` al eliminar metapruebas de documentación).

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

Casos: `tests/e2e/v4-office-real-browser.test.ts` — “crea dos salas desde la UI y las refleja en el plano editable y el campus”; “renombra la sala y asigna el agente allí antes de moverlo a otra sala”; “mantiene la sala y asignación tras re-login, y las comparte con otra persona de la empresa”; “la baja de una sala ocupada explica sus dependencias y no deja un agente huérfano”; “reasigna el agente desde la UI, elimina la sala vacía y conserva la asignación válida”. Editar y quitar partes del plano lo recorre el caso de `tests/e2e/v4-crud-matriz-real-browser.test.ts` citado abajo; `office_parts.U/D` están cubiertas.

## Personas

`tests/e2e/v4-people-real-browser.test.ts` cubre alta, lectura, cambio de rol, retiro y revocación de sesión, aislamiento entre empresas, restauración y purga de una persona retirada, con relectura durable tras recargar. El escenario del último owner exige elegir el espacio y la identidad habilitada del inventario; al degradarlo o retirarlo, la UI muestra el motivo y el gateway devuelve 409. La base conserva activo al único owner y la UI oculta “Purgar” para esa persona: el E2E envía esa petición desde el navegador autenticado, comprueba 409 y vuelve a leer el estado. `people.C/R/U/D` están cubiertas.

## Contextos

`tests/e2e/v4-contexts-real-browser.test.ts` — “edita, rechaza secretos, restaura y aplica aislamiento entre personas y empresas” añade y edita un archivo, relee el historial durable, restaura una versión como otra nueva y comprueba aislamiento. También intenta aplicar la versión y recibe `503`, dejándola pendiente; no acredita adopción por el agente. `tests/e2e/v4-context-files-real-browser.test.ts` — “desde la ficha retira un archivo del contexto y lo recupera al restaurar” quita un archivo desde la ficha del agente, comprueba la versión nueva en el historial, la relee tras recargar y por la API, y restaura la versión anterior con el archivo. `context_versions.C`, `context_files.C/R/U/D` y `context_restore.U` están cubiertas. Siguen pendientes recuperar sincronización Git (`context_sync.U`) y un recibo de aplicación correlacionado (`context_application.U`).

## Entornos de cuota

`tests/e2e/v4-quota-environments-real-browser.test.ts` — “el dueño crea, edita y elimina su entorno con confirmación persistida” recorre las mutaciones y la relectura en PostgreSQL. El helper de la prueba finaliza operaciones mediante el repositorio con recibos de fixture; no ejecuta ni verifica un contenedor de proveedor real. Por eso el CRUD de metadatos queda documentado y siguen pendientes la ejecución física, autenticación, consulta y eliminación sin recursos huérfanos (`quota_environment_execution_browser`). La prueba de consola `tests/e2e/v4-console-real-browser.test.ts` — “entornos de cuotas: crear y editar rechazan entradas inválidas y aceptan las válidas” aporta además las validaciones de formulario.

## Consola V4

`tests/e2e/v4-console-real-browser.test.ts` aporta recorridos de empresa (“empresa: renombra la propia, crea otra con su dueño y rechaza entradas inválidas”; “retiro: B retira su empresa, se conserva el dato y su autoridad queda en none con 403 en lo protegido”), invitaciones de ordenador (“ordenadores: rechaza una invitación inválida o fuera de la partición de su empresa, entrega la válida una sola vez y la cancela”) y persistencia del plano (“plano: rechaza una parte sin nombre, guarda con CAS y persiste tras cerrar sesión y en un segundo contexto”). La invitación prueba `host_enrollments`, no el CRUD del ordenador. La asignación de administrador de empresa y la revocación de su fila ya tienen recorrido de navegador; siguen pendientes el cambio owner/admin, que la UI del dueño no ofrece, y la revocación de la sesión de contraseña.

## Autoridad de empresa

`tests/e2e/v4-company-admins-real-browser.test.ts` — “asigna un administrador, rechaza degradar al último dueño y revoca su acceso en un segundo contexto” asigna un administrador, relee la fila tras recargar y desde un segundo contexto, rechaza guardar al único dueño como administrador y revoca al administrador. `company_admins.C/R` están cubiertas. `company_admins.U` sigue pendiente: la UI del dueño no ofrece el cambio a dueño. `company_admins.D` sigue pendiente: la fila del administrador desaparece y el segundo contexto pierde las acciones, pero la sesión de contraseña sigue autenticada como operador.

## Ordenadores, cuentas de proveedor, registro de agente y partes del plano

`tests/e2e/v4-crud-matriz-real-browser.test.ts` recorre en Chromium real contra gateway y PostgreSQL reales, con recursos `zz-canary-` y dos empresas: “ordenadores: registra con rechazos por identificador inválido y duplicado, y relee el alta en PostgreSQL”; “ordenadores: edita con versión, otra empresa no lo ve ni lo toca y la baja exige quitar sus agentes” (edición con CAS, versión obsoleta con 409, empresa ajena sin lectura y con 404 al editar y 403 al crear o borrar, y baja bloqueada mientras queden agentes); “cuentas de proveedor: alta desde el formulario con locator inválido y duplicado rechazados, y lectura sin credencial” (la proyección leída no expone `credential_ref` ni el locator); “cuentas de proveedor: edita y publica desde el formulario, otra empresa no la ve ni tras publicarla y el borrado exige confirmación exacta”; “registro de agente: alta desde el asistente con grupo inicial, lectura durable y duplicado rechazado”; “registro de agente: la baja con membresía da 409 y tras quitarla el registro desaparece de la UI y de PostgreSQL”; y “plano: crea, edita y quita una parte desde la UI con persistencia tras recarga y en un segundo navegador”. Con estos casos quedan cubiertas `hosts.C/U/D`, `provider_accounts.C/R/U/D`, `agents.C/D` (solo el registro; la ejecución física sigue en `agent_runtimes`) y `office_parts.U/D`.

## Pendientes conservados

Las razones completas permanecen en el JSON. Entre las filas que estos recorridos no cierran están: `company_admins_lifecycle_browser` (cambio owner/admin y revocación de sesión), `agent_runtime_lifecycle_browser` (creación, actualización y retirada física del runtime con respuesta correlacionada), `quota_environment_execution_browser` (efecto físico y proveedor), `context_git_concurrent_recovery` (recuperación Git desde navegador) y `context_application_browser` (adopción confirmada por el agente).
