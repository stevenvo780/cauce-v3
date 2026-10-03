# Perfiles nuevos redactados en Git

## Alcance y autoridad

Permitir aplicar contenido nuevo de los siete campos canónicos de un perfil ya
existente. La operación exige el permiso de control del PUT de perfil actual,
operador humano atribuido, motivo, vista previa completa y confirmación explícita.
El autor y committer Git no acreditan identidad, permisos ni aprobación. No se
aceptan permisos, actor, tenant, alias o rutas dentro del cuerpo del perfil.
La instancia y raíz del repositorio siguen siendo una vinculación inmutable del
servidor; el destino debe coincidir exactamente con el agente autorizado.

Este incremento depende de la aplicación revisada de instantáneas del diario.
No cambia su contrato v1, no crea otra autoridad de escritura y no instala ni
configura repositorios. No añade migraciones, memoria, skills, manuales ni transporte
Git. Conserva las restricciones del lector: OID completo, objetos sueltos,
sin symlinks, worktrees enlazados, rutas extra ni secretos reconocidos.

## Procedencia explícita

El manifiesto v1 sigue exigiendo `source_journal: {id, revision}` para cada agente.
Restaurar exige que identidad, operación y siete campos coincidan con el diario.
Nunca se degrada un origen v1 ausente o distinto a «contenido nuevo».

El manifiesto v2 declara contenido redactado en Git mediante `source_journal: null`
en cada agente. Omitir ese campo, mezclar una referencia al diario en v2, usar null
en v1 o introducir atributos de autoridad es un error. Ejemplo mínimo:

```json
{
  "schema_version": 2,
  "instance_id": "instancia-del-servidor",
  "agents": [{"tenant_id": "Steven", "alias": "helper", "source_journal": null}]
}
```

El único fichero del agente es `tenants/Steven/agents/helper/profile.json`, con
exactamente `purpose`, `role_summary`, `human_brief`, `responsibilities`,
`restrictions`, `tools` y `operating_rules`. La normalización y los límites son
los del perfil canónico. El manifiesto sólo selecciona datos dentro del ámbito
que ya autorizó el servidor; no otorga acceso por sí mismo.

Inspección devuelve `git_authored` sin consultar ni fabricar un diario de origen.
La confirmación y auditoría declaran `source_kind: git_authored`, sin
`source_journal_id` ni `source_revision`. Para v1 se conserva la forma anterior,
incluido su identificador de aplicación. Las formas mezcladas se rechazan.

## Flujo y cercas

1. Autorizar ámbito y persona antes de leer repositorio, perfil o arnés
2. Leer el commit inmutable; mostrar los siete valores vigentes/propuestos y la
   proyección nativa, distinguiendo restauración y contenido nuevo de Git
3. Conservar intactos MEMORY/HEARTBEAT existentes; nunca sembrarlos
4. Vincular motivo, actor autenticado, persona, instancia, destino, commit, árbol,
   huella del contenido, procedencia, revisión vigente, diario vigente y preflight
5. Confirmar mediante el mismo PUT; volver a autorizar, medir y comparar
6. Usar el CAS existente con bloqueo e identidad del diario vigente; guardar la
   procedencia en la auditoría de esa transacción, sin cuerpos ni autores Git
7. Mantener recibos idempotentes: no repetir el lote nativo al repetir la petición
8. Distinguir revisión guardada, escritura nativa y adopción acreditada por adaptador

La igualdad de revisión no permite cruzar una eliminación/recreación. Ni el recibo
histórico ni el éxito del lote demuestran adopción de sesión. Un resultado incierto
no dispara reintentos. El contenido ya vigente no genera otra revisión.

## Validación y límites operativos

Pruebas con objetos sueltos sintéticos, HTTP inyectado, dobles de arnés y modelo
de bloqueo. Cubren ambos orígenes, nulidad/mestizaje/omisión de procedencia,
confirmación alterada, cambio de origen, fuente alterada, diario vigente distinto,
revocación, ausencia de perfil, memoria preservada, rechazo nativo y recibos.
La consola prueba permiso, cierre, cancelación, respuestas tardías, confirmación,
lectura posterior de identidad exacta y estados de adopción honestos.

No acredita PostgreSQL real, navegador autenticado, arnés vivo ni adopción real.
Publicación retenida hasta los gates globales y la revisión independiente;
configuración del repositorio y aplicación real permanecen a cargo del dueño.
