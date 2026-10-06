# Especificación aprobada: Cauce independiente por empresa

Estado: aprobada por el dueño para implementación remota. Implementación y aceptación en curso; no integrada ni desplegada.
Base inspeccionada: `403004808f59f90bc386f859c1f1dc6db88d124c`.

## Resultado exigido

Instalar N instancias de Cauce para N empresas con la misma versión del producto y sin editar su código para cada empresa o proyecto. Hospital es una integración opcional definida por configuración. Cauce puede funcionar sin Hospital ni repositorio de proyecto asociado.

Cada instalación admite sus agentes, usuarios, tenants y salas. El mismo alias puede existir en instalaciones diferentes. El checkout local del dueño y la instalación publicada conservan su configuración y sus datos.

## Elección de arquitectura

| Alternativa | Consecuencia |
|---|---|
| Instancia independiente y descriptor validado por empresa — recomendada | Separación de datos, identidad y operación; una sola distribución de Cauce. |
| Bus compartido con varios tenants | Reutiliza el transporte multi-tenant, pero comparte la base y el dominio de fallo operativo. |
| Copia de código modificada para cada empresa | Acumula variantes y exige repetir correcciones y actualizaciones. |

Se adopta la primera. Una instancia puede contener varios tenants; el identificador de instancia y el tenant son conceptos distintos.

## Descriptor de instalación

Un documento versionado y validado declara identificador de instancia, proyecto Compose, release por digest, endpoints/puertos, directorios de configuración/estado/backups, referencias de PKI y secretos, y fuentes de inventario. Los secretos permanecen fuera del documento y del repositorio.

Contrato: `schemaVersion`, `instanceId` inmutable, `companyId`, `release`, `codeRoot`, `inventoryRoot`, `paths`, `compose`, `endpoints`, `identityRefs` e `integrations` opcional. Se rechazan campos desconocidos. La fuente inicial de agentes y permisos se importa a BD una sola vez; cambios posteriores usan las operaciones de alta/baja y exportación existentes.

`codeRoot` identifica la distribución versionada compartida, inmutable y de solo lectura; es la única excepción permitida a la prohibición de solapamiento de raíces. `inventoryRoot` identifica el inventario y los resultados generados propios. Ninguna instalación monta configuración o estado mutable de otra. La BD sigue siendo la fuente de agentes y permisos: el snapshot se exporta de ella y no constituye una segunda lista editable de agentes activos. El alias es único dentro de cada snapshot completo, aunque contenga varios tenants.

La validación admite tenants y salas arbitrarios que cumplan el contrato del protocolo. Rechaza identificadores inválidos, recursos incompatibles con otra instalación, rutas que se solapen, namespaces duplicados y puertos ocupados antes de crear o cambiar recursos.

Los valores predeterminados mantienen la instalación actual. El descriptor nuevo declara todos los recursos de una instalación nueva y el instalador no modifica unidades, archivos ni recursos de otra.

CLI y herramientas admiten selección explícita de instalación; un alias ambiguo sin selector se rechaza. Auxiliares de attach/estado, sockets y paneles tmux, sesiones y locks incorporan el namespace. La reserva coordinada de recursos del host evita que dos instalaciones concurrentes superen ambas el preflight y creen recursos en conflicto.

## Aislamiento operativo

Proyecto Compose, redes, volúmenes PostgreSQL/blobs, directorios de estado, backups, PKI, relay, sesiones, unidades systemd, temporizadores y locks pertenecen a la instancia. Los nombres se derivan de `cauce-<instanceId>` y del alias cuando corresponde; el modo actual sin descriptor conserva sus nombres. Los puertos se validan incluyendo binds comodín; registry y placement se declaran, sin asumir un puerto o host fijo.

Los agentes usan sus usuarios y contenedores declarados. La terminal/TUI queda limitada a ese contenedor y workspace. Dos empresas no comparten contenedor, perfil de proveedor, clave privada ni directorio de sesión por defecto.

Actualizar, detener, restaurar o eliminar una instancia actúa exclusivamente sobre recursos que el recibo de instalación acredita como suyos. La eliminación de datos o credenciales sigue siendo una operación explícita del dueño.

## Núcleo y políticas de proyecto

Se eliminan del SDK las condiciones por nombres concretos de empresa, sala, alias, humano o ruta. El workspace del harness procede de configuración validada; su control de acceso se conserva.

Se añade una política tipada, validada y versionada a la configuración durable de BD/gateway. El contrato actual del perfil es textual y `self_role` procede de prosa; ambos conservan ese significado. La extensión nueva exige operador, permiso de control, CAS y auditoría. El cuerpo del mensaje y el descriptor no conceden autoridad; el descriptor vincula la integración a la política aprobada.

Contrato mínimo estricto: `version: 1`, `revision`, ámbito `tenant_id/room_id/alias` derivado del consumidor, `coordination_mode` executor/coordinator, destinos opcionales `escalation.infrastructure/coordinator` como `RecipientSchema`, `fanin_receipt_mode` technical/human y aviso opcional con `issuer_alias`, `issuer_session_id` y `egress_handle`. `routing_targets` limita la selección visible pero no concede permiso: cada efecto vuelve a validar ACL y rol. El handle se valida en BD por tenant/alias del consumidor, handle y tipo de aviso; no se toma del destino de escalación. Una política inválida se rechaza, sin defaults por empresa.

El sobre de entrega incorpora `behavior_policy` únicamente para adapters que anuncien `agent_behavior_policy_v1`; los schemas estrictos y clientes anteriores conservan su wire. Sin política válida, el comportamiento es executor genérico, sin destinos implícitos y con aviso desactivado. Las configuraciones actuales se trasladan a datos explícitos revisados antes de retirar las condiciones por nombres.

Los avisos reservados conservan principal autenticado, tenant, sala, canal, sesión, payload cerrado, claim vigente, attempt/token/epoch, ACK e idempotencia, sin invocar el LLM. Su canal adapter, ausencia de origen externo y ámbito propio son invariantes que la política no puede relajar. El workspace de Muse permanece en configuración de despliegue validada, fuera de esta política de mensajes.

Hospital conserva sus objetivos, supervisión de evidencias y publicación de preview como integración externa opcional. Workspace, trackers, cantidades esperadas, participantes y destinos proceden de ese perfil. La publicación sigue apagada por defecto y exige sus gates.

## Inicialización y actualización de datos

El bootstrap nuevo recibe identidades y permisos propios del cliente. Crea almacenamiento nuevo con propiedad acreditada; un volumen o DB desconocidos preexistentes abortan aunque parezcan vacíos. Las semillas históricas centrales se retiran únicamente dentro de una transacción sobre esa base recién migrada, con baseline exacto y sin actividad ni usuarios/agentes del cliente.

Una base existente entra por actualización solo con recibo de propiedad verificado y nunca ejecuta esa limpieza. No se modifica una migración histórica. Un recibo liga identidad, recursos y hashes de cada etapa. Un reintento valida ese recibo y el mismo descriptor sin duplicar ni reiniciar recursos; drift o identidad incompatibles se rechazan antes de mutar o migrar.

## Prueba de aceptación obligatoria

1. Instalar A y B en el mismo host desechable con systemd y Docker, empresas, salas y workspaces diferentes y el mismo alias `operador`, utilizando la misma distribución. Su inventario no contiene agentes, ACL, miembros, certificados ni consumidores centrales activos.
2. Instalar una tercera configuración sin integración de proyecto y demostrar que el bus funciona.
3. Publicar, reclamar, confirmar y recuperar entregas de A y B con sus identidades y fencing; comprobar que no hay datos ni adjuntos cruzados.
4. Rechazar certificados reales, tokens, cookies, avisos, tickets y sesiones de la otra instancia; comprobar terminal/TUI dentro del contenedor y workspace propios. La autenticación simulada no sustituye esta prueba.
5. Reintentar el bootstrap sin duplicados; rechazar recursos solapados y una limpieza sobre una base existente.
6. Actualizar, detener y restaurar A mientras B procesa entregas y mantiene una terminal abierta. B conserva IDs de recursos, mounts, perfiles, sesiones y resultados; subir el mismo SHA de un adjunto a A/B mantiene autorización y descarga independientes, incluida restauración de blobs de A.
7. Comprobar que los valores actuales regeneran el inventario central sin cambios y que Hospital sigue funcionando mediante su perfil opcional.

Los recursos de prueba son aislados y se retiran al terminar. No se usan cuentas humanas ni la BD, unidades o contenedores productivos para esta demostración.

## Criterio de cierre

Revisión independiente del contrato y del código. La integración exige typecheck, lint y unitarios verdes; cualquier cambio operativo/flota exige validación Ops. La aceptación funcional requiere la prueba de aislamiento real y sus recibos. El despliegue exige además el gate completo y los gates de release sobre la revisión exacta. La especificación por sí sola no acredita que la instalación genérica funcione.
