# Instalaciones independientes por empresa

La distribución de Cauce se instala mediante un descriptor operativo explícito. La empresa aporta sus identidades, permisos, rutas, puertos y PKI. Las integraciones de supervisión se añaden mediante perfiles externos.

## Alcance y estado

La implementación vive en una rama propia y se está calificando con instalaciones reales. Los gates globales, la aceptación completa y la publicación siguen pendientes hasta que exista su evidencia. El instalador genera unidades de adaptadores; su activación y el aprovisionamiento de perfiles nativos pertenecen al operador.

## Descriptor y referencias

El esquema canónico es ops/schemas/instance-descriptor.schema.json. Son obligatorios:

- instanceId identifica la instalación y companyId la empresa. El tenant es otro identificador y se declara en el bootstrap.
- release fija las imágenes de runtime, consola, PostgreSQL, OTel y Prometheus mediante digest; una imagen local se fija mediante su ID SHA.
- codeRoot contiene una distribución de solo lectura, con Compose, migraciones y herramientas.
- inventoryRoot contiene el inventario derivado de esa empresa bajo ops/.
- paths separa configuración, estado, bundles, PKI, backups y locks. Ninguna raíz mutable puede solaparse con otra o con el código.
- compose.project y endpoints determinan los recursos y puertos propios. Se comprueban todos los puertos publicados de Compose antes de mutar.
- identityRefs.bootstrap referencia las identidades y ACL iniciales; secretFiles referencia archivos propios, sin incluir sus contenidos en el descriptor.
- integrations es opcional. Su configuración y sus workspaces quedan ligados a la instalación.

El bootstrap solo admite tenants, salas, memberships, agentes y ACL. Las salas admiten texto del protocolo, incluido Unicode; los tenants conservan el patrón canónico. Un alias puede repetirse entre instalaciones independientes; dentro de cada inventario debe ser inequívoco.

## Preparación

El operador prepara los archivos de identidad, claves y certificados propios; se exige TLS verificado hacia el PostgreSQL de la instalación. El instalador no copia sesiones, perfiles ni credenciales de proveedores de otra empresa. Tampoco adopta una base, un volumen o un contenedor existente por su nombre.

El host necesita un registro compartido de reservas, aprovisionado por su administrador: directorio propiedad de root, con grupo de operadores autorizado, setgid y sticky; archivo registry.lock del mismo propietario y grupo. Se selecciona mediante CAUCE_INSTANCE_REGISTRY_ROOT. El instalador conserva el UID del creador y el recibo de propiedad.

## Operación

    export CAUCE_INSTANCE_REGISTRY_ROOT=/ruta/al/registro-compartido
    python3 /ruta/distribucion/ops/instances/common/cauce-instance plan --instance-config /ruta/empresa/instance.json
    python3 /ruta/distribucion/ops/instances/common/cauce-instance install --instance-config /ruta/empresa/instance.json
    python3 /ruta/distribucion/ops/instances/common/cauce-instance status --instance-config /ruta/empresa/instance.json

plan valida y describe los recursos; no instala. install reserva el host, acredita recursos nuevos, migra la base propia y comprueba la baseline exacta antes de reemplazar las identidades iniciales. El bootstrap ocurre únicamente sobre almacenamiento nuevo acreditado y dentro de una transacción. Una base o un volumen desconocido, incluso vacío, provoca un rechazo.

La actualización conserva propietario, identidades y bootstrap. Solo permite cambiar release y codeRoot, mediante el comando explícito:

    python3 /ruta/distribucion/ops/instances/common/cauce-instance update --instance-config /ruta/empresa/instance.json

Cambiar empresa, raíces mutables, inventario, puertos o bootstrap exige otra instalación. El recibo y el registro permiten verificar y reintentar una transición interrumpida.

La CLI selecciona la instancia antes de resolver el alias:

    /ruta/distribucion/ops/cli/cauce --instance-config /ruta/empresa/instance.json operador estado
    /ruta/distribucion/ops/cli/cauce --instance-config /ruta/empresa/instance.json operador on

Los nombres de unidades, sockets y locks usan cauce-<instanceId>. CAUCE_INSTALLATION_ID identifica la instalación; CAUCE_INSTANCE_ID sigue identificando el consumidor durable y su lease. Los contenedores de adaptadores y sus workspaces no se comparten entre empresas. Las operaciones antiguas de aprovisionamiento de PKI se rechazan para una instancia seleccionada; esta usa sus referencias explícitas.

## Política y perfiles

La política agent_behavior_policy se aprueba en el editor durable existente: operador autenticado, permiso de control, CAS, auditoría y validación de destinos. El descriptor, el cuerpo de un mensaje y la prosa de un perfil no conceden autoridad.

Los clientes negocian agent_behavior_policy_v1 para recibir el contrato tipado. Los clientes anteriores conservan su wire. La política determina coordinación, escalación, recibos y aviso opcional; el gateway vuelve a comprobar el permiso vigente antes de materializar un efecto reservado.

La supervisión de proyectos vive bajo ops/instances/hospital/ como integración opcional. El perfil externo declara actores, tenant, sala, workspace, estado, trackers y cantidades. Los wrappers delegan plan, install, update y status al instalador común; una instalación sin esa integración no depende del perfil.

## Evidencia de cierre

Se conserva la salida de los gates y el recibo de aceptación con dos instalaciones, mismo alias y recursos distintos. La aceptación cubre entrega durable, ACK, recuperación, rechazo de autoridad cruzada y actualización de una instalación con la otra funcionando. Las pruebas de adjuntos y terminales se acreditan por separado; generar unidades no demuestra una sesión viva.
