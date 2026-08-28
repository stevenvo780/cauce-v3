# Doctrina del dueño

La voz del dueño sobre cómo debe ser y funcionar Cauce V3, rescatada de sus respuestas en `PENDIENTES-DEL-DUEÑO.md`, de las decisiones de `plan-reestructura/`, de `ordenes/00-PROTOCOLO.md` y de `AGENTS.md`. No repite lo que el código ya expresa: es el criterio detrás de las reglas. **Estado a 28-08-2026**: ya hubo primer despliegue real a producción (esquema 024→037, D3 en efecto — producción corre desde este repo, sin binds a `/opt`).

## 1. Principios de estructura

- **Legibilidad primero.** El dueño lo dice sobre el árbol actual: "la disposición de carpetas es poco legible y entendible… no se evidencian los dominios en los archivos, no se sigue ningún patrón". Toda reestructura futura se mide contra esto, no contra elegancia técnica.
- **Efecto demostrado.** "Nada está 'hecho' sin pegar la salida del gate. Un despliegue no está hecho sin mostrar el efecto real" (`AGENTS.md`). Declarar sin evidencia es la causa raíz de la quema de agosto.
- **Revisor ≠ autor.** Todo sector tiene un dueño de escritura y un revisor distinto (tabla de `ordenes/00-PROTOCOLO.md`); ninguna instancia se autoaprueba.
- **Una sola fuente de verdad.** Decisión D3: "el compose corre desde el repo; los 4 binds dejan de copiarse a /opt" — ejecutado en el primer despliegue.
- **La flota es lo que está activo hoy en la BD.** 14 agentes habilitados; nada que no tenga fila en `agents` existe para el sistema, sin excepción por historia o cariño (el caso Pablo: sus 4 agentes no están en BD y no se recrean).
- **Agentes desacoplados del código.** La BD (`agents`+`memberships`) es la única verdad de la flota; todo lo demás (alias, manifests, units, PKI) se DERIVA de ahí. Alta o baja de un agente = una fila en BD + aprovisionar, nunca tocar código (`ops/runbooks/alta-y-baja-de-agente.md`).
- **Migraciones que contaminan se borran, no se editan.** Una migración-ficción sale del repo entera, con su `down` y su suite; no se parchea para que cuadre.
- **Historiales sin valor: backup y poda.** Lo que la BD acumuló sin servir a nadie se poda, siempre con backup probado y restore verificado antes.
- **Credenciales jamás se borran.** Única excepción a "todo vive en git": `ops/private/credentials/` está git-ignorada a propósito (solo su README se versiona); nadie —ni instancia ni subagente— borra, mueve o reescribe nada ahí dentro.
- **Todo en main, sin ramas.** Decisión explícita: "aquí las ramas fueron el cementerio" — el 40% del trabajo se pudrió fuera de main. Convivencia por sector + `git add` solo de rutas propias + commit siempre con pathspec (`git commit <rutas> -m …`), nunca `-a` ni `add -A`.
- **La flota corre como root.** Es el entorno real de esta VPS; no se cablean guardias anti-root ni se chownea para "corregirlo". La única excepción dura: los tests del gate corren como usuario normal, nunca como root (falsos rojos por ownership).
- **GitHub Actions prohibido.** Dictado del dueño: "Actions PROHIBIDO" — no es servicio pagado. Se retiró `.github/workflows/ci.yml` y lo reemplaza `cauce-v3-ci-local.timer`: gate completo + `validate.sh` cada noche sobre `main`, en el propio host.
- **Idioma: `.md` en español, código en inglés.** Palabras del dueño: "Documentaciones .md en español, documentaciones en código en inglés". Identificadores y comentarios exportados en inglés; toda la documentación de proyecto en español.
- **Comentarios sin narrativa, sin fechas, sin nombres.** "Los comentarios-ensayo de este repo llegaron a MENTIR y envenenaron a los modelos que los leían" (`AGENTS.md`). El estándar del dueño para lo que ensucia: funciones sin propósito claro, sin nombre que describa qué hacen, repetidas en varios lugares en vez de reutilizadas, sin patrón de organización consistente, sobre-ingeniería innecesaria — eso se poda, no el comentario que expresa una restricción real.
- **Linters al máximo.** Cobertura de gate ampliada hasta que ningún fichero editable quede sin analizador: `shellcheck` obligatorio en `validate.sh` (falla si falta), `ruff` para Python encadenado en `pnpm lint`, ESLint extendido a los `.mjs` de `ops/`/`scripts/` que antes no veía nadie.

## 2. Cómo debe funcionar el producto

### La visión (7 puntos, palabras del dueño condensadas)

1. **Interoperabilidad entre harness** — que Claude Code, Codex y OpenClaw puedan hablarse entre sí y sacar instancias/agentes con facilidad.
2. **Alta y baja de agentes trivial** — independencia entre agentes, sin tocar N capas de código (`ops/runbooks/alta-y-baja-de-agente.md`).
3. **Rotación de credenciales fácil** — para "consumir cuotas de forma inteligente" entre las credenciales disponibles.
4. **Roles por contexto NATIVO de cada harness** — editar `CLAUDE.md`/`Codex.md`/`Soul.md` de OpenClaw directamente; HOY el sistema "inyecta los contextos en cada mensaje… sin aprovechar cómo funciona cada harness realmente" — eso es el defecto a matar, no el diseño final.
5. **UI para modificar contexto y permisos** — "poder entrar a modificar cada contexto de cada agente es demasiado útil"; permisos dinámicos de quién habla con quién, y con qué alcances.
6. **Terminal y TUI de cada agente por web** — desde cualquier dispositivo (laptop, tablet, celular): ver colas, modificar prioridades, destrabar procesos, rotar credenciales, reiniciar o hacer rollout — tanto por CLI como por web.
7. **UI robusta multi-socio con logs de auditoría** — "para que no solo yo, si no cualquier socio pueda entrar con su cuenta y ver qué está pasando"; y registro de comportamiento para detectar patrones indeseables como las contaminaciones de contexto que ya ocurrieron en este proyecto.

### Los 5 escenarios esenciales (criterio de éxito del despliegue; detalle en `docs/flota-y-participantes.md`)

1. Steven → argos por Telegram (nuevo cliente, software o despliegue) → argos delega en otro agente → resultado por Telegram.
2. Miguel → janus (graf, demeter, tareas recurrentes de sus empresas) → delega → Telegram.
3. Jhon → hegel (ventas, Xenia) → delega → Telegram.
4. Steven → jarvis, uso personal — hoy migrado a WhatsApp porque "cauce se volvió cuello de botella para OpenClaw" (dolor pendiente de resolver, no aceptado como estado final).
5. Operación directa por TUI/CLI — esfuerzos, destrabar, prioridades, credenciales, rollouts: la vía de rescate cuando las colas por Telegram se atascan.

## 3. Los dolores que motivan todo

- **Inyección de contexto por mensaje.** El sistema hoy reescribe el contexto completo en cada entrega en vez de dejar que cada harness lea su fichero nativo una vez; gasta tokens sin necesidad y es el punto 4 de la visión. Un intento de activarlo (contextos nativos, flag `native_profile_context`) ya se construyó y fue rechazado en revisión adversarial por bugs reales — sigue con el flag apagado, inyección como comportamiento por defecto.
- **El cuello de botella de OpenClaw/jarvis.** Uso personal más intenso del dueño migró fuera del sistema por lentitud de las colas; es la prueba de que un escenario esencial (4) está roto en producción, no solo una molestia.
- **Documentación que miente.** `ops/README.md` documentó durante meses un perfil de compose `shadow` que nunca existió en `deploy/compose.yaml`; digests que se regeneran a medias quedan "verdes" mintiendo sobre el estado real. La causa de este barrido: los `.md` sueltos contaminan el contexto de los modelos con información falsa que nadie corrige porque nadie la lee toda.
- **Código muerto y sobre-ingeniería que entorpecen.** El caso que el dueño cita: zeus tardó días arreglando algo con los modelos más caros —"si lo hubiera hecho desde 0 me hubiera tardado solo un par de horas"—. Su lectura: "tanto código entorpece, no es tan modificable, aún se siente muy estático". Por eso el código muerto se borra con `git rm` (git es el archivo, no hay carpetas de cuarentena) y no se acumula "por si acaso".
