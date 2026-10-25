# Plan de aplicación segura de contextos

Este plan no solicita ni ejecuta aplicaciones. La herramienta solo lee ficheros y recibos y devuelve digests; no acepta un modo de escritura.

## Simulación

Ejecutar desde la raíz del checkout, con un inventario de digests obtenido en solo lectura de la versión deseada actual:

```sh
pnpm exec tsx .delegados/v4/c7-aplicacion-segura-simular.ts --simular --inventario /ruta/inventario-digests.json
```

El inventario no contiene textos de los agentes, contraseñas ni sesiones. Ejemplo de estructura (sustituir el digest ficticio por el medido):

```json
{
  "captured_at": "2026-10-25T09:00:00Z",
  "agents": [{
    "company_id": "empresa",
    "tenant_id": "Steven",
    "alias": "zz-canary-contexto",
    "harness": "openclaw",
    "root": "/ruta/al/espacio",
    "environment": { "CAUCE_OPENCLAW_WORKSPACE": "/ruta/al/espacio/workspace" },
    "transport": { "ssh": "usuario@anfitrion", "container": "contenedor-existente" },
    "snapshot": { "version": 1, "files": [{
      "path": "context/MEMORY.md",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
    }] }
  }]
}
```

`snapshot.files` recoge las rutas y SHA-256 de los contenidos de la versión vigente, nunca un inventario histórico. Incluir todos sus ficheros; el programa reutiliza `nativeContextFileBindings`, la tabla de documentos del arnés y la resolución de directorios de la siembra del perfil. Las rutas sin asociación nativa se comparan dentro de la estructura estándar del espacio. Usar los directorios y el contenedor de la ubicación actual, no los de la siembra antigua. Las variables de `environment` se proporcionan expresamente: no se heredan perfiles del usuario que ejecuta la herramienta.

Omitir `container` para agentes nativos. Omitir todo `transport` permite medir un directorio local de pruebas. Las lecturas de contenedores requieren SSH explícito para evitar seleccionar el daemon equivocado. Se usa `docker exec` sobre un contenedor existente y Python aislado, sin crear recursos ni guardar contenidos. Si falta un acceso o una lectura no es segura, ese agente queda bloqueado y el proceso termina con código 2.

El resultado distingue `ingerir_antes_de_aplicar`, `aplicar_sin_cambiar_contenido`, `aplicar_cambio_del_servidor`, `conflicto_ambos_lados` y bloqueos. Cada fichero muestra el digest esperado, el observado y, si existe, el del recibo local. También identifica documentos nativos ausentes; crearlos implica un cambio de contenido. La ingesta se propone para cambios locales sobre la versión conocida; un recibo más viejo con cambios en ambos lados exige resolver el conflicto. Sin recibo, una versión posterior a la inicial con diferencias nativas exige recuperar una base comprobable.

Si no se puede acreditar la ubicación de un agente, incluirlo en el inventario como `{"tenant_id":"Steven","alias":"zz-canary-contexto","reason":"runtime_metadata_unavailable"}`. Aparecerá como bloqueado; no se descarta de los resultados. Un mapa nativo parcial, un espacio inexistente, una ruta insegura o un cambio gobernado también bloquean el plan. La simulación por digests no reemplaza la admisión del contenido durante la ingesta.

## Recorrido que ejecutará el dueño

1. Preparar el candidato revisado usando el procedimiento de release y sus gates. Antes de activar la pasarela nueva, mantener fuera de admisión a los agentes reales durante el ensayo mediante los controles canónicos del operador y comprobar que no quedan turnos activos. No modificar filas ni tiempos de reintento con SQL. El anuncio `versioned_context_v1` ya existe en adaptadores antiguos: no demuestra que incorporen esta corrección. La nueva pasarela recupera las filas también al recibir un latido, así que no debe activarse sobre clientes antiguos que puedan empezar un turno. Esta tarea no despliega ni pausa agentes.
2. Con los reales todavía fuera de admisión, crear un agente propio `zz-canary-*` con OpenClaw y una v1 nativa. Instalar el adaptador seguro en ese canario y activar la pasarela candidata en la ventana autorizada. Editar su `workspace/MEMORY.md`; simular y comprobar que propone ingerir ese fichero.
3. Conversar con el canario. Comprobar v2 con `source=native`, autor el propio agente, digest y bytes nativos conservados, recibo de consumo del arnés y `applied_version=2`. El anuncio de capacidad recupera automáticamente una fila previamente rechazada por `context_runtime_unsupported`; no acredita aplicación por sí solo.
4. Guardar un cambio de servidor v3 y conversar otra vez. Comprobar el fichero nativo y la acreditación de v3. Probar conflicto antes de pasar a agentes reales.
5. De noche, después del canario, instalar y verificar el paquete seguro en cada agente real antes de reabrir su admisión. Obtener otro inventario actual y simular de nuevo. Reabrir, ingerir y adoptar de uno en uno; conservar el recibo de cada agente. Resolver los casos bloqueados antes de solicitar una aplicación. No usar un inventario anterior como autorización ni como prueba de aplicación.

Las filas con `context_runtime_attempts_exhausted` conservan ese estado: no se reabren como si fueran rechazos de capacidad. Los errores de Git y la adopción se verifican por separado. Un estado de conexión capaz o un archivo escrito no demuestra que el arnés haya consumido la versión.
