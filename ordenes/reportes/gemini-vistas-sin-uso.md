# Dossier de decisión — Vistas y rutas de consola sin uso medido

Auditoría de telemetría de 3,5 días: evaluación de 15 rutas, alias y subcomponentes candidatos a poda o cuarentena.

| Vista / Ruta / Alias | Qué muestra | LOC (src + test) | Endpoint(s) | Evidencia de último uso real | Recomendación |
|---|---|---|---|---|---|
| `audit` (`/audit`, `AuditPanel`) | Registro inmutable de eventos de seguridad y decisiones administrativas | 394 (253 + 141) | `GET /v3/console/audit` | 0 peticiones humanas en 3,5 días; enlaces por trace_id con 0 clics | `_legado` (consultable por DB/CLI) |
| `jobs` (`/jobs`, `JobsRetiredNotice`) | Cartel estático de vista retirada (tabla jobs sin filas en BD) | 20 (20 + 0) | Ninguno | 0 visitas en 3,5 días | `_legado` (eliminar ruta y aviso) |
| `chains` (Tab "Cadena" en `AgentDrawer`) | Trazabilidad salto a salto de delegación de entregas | 184 (121 + 63) | `GET /v3/console/chains` | 0 clics en 3,5 días; arcos visibles en hipergrafo y mensajes | `_legado` (simplifica cajón de 6 a 5 tabs) |
| `relays` / egress (`/relays`, `ObservabilityPage`) | Tabla de estado durable de outbox/egress hacia canales de origen | 370 (139 + 231) | `GET /v3/console/origin-relays` | 0 visitas en 3,5 días; operadores miran canal Telegram directo | `_legado` (mantener solo contador outbox) |
| `licenses` (`/licenses`, `licenses.ts/css`) | Detalle legacy de licencias de suscripciones por modelo | 1.644 (867 + 777) | Embebido en `GET /v3/console/config` | 0 visitas al alias `/licenses`; consolidado en `AccountsPage` | `_legado` (retirar alias y helpers huérfanos) |
| `quotas` (`/quotas`, `quotas.ts`) | Consumo y saldo de cuotas por modelo | 323 (193 + 130) | `GET /v3/console/quotas` | 0 accesos directos por URL; se usa dentro de pestaña Consumo | Conservar en `/accounts`, retirar alias `/quotas` |
| `assignments` (`/assignments`, `AssignmentMatrix`) | Matriz editable de asignación de cuentas a agentes | 545 (259 + 286) | `GET/POST /v3/console/config` | 0 accesos por URL; matriz fija aprovisionada en arranque | Conservar en `/accounts`, retirar alias `/assignments` |
| `topology` (`/topology`, `features/topology/*`) | Grafo de topología y ACL duplicado de LiveHypergraph | 1.780 (1.533 + 247) | `GET /v3/console/topology` | 0 visitas a `/topology`; `LiveHypergraph` es la versión viva | `_legado` (eliminar standalone y alias) |
| `adapters` (`/adapters`, `HarnessStrip`) | Tira de estado de adaptadores de transporte | 80 (80 + 0) | Embebido en `/terminal` y `/` | 0 visitas a `/adapters`; visible en Portada y Terminal | `_legado` (eliminar alias `/adapters`) |
| `activity` (`/activity`, `activity.ts`) | Tabla de actividad reciente de la flota | 525 (297 + 228) | `GET /v3/console/activity` | 0 visitas a `/activity`; tabla integrada en `/live` | Conservar lógica en `/live`, retirar alias `/activity` |
| `fleet` (`/fleet/:tenant/:alias`, `FleetAgentDetailPage`) | Vista dedicada de agente único delegando en terminal | 180 (90 + 90) | Delega en workspace PTY | <2 accesos en 3,5 días; cubierto por pestañas de `/terminal` y cajón `/live` | `_legado` (retirar sub-ruta y alias) |
| `SpaceWizard` / `AltaRapida` (`/config`) | Asistente de creación guiada de espacios y salas | 746 (524 + 222) | `POST /v3/console/config` | 0 altas por UI en 3,5 días (provisionamiento vía CLI/migraciones) | Conservar en `/config` (útil en autoservicio) |
| `role-brief-tab` (Tab "Rol" en `AgentDrawer`) | Proyección de sólo lectura del brief de rol de un bot | 323 (219 + 104) | Embebido en metadata de `/live` | Redundante con `PerfilTab` y `DirectivaModal` | `_legado` (unificar en `PerfilTab`) |
| `historial-rol` (`HistorialRol`) | Historial y rollback de cambios al brief de rol | 811 (337 + 474) | Metadata histórica de `/live` | 0 rollbacks en 3,5 días | Conservar en `DirectivaModal` (auditoría) |
| `ack-inspector` (`AckInspector`) | Inspección de recibos ACK y botones de replay/cancel | 186 (110 + 76) | `POST /replay`, `POST /cancel` | 0 acciones en producción en 3,5 días; vital para rescate | Conservar en `/terminal` (diagnóstico crítico) |

## Resumen de impacto de poda recomendada
- **Vistas y alias a retirar a `_legado`:** 8 componentes/alias (`jobs`, `chains`, `audit`, `relays`, `topology`, `fleet/:tenant/:alias`, `adapters`, `role-brief-tab`).
- **Ahorro potencial:** ~4.700 LOC (src + tests) y reducción de superficie de ataque en el gateway.
- **Rutas canónicas limpias que quedan:** 7 vistas principales (`/`, `/live`, `/accounts`, `/messages`, `/queues`, `/observability`, `/config`, `/terminal`).
