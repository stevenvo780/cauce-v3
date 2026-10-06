# Instancias independientes

El instalador reutiliza la distribución de Cauce y el Compose canónico. Cada empresa
declara su descriptor, sus identidades iniciales y sus referencias a secretos propios.
El descriptor no contiene contraseñas ni concede autoridad a mensajes o políticas.

```bash
export CAUCE_INSTANCE_REGISTRY_ROOT=/ruta/al/registro-compartido
ops/instances/common/cauce-instance plan --instance-config /ruta/empresa/instance.json
ops/instances/common/cauce-instance install --instance-config /ruta/empresa/instance.json
ops/instances/common/cauce-instance status --instance-config /ruta/empresa/instance.json
ops/instances/common/cauce-instance update --instance-config /ruta/empresa/instance.json
```

`--descriptor` es un alias de `--instance-config`. Las interfaces Python están en
`instance.py`: `load_instance_descriptor(path)`, `plan_instance(descriptor)`,
`apply_instance(plan, update=False)` y `status_instance(descriptor)`.

El operador aprovisiona previamente un registro compartido del host: directorio de
root y del grupo autorizado, modo 3770, con `registry.lock` de root y del mismo grupo,
modo 0660. Todos los instaladores del host seleccionan ese mismo registro.
El instalador rechaza el uso implícito de un registro privado. Los registros de
reserva son legibles por el grupo, acreditan el UID declarado contra el propietario
físico del archivo abierto sin seguir enlaces, conservan su nonce y no permiten
adoptar o sobrescribir una instalación de otro operador. Estado usa un bloqueo de lectura.
La reserva inicial guarda el recibo previsto antes de crearlo; los reintentos
recuperan únicamente esa intención con el mismo UID, nonce y plan.

El esquema estricto está en `ops/schemas/instance-descriptor.schema.json`.
`release` exige imágenes por digest de manifiesto o ID de contenido SHA256;
`codeRoot` es la distribución compartida y sus montajes son de lectura.
`inventoryRoot/ops` contiene el snapshot derivado y los archivos generados.
`paths` declara config, state, bundles, pki, backups y locks sin solapamientos.
Los workspaces de integraciones opcionales también se reservan como recursos mutables.
Cauce puede instalarse sin integración ni repositorio del cliente.

`identityRefs.bootstrap` referencia un JSON con versión 1 y arrays de tenants,
rooms, memberships, agents y aclEdges. Los tenants siguen el formato del protocolo;
las salas admiten texto y Unicode de hasta 128 caracteres sin controles.
Los alias son únicos en el snapshot completo y pueden repetirse en otra instalación.
`identityRefs.secretFiles` relaciona las variables de secretos del Compose con archivos
propios de config o PKI. La lista requerida se expone en `planning.REQUIRED_SECRET_VARS`.
El operador provisiona esos archivos y los registros de autenticación
`config/identities/mtls_identities.json` y `token_hashes.json`.
El instalador no genera, rota ni copia credenciales.

El plan no escribe archivos. Su hash incluye las fuentes operativas y todos los
archivos montados de lectura desde la distribución, rechazando enlaces simbólicos. Instalar valida el plan exacto, reserva puertos,
rutas, proyecto Compose y nombres de contenedores, y acredita volúmenes/redes nuevos
con etiquetas, identidad y recibo. Un volumen, base o contenedor de adapter
desconocido se rechaza aunque parezca vacío. Conectar contenedores del cliente
preexistentes requiere una prueba de propiedad explícita; esa adopción no está disponible.

La limpieza de semillas exige almacenamiento recién creado y comparación exacta
con una base de referencia migrada desde las fuentes de la misma release.
La referencia usa una base con nonce propio, intención persistida antes de crearla
e identidad física comprobada. Sus migraciones y marca de propiedad se confirman
en la misma transacción. Cualquier base extra inesperada impide limpiar semillas.
La limpieza, el bootstrap y la marca de propiedad de la base se confirman juntos.
Un reintento acredita el mismo recibo y conserva cambios posteriores de la empresa.
Las escrituras generadas registran previamente ruta, hashes e identidad del archivo
temporal para recuperar cortes sin aceptar bytes ajenos.
Actualizar permite sustituir release/codeRoot con propiedad verificada; conserva
identidades, datos, rutas y reservas y nunca limpia semillas.

PostgreSQL es la fuente durable. El bootstrap se importa únicamente al crear la base;
el snapshot posterior se exporta desde ella. Se generan unidades y ejemplos de
configuración de adapters dentro del inventario propio, con namespace de instalación.
Estas unidades no se instalan ni activan. Instalar el núcleo tampoco aprovisiona
contenedores de adapters ni sus sesiones o perfiles de proveedor.

La evidencia de componentes no sustituye la aceptación viva de dos instalaciones,
PKI, fencing, adjuntos, terminales y operaciones independientes.
