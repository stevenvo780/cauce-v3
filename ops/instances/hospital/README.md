# Integración opcional de proyecto

Hospital conserva sus datos de ejemplo en `project-profile.json`. El supervisor,
la lectura de evidencias y la publicación consumen ese contrato; otro proyecto
puede declarar tenant, sala, participantes, destinos, contenedor, workspace,
trackers y cantidades distintas sin cambiar código.

La instalación utiliza exclusivamente el instalador común:

```bash
ops/instances/hospital/install.sh plan --descriptor /ruta/instancia.json
ops/instances/hospital/install.sh install --descriptor /ruta/instancia.json
ops/instances/hospital/install.sh update --descriptor /ruta/instancia.json
ops/instances/hospital/install.sh status --descriptor /ruta/instancia.json
```

`bootstrap-core.sh` y `provision-agents.sh` son entradas compatibles que exigen
los mismos argumentos y delegan al mismo instalador. Ya no ejecutan despliegues,
SQL de Hospital, importación de agentes, cambios de propietarios ni instalación
de temporizadores. El bootstrap de almacenamiento y sus recibos son del común.
La inicialización nueva usa exclusivamente los datos del descriptor común y
las políticas durables autorizadas. El perfil JSON conserva datos de Hospital;
no ejecuta semillas históricas ni scripts de transición de identidades.

## Configuración de supervisión

El descriptor puede incluir `integrations.supervision` con `config` y `workspace`.
La presencia de esa entrada exige validar el perfil antes de instalar.
La configuración habilitada debe contener `project_profile_file`
y `project_profile_sha256`, o `project_profile` y su huella. El archivo externo
es legible, regular, sin symlinks, de root y sin escritura de grupo u otros.
La configuración existente sin perfil explícito conserva el ejemplo Hospital;
la instalación nueva exige perfil explícito para habilitar la integración.

La huella se calcula sobre JSON canónico: claves ordenadas, UTF-8, sin escapes
ASCII y separadores `,` y `:`. Cambiar el perfil requiere recalcularla y revisar
sus permisos; el hash declara contenido, no concede permisos de Cauce.
El estado conserva la huella y rechaza cambiar de proyecto sobre un estado ajeno.

El perfil declara `workspace`, `actor_workspace`, `actor_container`, usuario y
grupo sin privilegios; `tenant_id`, `room_id`, `supervisor_alias`,
`recipient_alias`, `participants`; contenedor y usuario/base PostgreSQL;
`issue_count`, `roadmap_count`, prioridad de criterios y texto del objetivo;
`acceptance_root`, origen humano confiable, rutas de configuración/estado y
`notification`. El aviso puede desactivarse; `egress_handle` referencia la política
durable autorizada, sin crear autorización desde el perfil.

Los trackers y artefactos de configuración usan rutas relativas confinadas al
workspace. Los controles, estado y recibos viven fuera del workspace y dentro de
la raíz de estado de la instalación cuando se utiliza el descriptor. Las
credenciales TLS siguen siendo referencias a archivos y no valores del perfil.
El proceso mecánico conserva controles de propietario root y ejecuta Git en el
contenedor del actor con UID/GID no privilegiados.

Para funcionar sin publicación, declarar `preview: null`, omitir `preview_root`,
usar `preview_files: {}` y dejar `auto_publish_synthetic_preview` apagado. Sin
entrada de integración, instalar Cauce no requiere repositorio de proyecto.

Para habilitar publicación, el perfil declara destino, servicio, unidad,
endpoint HTTP local, archivos públicos, fuentes requeridas y entrada del servidor.
La configuración debe coincidir con esos valores. Se conservan gates, revisión
visual independiente, timeout, lock del controlador, control de actividad,
verificación de fuentes antes/después, servicio sin privilegios y rollback.
No se instala ni habilita el servicio automáticamente desde este perfil.

Distribuir `project-profile.py` y `project-profile.json` junto a los helpers
`praxis-supervision*.py`; `praxis-proof.py` ya exige workspace y artefactos en su
CLI. Los archivos `.service`/`.timer` existentes son ejemplos específicos de
Hospital: una instalación nueva debe generar unidades propias y revisarlas
antes de activarlas. Esta carpeta no instala ni activa unidades productivas.

## Verificación

```bash
python3 -m unittest discover -s ops/tests -p 'test_praxis*.py'
python3 -m unittest discover -s ops/tests -p test_hospital_instance.py
```

Las pruebas cubren otro proyecto con 38 incidencias y 217 criterios, contenedor
y ámbito distintos, ausencia de preview, publicación con perfil declarado,
configuración alterada, rutas inseguras, avisos y reservas fuera de ámbito,
y conservación del progreso mientras se solicita revisión visual acotada.
Los tests con comandos simulados no acreditan instalación, PKI o publicación
contra un sistema vivo; esa aceptación corresponde a los recursos desechables
del instalador común y a la revisión independiente del integrador.
