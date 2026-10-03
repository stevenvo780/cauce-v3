# Plan: inspección Git de contexto

## Base y propiedad

Composición revisable sobre dev `7bdf7a9fb70b201afb9bd53b6241e43aaf2fc632`,
árbol `d422c2cf20bff9cf63fcb0fa74dd46eec1cab000`, con 2168 blobs verificados.
Se reutiliza la fundación R2 sobre `0272dc260d3b08ec0bfdba34d3071a244839564c`.
Los cambios publicados de mensajes se conservan sin modificación.
Primer incremento: ocho archivos de fundación. Segundo: integración de lectura. Tenant y alias
usan los esquemas canónicos; se conserva la capitalización de tenant y las
restricciones de segmentos/rutas. Pruebas Git usan el tenant sintético `Steven`.
Sin commits, publicación, despliegue ni acceso a repositorios de contexto vivos.

## Diseño

- `model.ts`: manifiesto estricto, rutas derivadas, perfil de protocolo,
  ID del diario y admisión de los siete campos. Sin manuales ni skills.
- `git-reader.ts`: lectura directa de objetos sueltos con límites y OID verificado;
  ningún proceso ni comando Git. Packs, alternates y worktrees enlazados cerrados.
- `model.ts`: bytes crudos y valores decodificados mediante detector profundo;
  escaneo incompleto y claves JSON duplicadas rechazados sin devolver el cuerpo.
- `inspect.ts`: selección de ámbito, instantáneas inmutables y comparación
  explícita; propuesta pura de exportación desde `ProfileRevisionEntry`.
  Procedencia Git no verificada y revisión de contenido obligatoria antes de
  futuros efectos. Estado local siempre `not_observed`, sin acreditar limpieza.
- Tests de modelo y Git local, con repos efímeros y contenido sintético.

## Formatos comprobados en documentación primaria

| Arnés | Instrucciones y skills | Límite del adaptador actual |
|---|---|---|
| Claude Code | CLAUDE.md jerárquico; .claude/skills/*/SKILL.md; memoria automática separada | Proyección de perfil existente |
| Codex | AGENTS.override.md antes de AGENTS.md por nivel; .agents/skills | Proyección de perfil existente |
| OpenCode | AGENTS.md; .opencode/skills y compatibilidad explícita | Sin proyección Cauce |
| OpenClaw | Documentos de workspace; skills/ por agente; memoria mutable separada | Proyección medida existente |

Fuentes: [Claude memoria](https://code.claude.com/docs/en/memory),
[Claude skills](https://code.claude.com/docs/en/skills),
[Codex instrucciones](https://learn.chatgpt.com/docs/agent-configuration/agents-md),
[Codex skills](https://learn.chatgpt.com/docs/build-skills),
[OpenCode reglas](https://opencode.ai/docs/rules/),
[OpenCode skills](https://opencode.ai/docs/skills/),
[OpenClaw workspace](https://docs.openclaw.ai/concepts/agent-workspace),
[OpenClaw skills](https://docs.openclaw.ai/tools/skills),
[OpenClaw memoria](https://docs.openclaw.ai/concepts/memory).
Documentación upstream no acredita la versión desplegada; la aplicación futura
debe comprobar capacidades y rutas medidas. No se añade integración nativa para
Hermes/Muse ni se cambia su comportamiento. El perfil canónico es independiente
del arnés; esta tabla informa el diseño posterior, no habilita retener manuales.
El catálogo actual de Cauce reconoce un directorio de memorias de Codex; no se
acredita aquí un formato nativo de importación ni se ofrece escribirlo.

## Constitución y validación

PostgreSQL conserva autoridad durable y permisos. Spec antes del código; no
migraciones, credenciales, despliegue, MCP ni agentes externos. Revisión por el
padre. Fuente aislada verificable, sin rama nueva ni commit/push del autor.
Ejecutar tests focalizados y regresiones de contexto, typecheck, lint estricto
y calidad. Registrar bloqueos nativos existentes; mocks no acreditan harness,
PostgreSQL, E2E ni UI. Comparar remoto al cerrar y generar diff verificable.

## Riesgos e integración pendiente

La inspección no mide el árbol de trabajo, HEAD ni índice; no detecta deriva local.
Los OID se recalculan para cada objeto leído; no acreditan limpieza del checkout.
Soporte de objetos empaquetados y observación segura requieren otra revisión.
Límites: 128 KiB por objeto descomprimido, 256 archivos, 2 MiB de blobs por árbol,
16 niveles, 1024 nodos de árbol y 4,25 MiB acumulados de objetos por inspección.
La raíz local sigue siendo una vinculación confiable del servidor; la lectura
no ofrece aislamiento del filesystem ante reemplazos hostiles de directorios.
Formato contrastado con [objetos Git](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects)
y [layout del repositorio](https://git-scm.com/docs/gitrepository-layout).
El segundo incremento conecta HTTP y UI de lectura con binding confiable del
servidor, ACL canónica y consulta al diario. No crea ni clona repositorios reales.
El cliente no elige rutas ni instancia; no se añade aplicación al runtime.
Revisión, ID del diario y hashes no confieren autorización. Un lector Git accede
a toda la historia, aunque el inspector filtre su respuesta por tenant/agente.
Antes de transporte futuro se exige revisar contenido y destinatarios; no se
considera el texto autorado libre de secretos por excluir archivos de configuración.

## Integración de lectura

`binding.ts` admite una pareja explícita `CAUCE_CONTEXT_INSTANCE_ID` +
`CAUCE_CONTEXT_REPOSITORY_ROOT` del servidor; sin ambas no hay vinculación.
`routes.ts` publica GET por tenant/agente para capacidad e inspección de OID
completos. Autoriza antes de leer y antes de devolver la inspección.
Compara identidad del diario y siete campos con la consulta canónica vigente
para esa revisión. Una revisión repetida con otro ID no obtiene coincidencia.
La UI consulta al abrir, permite comparar dos commits y descarta respuestas
viejas al cambiar agente/commit o cerrar. No ofrece escribir ni importar.
Aceptación: pruebas inyectadas HTTP con objetos reales sintéticos y constructor
del gateway; regresiones de contexto, identidad, errores, carreras y consola.
No se sustituyen gates agregados, PostgreSQL, arneses nativos ni revisión visual.
