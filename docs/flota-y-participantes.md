# La flota y sus participantes

Este documento conserva los cinco recorridos de aceptación de Cauce y distingue las instalaciones. El inventario del checkout se deriva de `ops/flota.json`; los roles humanos de Hospital están en `grupos.json`. El estado vivo se comprueba en el registro y con las sondas de [operacion.md](operacion.md).

## Hospital: tres agentes funcionales

| Alias | Función | Arnés y aislamiento |
|---|---|---|
| `operador` | dirige, delega desarrollo, revisa, integra y responde al humano; no implementa código | OpenClaw, contenedor y estado propios |
| `teseo` | desarrollo backend del CRM y encargos de Praxis | Muse, contenedor, estado y clon de trabajo propios |
| `perseo` | desarrollo frontend del CRM y encargos de Praxis | Muse, contenedor, estado y clon de trabajo propios |

Praxis se trabaja en clones separados del CRM, con datos sintéticos y una incidencia por turno. Los tres agentes mantienen workspace, contexto, credenciales y sesiones independientes. Gateway, PostgreSQL, consola, bridge, relay y otros servicios son infraestructura y no se suman al censo de agentes. `CAUCE_SMOKE_EXPECTED_AGENTS` llega a **3** tras aprovisionar los tres; el valor de bootstrap puede ser 0 hasta entonces (`ops/instances/hospital/provision-agents.sh`).

## Flota central de Steven

El snapshot de `origin/dev` integra quince alias centrales: seis de Steven (`jarvis`, `zeus`, `argos`, `socrates`, `kant`, `astra`), cinco de Miguel (`janus`, `atlas`, `kratos`, `iza`, `gaia`), tres de Jhon (`hegel`, `tales`, `heraclito`) y uno de Isa (`salva`). Trece usan Docker y dos runtimes nativos (`astra`, `kant`); Atlas y Kratos comparten `ws-humanizar`. Es otra instancia: sus alias y su expectativa de smoke no sustituyen el snapshot de Hospital. La topología física y el censo vivo se verifican en esa instalación, no en este fichero.

## Los 5 escenarios esenciales (criterio de aceptación del producto)

Estos recorridos históricos describen la flota central y sirven a `ops/harness/escenarios-esenciales.md` y `specs/001-orquestador-multi-harness/spec.md`. El arnés cubre partes del transporte; Telegram, TUI y el trabajo de cada rol requieren pruebas por efecto separadas.

1. Steven→argos por Telegram (nuevo cliente/software/deploy) → argos delega → resultado por Telegram.
2. Miguel→janus (graf, demeter, recurrentes) → delega → Telegram.
3. Jhon→hegel (ventas, Xenia) → delega → Telegram.
4. Steven→jarvis personal por los canales configurados, sin bloquear el trabajo de OpenClaw.
5. Operación por TUI/CLI: esfuerzos, destrabar, prioridades, credenciales y rollouts como vía de rescate.

Hospital añade su recorrido propio: el humano pide a `operador`, éste entrega desarrollo a `teseo` y `perseo` con archivos disjuntos, revisa los resultados, integra y devuelve una sola respuesta. Para Praxis rige además el aislamiento respecto del CRM y el uso exclusivo de datos sintéticos.
