# PLAN DE CIERRE — de las respuestas del dueño al primer despliegue real

Escrito 27-08 noche, tras leer TODAS las respuestas de `PENDIENTES-DEL-DUEÑO.md` y verificarlas contra repo, BD de producción y host (7 agentes de investigación, evidencia en los ficheros citados). Este doc es el mapa; los detalles operativos viven en `fase3/`.

## 0. El dictado del dueño, convertido en doctrina

1. **La flota real es lo que está activo HOY en la BD** — 14 agentes, todos enabled (Isa: salva · Jhon: hegel, heraclito, tales · Miguel: atlas, gaia, iza, janus, kratos · Steven: argos, jarvis, kant, socrates, zeus). Pablo se retiró: sus 4 agentes (dedalo, midas, seneca, vulcano) NO existen en la BD y NO se crean. La "contradicción" dedalo/salva era ficción de contextos contaminados: `salva` es de Isa (operativo, 4 bindings reales); dedalo/midas/seneca jamás tuvieron una fila.
2. **Migraciones que solo contaminan se borran, no se editan** — hecho (ver §1).
3. **Los historiales de la BD no valen: backup y poda** — backup automatizado ya existe y está PROBADO con restore verificado; la poda se ejecuta en la ventana (ver `fase3/migraciones.md` §Poda).
4. **Credenciales JAMÁS se borran** — carpeta `ops/private/credentials/` creada (git-ignorada, README rastreado) + regla dura en `ordenes/00-PROTOCOLO.md`.
5. **Una sola fuente** (D3): el compose corre desde el repo; los 4 binds dejan de copiarse a /opt.

## 1. EJECUTADO HOY (27-08 noche, commits en main)

- **Cirugía de migraciones-ficción** (`b4bc7b9`, −2.332 líneas): 029 y 036 fuera del repo con sus `down/`, su suite y su probe; gateway 468/468 verde. La tanda pendiente queda en **10 migraciones limpias**, todas con consumidor de producto verificado (`fase3/migraciones.md` reescrito).
- **Ficción física desmantelada** (mismo commit): `container-aliases.json` → 11 alias reales de este host, `historicalAliases` vacío; manifests/units/configs de Pablo fuera; Pablo fuera de los enums del schema (fail-closed); cred-guard sin ws-pablo.
- **Purga DLQ manual + herramientas de otras máquinas + Makefile raíz** (`7bf24a7`, −1.040 líneas): aprobación textual del dueño; digest de ops regenerado VERDE (de paso arregló un rojo preexistente del gate ops).
- **Carpeta de credenciales** (`affdff6`): `ops/private/credentials/` operativa y verificada con `git check-ignore`.
- **Funciones muertas**: censo simbólico CERRADO y repartido — Codex 28 símbolos (orden activa), Gemini 22 (orden activa), Claude 2 (borrados, `34e7ead`).
- **Órdenes nuevas**: Gemini (anexo + duplicados consola + dientes + P14), MiniMax ronda 8 (mapa, docs-que-mienten, mapa de credenciales, huérfanos v2), Codex anexo 2 (quitar el escalón 036 de 6 tests de migración — probablemente resuelve su tarea 0 de raíz).

## 2. PURGAS QUE NO SE EJECUTARON (y la razón honesta)

- **(d) quota-collector**: tu respuesta pide REHACERLO como parte del CLI integral, no borrarlo; y hay datos de producción vivos entrando por esa vía cuyo productor exacto no está confirmado. Se queda como referencia hasta que el CLI lo absorba.
- **(f) liveness-probe.mjs**: tiene 2 suites REALES dentro del gate obligatorio; mejor destino: cablearlo a `deploy/smoke.sh` (fue escrito para eso y nadie lo hizo).
- **(f) los "7 tests huérfanos" de ops**: la premisa del censo ("sin runner = huérfano") era engañosa — cubren scripts VIVOS (alias-lock-exec, verify-hermes-runtime, el reaper del container-runtime) y para 3 de ellos son la ÚNICA cobertura. Se quedan; el único redundante real (gate-collector.test.mjs, con gemelo wireado) puede caer en una limpieza futura.
- **(c) console-legibilidad**: NO es basura — son sondas reales contra Chrome headless que miden contraste/tipografía/CSP de la consola. Útiles justo para el mega-refactor que quieres. Pregunta abierta en §6.

## 3. VISTAS DE CONSOLA — veredicto razonado (lo pediste delegado)

El reporte anterior medía **alias de redirección**, no vistas (4 de 8 veredictos se caían). Real:
- **Se retiran**: `jobs` (lápida de 20 LOC) y `chains` (pestaña del cajón + su API client, ~295 LOC). Lo ejecuta Gemini en una ronda próxima con el mapa exacto.
- **Se parten**: `topology` → SOLO muere `hypergraph.css` (256 LOC huérfanas); el resto de `features/topology/` es EL MOTOR DE LAYOUT DE /live (1.348 LOC) — renombrarlo a `features/live/hypergraph/` en el mega-refactor para que ninguna auditoría futura vuelva a proponer borrarlo. `adapters` → solo muere el alias (1 línea).
- **Se conservan**: `audit` y `relays` (son pestañas VIVAS de /observability), `fleet/:tenant/:alias` (único deep-link al TUI, lo usa el botón "Abrir TUI" de /messages), y `role-brief-tab` (**es la capa 1 del editor de directivas** — tu feature — y el único camino de rollback del rol).
- Ahorro real inmediato: ~572 LOC. Deudas para el mega-refactor anotadas (deep-link en /terminal desbloquea borrar 180 LOC más + todos los casos especiales del router; regenerar docs/grafo.md).

## 4. PLAN MAESTRO AL DESPLIEGUE (consolidado 28-08 — "abarcamos todas mis solicitudes y desplegamos")

### Los 6 carriles en paralelo, DISJUNTOS por fichero (cero colisiones)

| Carril | Instancia | Zona exclusiva | Misión | ¿Bloquea la ventana? |
|---|---|---|---|---|
| C | **codex-1** | `ops/scripts` + `ops/tests` | flota-como-datos: fórmulas, exportador, generadores (Fase A byte-idéntica), gates G-SNAP | **SÍ** |
| G | **gemini** | `ops/pty-agent`, `ops/runbooks`, `console`→relay→bridge | publish-alias-key + runbook nueva era + re-firma PTY (G1, espera señal K2) + molienda estricta de sus zonas | **G1 SÍ**; molienda NO |
| K | **claude (yo)** | snapshot, BD-reconciliación, `ops/cli`, integración | K1 SQL de reconciliación (lo corres tú) → K2 conmutar snapshot real → K3 `aprovisionar`/`retirar` → K4 probe de deploy → supervisor determinista (en diagnóstico ya) → demo probeta | **SÍ** |
| T | **minimax-1** | `packages/adapter-sdk/test` + censo | ronda de orden de tests (corriendo): plan maestro + partición de 3 gigantes | NO (deseable) |
| E | **codex-2** | `packages/{protocol,store,mcp}/src` + `services/gateway/src` | lint MÁXIMO a cero por sub-zona + comentarios→inglés | NO (sigue post-deploy) |
| I | **minimax-2** | `adapter-sdk/src`, `dispatcher`, `deploy`, `scripts`, `pty-agent`, `tests/*` | comentarios→inglés masivo + poda (solo líneas de comentario) | NO (sigue post-deploy) |

Un segundo claude NO hace falta: la integración debe tener UNA sola cabeza (este session) — mi paralelismo real son los workflows.

### Criterios de GO para la ventana (y NADA más — la molienda cosmética NO la bloquea)
1. ✔ ya: tanda de 10 ensayada (2,96s) · deploy/smoke calibrados · imágenes verificadas · backups torre+Drive · decisiones del dueño integradas.
2. Carril C cerrado: Fase A `cmp -s` byte-idéntica + gates G-SNAP en verde.
3. Carril K: tu SQL de reconciliación corrido (argos→openclaw, placements de gaia/heraclito/tales) → K2 snapshot real conmutado → `validate.sh` verde → G1 re-firmado → **demo probeta completa** (alta y baja tocando solo BD+CLI).
4. Supervisor determinista VERDE (diagnóstico opus corriendo).
5. Gate global + `ops:validate` + `test:pty` verdes en el árbol final; CI local nocturno ya vigila.
→ **VENTANA** (~2-3h contigo, guion ya ensayado): backup fresco → B1 (3 sesiones) → prod.env (B2 instance-id, B3 rutas-repo) → build desde main → migrar (2,9s) → up --wait → smoke → poda de historiales (contigo) → GC del registry (contigo) → los 5 escenarios esenciales de `docs/flota-y-participantes.md` como prueba de humo FINAL.

## 5. POST-PRIMER-DESPLIEGUE (el roadmap que dictaste)

1. **Cirugía de dominios** (ya planificada): `flota/`, consola a raíz, ops repartida — con checklists del grafo.
2. **CLI integral de cauce** (tus respuestas a-b-d): una sola app instalable donde haga falta, con auth para conectarse a TUIs/máquinas; absorbe el CLI de cuotas y reemplaza al quota-collector: autenticar modelos amigablemente (como kratos hoy), renovar credenciales vencidas entrando a la TUI, consumos en tiempo real. Centro de mando SIEMPRE esta VPS; multi-server posible (como kant).
3. **Zeus guardián** (tu D2/e): 3 opciones evaluadas con lo que ya existe — (1) timer que lee alertas de Prometheus y publica al bus con el patrón del revividor-de-colas (~100 líneas, YA hay pieza probada; portar su salvaguarda de idempotencia); (2) receptor webhook de alertmanager → bus (reacción instantánea, un servicio más que vigilar); (3) además registrar `mcp-fleet-monitor` en el harness de zeus para que investigue con tools. Recomendación: empezar por (1), evolucionar a (3).
4. **Aislamiento por tenant** (tu D1): cada tenant en su docker con carpetas aparte. Ojo: el checkout compartido de git hoy lo leen los 4 tenants — el aislamiento real exige credenciales por-tenant DENTRO del contenedor de cada uno (patrón `/opt/cauce-v3-secrets/<alias>` ya existente).
5. **Notificaciones recurrentes por agente** (tu redefinición de las "alertas"): cualquier agente puede tener mensajes programados tipo cron encolados a su canal por el bus — generalizar el patrón del revividor-de-colas (pieza ya probada en este host, con su salvaguarda de idempotencia). Zeus-guardián es solo el primer uso.
6. **Mega-refactor de consola**: con las deudas de §3 + los 74 asserts-sobre-texto (el renombre de topology ya lo hizo Gemini). Incluye tu idea: la legibilidad la revisa un AGENTE con Chrome, no código quemado (las sondas CDP se borraron por tu (d)).
7. **Contextos NATIVOS por harness** (anexo 28-08 — dolor central): HOY se inyecta el contexto en cada mensaje gastando tokens; el objetivo es editar el fichero nativo de cada harness (CLAUDE.md/Codex.md/Soul.md) y que el harness lo consuma solo. La UI /live directivas apunta ahí; el modo inyección es el defecto a matar.
8. **El cuello de botella OpenClaw** (anexo): jarvis migró a WhatsApp porque las colas de cauce se atascan — investigar y resolver post-despliegue (candidato: primera misión del Zeus guardián + logs de comportamiento).
9. **Logs de auditoría de comportamiento** (anexo): detectar patrones indeseables (contaminación de contextos) — hoy no existen.
10. **Evolución del CLI** (tu g): de la fuente única rescatada (1.138 líneas) a un CLI instalable en cualquier ordenador sin depender de la torre, con auth hacia TUIs/máquinas y cuotas en tiempo real integradas.

## 6. DECISIONES DEL DUEÑO — TODAS RESPONDIDAS (27-08 noche; texto original en git, commit 267b365)

- **(a) Ventana**: en cuanto cierre la mega-ronda de antipatrones. PRIORIDAD.
- **(b) Alertmanager**: descartado → notificaciones recurrentes por agente (roadmap §5).
- **(c) Torre**: kratos ES la torre (9950X3D, 32 hilos, verificado por ssh) y tiene `gdrive:` en rclone → copias VPS→torre y torre→Drive se cablean en la ronda de kratos (i).
- ## 6-bis. LA MEGA-RONDA (anexo del dueño, 27-08)


**(d) console-legibilidad**: 6 sondas CDP que miden contraste/tipografía/CSP de la consola real. ¿Se quedan para el mega-refactor o fuera?

## 7. FLOTA-COMO-DATOS — ASCENDIDO A BLOQUEANTE DE VENTANA (dictado del dueño 28-08; era 'anotado')
La identidad de los agentes está clavada en ≥7 sitios del código (container-aliases.json, ops/manifests/<alias>.yaml, units generadas, cred-guard, mocks del harness, enums del schema, telegram-runtime, PKI por alias) — por eso la ficción de Pablo hizo metástasis y retirar/añadir un agente cuesta tocar N capas. Objetivo: **la flota como DATOS, no como código** — alta/baja = 1 fila en BD + aprovisionar credenciales; todo lo demás DERIVADO de esa fuente única. Encaja con el aislamiento por tenant y el CLI integral. Va ANTES del primer despliegue como ronda propia de toda la flota; el diseño con mediciones reales (derivabilidad campo a campo de los 11 agentes, consumidores, checklist de credenciales) vive en `plan-reestructura/flota-como-datos.md`. Criterio de cierre: DEMO real — alta y baja de un agente de prueba tocando SOLO BD+CLI, todo lo demás derivado.
