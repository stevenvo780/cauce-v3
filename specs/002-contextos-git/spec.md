# Contextos deseados versionados por instancia

## Problema y autoridades

El perfil canónico ya vive en PostgreSQL. Los manuales conservan texto externo,
las escrituras usan CAS y lotes atómicos, y la adopción requiere ACK de sesión.
Falta una fuente revisable de contenido deseado con versiones Git por instancia.
Git no sustituye la BD, la autorización ni la evidencia del runtime.

## Modelo

Un repositorio dedicado contiene `context.json` con `schema_version: 1`,
`instance_id` y `agents`. Cada agente declara `tenant_id`, `alias` y
`source_journal: {id, revision}` como procedencia del perfil exportado.
Su perfil vive en `tenants/<tenant_id>/agents/<alias>/profile.json` y conserva
los siete campos de `AgentProfile`, sin identidad duplicada ni permisos.
El ID inmutable del diario distingue alias eliminados y recreados: la revisión
puede volver a uno. La procedencia declarada en Git no se considera acreditada
por PostgreSQL hasta verificar ID, instancia, tenant, alias y contenido allí.
Este formato rechaza cuerpos de manuales, skills, scripts y configuración.
El diario de manuales guarda solo SHA/bytes: retener sus cuerpos en Git sería
una nueva decisión de retención/divulgación que requiere aprobación explícita.

La memoria mutable queda fuera: notas automáticas de Claude, memorias de Codex,
`MEMORY.md`, `memory/`, diarios y estado de sesiones de OpenClaw. No se importan
credenciales ni configuración privada. Archivos inesperados cierran la lectura.
En OpenClaw, `MEMORY.md` y `HEARTBEAT.md` pertenecen al agente: solo se siembran
si faltan y no forman parte de las huellas estables del perfil. Este repositorio
no los captura, restaura ni convierte en contenido autorado por defecto.
La detección de secretos reutiliza las reglas existentes y rechaza coincidencias;
no garantiza reconocer todos los secretos ni sustituye revisión humana.
Se comprueban bytes crudos y valores JSON decodificados con el detector profundo;
un escaneo incompleto o claves duplicadas, incluidas equivalencias escapadas,
cierran la admisión. La serialización JSON no sustituye el escaneo de valores.
Las carpetas y ramas Git no aíslan tenants: quien lee el repositorio puede leer
su historial completo. Un repo compartido exige lectores autorizados para TODO
lo retenido, o almacenamiento separado por frontera de acceso. La selección
del inspector limita su respuesta, no los permisos de Git. No se publica nada
sin revisar expresamente contenido, destinatarios y alcance de la exportación.

## Primer incremento verificable

Inspector local de solo lectura, sin endpoint ni conexión remota. Recibe raíz
local confiable, commit completo y ámbito exacto instancia/tenant/agente. Devuelve
perfil normalizado, procedencia no verificada y hashes. Puede comparar otro
commit explícito: perfil anterior/posterior y cambios de procedencia, incluso
cuando el texto es idéntico y la revisión volvió a uno, sin mezclar agentes.
No expone autores, mensajes Git ni contenido de otros tenants. Rechaza referencias
ambiguas, enlaces, submódulos, objetos grandes, rutas extra y UTF-8 inválido.
No ejecuta Git ni programas: consume objetos sueltos mediante lectura acotada,
descompresión limitada y verificación de su OID. No interpreta configuración,
atributos, hooks ni submódulos. Rechaza metadatos de almacenamiento alternativo,
packs y worktrees enlazados. Solo admite repositorios con `.git/objects` local.
Esta versión NO observa HEAD, índice ni archivos de trabajo: siempre devuelve
`sourceState: not_observed`. No acredita limpieza ni detecta ediciones repetidas,
atajos del índice, archivos ignorados/no rastreados o cambios durante la lectura.
La verificación de objetos comprometidos no elimina esa brecha ni autoriza aplicar.
El preparador de exportación recibe un `ProfileRevisionEntry` y extrae solo los
siete campos autorados. Rechaza snapshots borrados o de otro ámbito y secretos
reconocidos. Devuelve bytes y entrada de manifiesto en estado
`content_review_required`; no escribe archivos ni crea commits/repositorios.

## Aplicación y migración posteriores

La UI distinguirá fuente deseada, revisión durable, escritura acreditada,
adopción de sesión, deriva y soporte del arnés. `ContextApplyState` conserva
su vocabulario; la inspección no fabrica una revisión durable ni estado applied.
La futura vinculación autorizada guardará en PostgreSQL la identidad del repo,
commit/árbol, ID del diario, revisión y comprobantes por documento/generación.
El ámbito recibido por el inspector no concede acceso: el futuro endpoint debe
derivarlo del operador autorizado y de una vinculación de instancia confiable.
Antes de crear commits, el futuro exportador revisará expresamente la propuesta;
el texto libre del perfil puede contener secretos que el detector no reconoce.
No elimina secretos de un historial previo ni permite publicarlo automáticamente.

Migración: inventario medido → vista previa por agente/arnés → selección expresa
de contenido autorado → revisión de secretos → importación con CAS. Conservar
el exterior de bloques gestionados; memoria y archivos desconocidos permanecen
fuera. Ninguna limpieza automática ni exportación recursiva del HOME.
Aplicación: conservar PUT canónico con motivo humano, auditoría antes de efectos,
`expected_revision`, `prepareAgentProfileRuntime`, bloqueo y reconciliación.
Verificar de nuevo identidad, ID del diario, revisión, generación y hashes externos
inmediatamente antes del lote. Una escritura incierta exige nueva medición.
La integración debe cercar atómicamente la identidad vigente del diario/ciclo
de vida además de `expected_revision`; ese número solo no detecta recreación.
Un reinicio/restauración de la BD exige revisar la vinculación de instancia y
su procedencia, no reutilizar ciegamente identificadores de un almacén anterior.
Rollback: elegir commit anterior y crear una revisión nueva con las mismas
precondiciones; jamás resetear un runtime ni restaurar memoria. La operación
multiagente no será atómica; cada agente debe mostrar su resultado independiente.
Las skills todavía no tienen instalador gobernado. Requieren ampliar primero el
contrato cerrado de rutas/capacidades y la evidencia de carga; no se enviarán al
escritor de manuales ni se presumirá que el lote actual las admite.

## Diseño de la consola, pendiente de integración

La instancia muestra su repo vinculado, commit deseado y diferencias pendientes.
La selección tenant/agente conserva los permisos existentes. Dentro del agente:
perfil canónico y sus versiones Git; instrucciones por arnés medido e inventario
de memoria continúan con su contrato actual. Skills sin editor/sincronización
hasta diseñar inventario, retención y carga. Memoria nunca ofrece «guardar en Git».
Cada instrucción muestra origen, ámbito y precedencia nativa; la vista efectiva
compone bloques gestionados con exterior conservado sin ofrecer editar permisos.
OpenCode muestra «sin adaptador de aplicación»; no se confunde con OpenClaw.
La revisión enseña antes/después, commit base y alcance exacto antes de aplicar.
El historial distingue versión Git, revisión durable, archivos acreditados y
adopción de sesión. Revertir crea una propuesta nueva; si existe deriva externa,
la UI exige volver a medir y conciliar antes de cualquier escritura.

## Criterios de aceptación

- Repositorios Git efímeros sintéticos prueban objetos, comparación y ausencia de
  afirmaciones de limpieza; ninguna prueba construye programas de explotación.
- La respuesta del inspector solo contiene el ámbito solicitado; no promete ACL Git.
- Exportación y comparación conservan el ID del diario incluso con revisión repetida.
- Memoria, configuración privada, secretos reconocidos y archivos no declarados
  impiden admitir la instantánea; nunca se devuelven en errores.
- El inspector no escribe, aplica, instala skills, cambia permisos ni crea remotos.
- Pruebas existentes de perfil, manuales y reconciliación conservan su contrato.
