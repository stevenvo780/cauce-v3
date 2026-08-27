# Verificación de §(3) de `PENDIENTES-DEL-DUEÑO.md` — 8 vistas de consola

Solo lectura. Cada cifra pegada con `wc -l` y su salida. Sin edición, sin commit.

## Tabla resumen

| vista | ficheros exclusivos | líneas exclusivas (src) | líneas de test | ficheros compartidos que NO cuentan | referencias vivas |
|---|---|---:|---:|---|---|
| `jobs` | `features/landing/JobsRetiredNotice.tsx` | 20 | 0 | — | `App.tsx:10` (import), `App.tsx:93` (route id `jobs`), `App.invariantes.test.tsx:35` (comentario) |
| `chains` | `features/live/ChainPanel.tsx` + `ChainPanel.test.tsx` | 121 | 63 | — | `features/live/AgentDrawer.tsx:10, 380` (import y render en tab «Cadena» del cajón /live) |
| `audit` | `features/audit/{AuditPanel.tsx, audit-summary.ts, AuditPanel.test.tsx, audit-summary.test.ts}` | 253 | 141 | `styles/views.css:160-…` y `styles/responsive.css:60-86` (reglas `.audit-*` y `.adapter-meta`); mocks `mocks/handlers.ts:100` (GET `/v3/console/audit`) | `features/observability/ObservabilityPage.tsx:10, 136` (host del panel dentro del tab «Auditoría») |
| `relays` | (ninguno — todo lo «relays» vive dentro de `ObservabilityPage.tsx` mezclado con señales y auditoría) | 0 | 0 | `features/observability/ObservabilityPage.tsx` (139 src + 231 test) **completo** compartido con /audit y /signals | `App.tsx:49-50, 79` (ruta `observability`); `App.tsx:107` (`relays: 'observability'` en `ROUTE_ALIASES`); `mocks/handlers.ts:101` (GET `/v3/console/origin-relays`) |
| `topology` | (ninguno — los 7 ficheros del directorio están importados por /live) | 0 | 0 | `features/topology/*` (1.604 líneas): `hypergraph-layout.ts` (397) → `LiveHypergraph.tsx:19`, `FlowArrow.tsx:1`, `agent-state-derivation.test.ts:4`; `layout-{geometry,labels,nodes}.ts` transitivos al anterior; `AclEdgeList.tsx` (29) y `TenantCards.tsx` (42) → `LiveFleetLegend.tsx:2-3`; `hypergraph.css` (256) solo referenciada por `styles.legibilidad.test.ts:55` y `styles.tipografia.test.ts:28` (guards de test) | `App.tsx:110` (`topology: 'live'` — la ruta YA está retirada, dossier no se enteró); `mocks/handlers.ts:33` (`/v3/console/topology`); el endpoint backend lo siguen consumiendo `LiveFleetPage`, `MessagesPage`, `TerminalPage`, `FleetAgentDetailPage` |
| `fleet/:tenant/:alias` | `features/fleet/FleetAgentDetailPage.tsx` + `.test.tsx` | 90 | 90 | — | `App.tsx:59-61` (lazy import), `App.tsx:170-175, 206-208, 259-267` (matching + render) |
| `adapters` | (ninguno — `HarnessStrip` lo usa la LandingPage que se conserva) | 0 | 0 | `features/landing/LandingPage.tsx` (165 src + 132 test + `landing.ts` 231 + `landing.test.ts` 215) — `HarnessStrip.tsx` se renderiza en `LandingPage.tsx:162`; `App.tsx:111` (`adapters: ''` en `ROUTE_ALIASES`) | `features/landing/LandingPage.tsx:6, 162` |
| `role-brief-tab` | `features/live/RoleBriefTab.tsx` + `.test.tsx` | 132 | 63 | `features/live/role-brief.ts` (87 src + 41 test) **compartido** con `DirectiveTab.tsx:8`, `HistorialRol.tsx:2`, `features/config/RolesPanel.tsx:3`, `features/config/roles.ts:1` y los mocks; `live-drawer.css:114-138` (estilos `.role-brief-*` también usados por `live-directiva-modal.css:159-174`) | `features/live/DirectivaModal.tsx:7, 15, 128` (import, props extendidas, render); `mocks/data.ts:11`, `mocks/handlers.ts:5, 369` (`roleBriefHistoryKant`) |
| **TOTAL exclusivo (lo que se borra sin tocar nada más)** | 9 ficheros | **616** | **357** | 167 (`role-brief.ts` 87 + `HarnessStrip.tsx` 80) son SHARED — NO se pueden borrar | — |
| **TOTAL `plano-objetivo` (cifra citada como 1.027)** | los mismos 9 + HyperGraph.tsx (que ya no existe: borrado en 847e896 hoy 16:13) | **783** | — | — | — |

Notas a la tabla:

- La columna «líneas exclusivas (src)» suma SOLO los ficheros cuyo borrado no rompe ninguna vista conservada. Co-edición obligatoria (no listada arriba): `App.tsx`, `AgentDrawer.tsx`, `ObservabilityPage.tsx`, `LandingPage.tsx`, `DirectivaModal.tsx`.
- «líneas de test» son las del propio test del fichero exclusivo (no incluye co-test de los consumidores).
- Los 9 ficheros de la lista del `plano-objetivo` que suman los 1.027 originales NO corresponden uno-a-uno con las 8 vistas: `topology` aparece como «HyperGraph.tsx 244» (que ya no existe) y `relays` ni siquiera tiene fichero exclusivo — el `plano-objetivo` lo agrupó con `audit` (no con `relays`).

---

### C1 — «¿Son 8 vistas?»

**VEREDICTO:** VERDADERO (con 1 matiz: 2 de las 8 no son vistas — son sub-componentes; las 6 restantes sí son vistas/pantallas)
**AFIRMADO EN:** `PENDIENTES-DEL-DUEÑO.md:81` («`jobs` · `chains` · `audit` · `relays` · `topology` · `fleet/:tenant/:alias` · `adapters` · `role-brief-tab`»)
**COMANDO:**
```
$ ls console/src/features/{audit,fleet,topology,observability,landing,live}/ 2>&1 | \
    grep -E "AuditPanel|ChainPanel|JobsRetiredNotice|FleetAgentDetail|HarnessStrip|ObservabilityPage|hypergraph-layout|RoleBriefTab|TopologyPage|HyperGraph"
```
**SALIDA:**
```
console/src/features/audit/AuditPanel.tsx
console/src/features/audit/AuditPanel.test.tsx
console/src/features/audit/audit-summary.ts
console/src/features/audit/audit-summary.test.ts
console/src/features/fleet/FleetAgentDetailPage.tsx
console/src/features/fleet/FleetAgentDetailPage.test.tsx
console/src/features/landing/HarnessStrip.tsx
console/src/features/landing/JobsRetiredNotice.tsx
console/src/features/live/ChainPanel.tsx
console/src/features/live/ChainPanel.test.tsx
console/src/features/live/RoleBriefTab.tsx
console/src/features/live/RoleBriefTab.test.tsx
console/src/features/observability/ObservabilityPage.tsx
console/src/features/observability/ObservabilityPage.test.tsx
console/src/features/topology/AclEdgeList.tsx
console/src/features/topology/TenantCards.tsx
console/src/features/topology/hypergraph-layout.test.ts
console/src/features/topology/hypergraph-layout.ts
console/src/features/topology/layout-geometry.ts
console/src/features/topology/layout-labels.ts
console/src/features/topology/layout-nodes.ts
console/src/features/topology/hypergraph.css
```
**LECTURA:** Los 8 elementos del listado existen hoy como unidades de código distintas y referenciables. `TopologyPage.tsx` (51 src) y `HyperGraph.tsx` (244 src) ya NO existen — borrados hoy 04:13 y 16:13 respectivamente (commits `179d7bf` y `847e896`). Las dos que no son vistas-pantalla son `chains` (tab «Cadena» dentro de `AgentDrawer.tsx` del cajón de /live) y `role-brief-tab` (tab «Rol» dentro de `DirectivaModal.tsx` de /live): son sub-componentes, no rutas.

---

### C2 — «~1.027 líneas reales de src»

**VEREDICTO:** FALSO (hoy: **783** src — 244 menos que la cifra citada, por un fichero borrado en `847e896`)
**AFIRMADO EN:** `PENDIENTES-DEL-DUEÑO.md:81` («~1.027 líneas reales de src»)
**ORIGEN DE LA CIFRA:** `plan-reestructura/plano-objetivo.md:543` (commit `7048eb3`, 15:57 UTC) — «AuditPanel.tsx 168 + audit-summary.ts + JobsRetiredNotice.tsx 20 + ChainPanel.tsx 121 + RoleBriefTab.tsx 132 + role-brief.ts + FleetAgentDetailPage.tsx 90 + HarnessStrip.tsx 80 + HyperGraph.tsx 244» = 1.027. La cifra se copió tal cual al `PENDIENTES` (commit `f880565`, 17:07) sin re-verificar tras el borrado de `HyperGraph.tsx` (16:13).

**COMANDO:**
```
$ for f in console/src/features/audit/AuditPanel.tsx \
          console/src/features/audit/audit-summary.ts \
          console/src/features/landing/JobsRetiredNotice.tsx \
          console/src/features/live/ChainPanel.tsx \
          console/src/features/live/RoleBriefTab.tsx \
          console/src/features/live/role-brief.ts \
          console/src/features/fleet/FleetAgentDetailPage.tsx \
          console/src/features/landing/HarnessStrip.tsx \
          console/src/features/topology/HyperGraph.tsx; do
    printf "%5d  %s\n" "$(wc -l < "$f" 2>/dev/null || echo 0)" "$f"
  done
```
**SALIDA:**
```
  168  console/src/features/audit/AuditPanel.tsx
   85  console/src/features/audit/audit-summary.ts
   20  console/src/features/landing/JobsRetiredNotice.tsx
  121  console/src/features/live/ChainPanel.tsx
  132  console/src/features/live/RoleBriefTab.tsx
   87  console/src/features/live/role-brief.ts
   90  console/src/features/fleet/FleetAgentDetailPage.tsx
   80  console/src/features/landing/HarnessStrip.tsx
    0  console/src/features/topology/HyperGraph.tsx
```
**LECTURA:** La suma de los 9 ficheros nombrados en `plano-objetivo.md:543` da **783 src hoy** (no 1.027). La diferencia exacta es 244 — el tamaño de `HyperGraph.tsx`, borrado en `847e896` (16:13). La cifra «1.027» está desfasada ~76 minutos y arrastra un fichero muerto que ya no existe. El `PENDIENTES` (17:07) se escribió después del borrado: alguien copió la cifra sin re-verificar.

**Desglose por grado de removibilidad** (de los 783):

| grado | ficheros | src | nota |
|---|---|---:|---|
| exclusivo y limpiamente borrable | `JobsRetiredNotice.tsx`, `ChainPanel.tsx`, `FleetAgentDetailPage.tsx` | 231 | borrar + editar `App.tsx`, `AgentDrawer.tsx` |
| exclusivo pero requiere editar consumidor vivo | `AuditPanel.tsx`, `audit-summary.ts`, `RoleBriefTab.tsx` | 385 | editar `ObservabilityPage.tsx` y `DirectivaModal.tsx` |
| compartido con vistas que se quedan | `role-brief.ts` (87), `HarnessStrip.tsx` (80) | 167 | **NO removible** sin romper `DirectiveTab`, `HistorialRol`, `RolesPanel`, `LandingPage` |

`topology` y `relays` aportan 0 src cada uno a la cuenta (sus ficheros están consumidos por vistas vivas o ya están en alias).

**Conclusión:** incluso si la cifra del `PENDIENTES` fuera exacta, el dueño estaría aprobando la poda de un máximo de **231 líneas limpiamente borrables** + **385 que requieren co-edición** + **167 que NO deberían contarse** = ~616 reales (no 1.027). El gap 4,5× del que habla `plano-objetivo.md:532` ya está corregido en el árbol, pero la cifra del `PENDIENTES` arrastra la copia obsoleta.

---

### C3 — «la fila `topology` incluye `hypergraph-layout`, que `/live` SÍ usa»

**VEREDICTO:** VERDADERO (la advertencia es correcta hoy; `hypergraph-layout.ts` y sus 3 helpers los importa /live; la única parte muerta de `topology` ya cayó en `847e896`)
**AFIRMADO EN:** `PENDIENTES-DEL-DUEÑO.md:82` («la fila `topology` incluye `hypergraph-layout`, que `/live` SÍ usa — se excluye o se parte antes»)
**COMANDO:**
```
$ grep -rn "hypergraph-layout" console/src --include="*.ts" --include="*.tsx"
```
**SALIDA:**
```
console/src/features/topology/layout-nodes.ts:10:import type { LayoutOptions } from './hypergraph-layout';
console/src/features/topology/hypergraph-layout.test.ts:10:} from './hypergraph-layout';
console/src/features/live/LiveHypergraph.tsx:19:} from '../topology/hypergraph-layout';
console/src/features/live/agent-state-derivation.test.ts:4:import { layoutHypergraph } from '../topology/hypergraph-layout';
console/src/features/live/live-hypergraph/FlowArrow.tsx:1:import type { Point } from '../../topology/hypergraph-layout';
```
**LECTURA:** `console/src/features/topology/hypergraph-layout.ts` es importado por **3 ficheros de /live** (`LiveHypergraph.tsx:19`, `FlowArrow.tsx:1`, `agent-state-derivation.test.ts:4`) y por sus 3 helpers locales (`layout-{geometry,labels,nodes}.ts`). Borrar la familia `hypergraph-layout` rompe `/live`. Lo mismo con `AclEdgeList.tsx` y `TenantCards.tsx` — los importa `features/live/LiveFleetLegend.tsx:2-3`.

**COMANDO (estado del directorio tras la purga de hoy):**
```
$ ls console/src/features/topology/
```
**SALIDA:**
```
AclEdgeList.tsx  TenantCards.tsx  hypergraph-layout.test.ts  hypergraph-layout.ts
hypergraph.css   layout-geometry.ts  layout-labels.ts  layout-nodes.ts
```
**COMANDO (verificación de que HyperGraph.tsx ya no está):**
```
$ ls console/src/features/topology/HyperGraph.tsx 2>&1
$ git -C /datos/workspaces/zeus/cauce-v3 log -1 --format='%H %ad %s' --date=short 847e896
```
**SALIDA:**
```
ls: cannot access 'console/src/features/topology/HyperGraph.tsx': No such file or directory
847e896df46d06d135de33b35bd5abfa55c0621d 2026-08-27 purga P4-P13: sectores completos en protocolo, rojos de store y veredicto legado-candidato a codex, HyperGraph muerto fuera, 2 schemas muertos fuera, 160K de reportes consumidos fuera, enlaces muertos reparados
```
**LECTURA:** La advertencia del `PENDIENTES` es correcta en el fondo, pero **parcialmente obsoleta en la forma**. Lo que dice «se excluye o se parte antes» ya pasó: `plano-objetivo.md:550` (P9) identificó que el ÚNICO residuo real de la vista `topology` era `HyperGraph.tsx` (244 líneas, cero importadores) y que la ruta ya estaba en alias `topology: 'live'` (`App.tsx:110`). Ese fichero cayó en `847e896` (16:13) ejecutado antes de la firma del `PENDIENTES` (17:07). Las 7 entradas restantes del directorio `topology/` son imports vivos de /live — no se pueden retirar como bloque «topology», habría que **mover** `hypergraph-layout.ts` (+ sus 3 helpers + `hypergraph-layout.test.ts`) y `{AclEdgeList, TenantCards}.tsx` al directorio `live/` (y dejar el directorio `topology/` vacío). Hoy eso no se ha hecho; la advertencia del `PENDIENTES` aplica a ese movimiento, no a una poda.

---

### C4 — «0 visitas humanas en 3,5 días»

**VEREDICTO:** NO RESPALDADO (la afirmación se repite en el dossier y se reproduce en el `PENDIENTES` sin fuente pegada)
**AFIRMADO EN:** `PENDIENTES-DEL-DUEÑO.md:81` («todas con 0 visitas humanas en 3,5 días»); fuente única: `ordenes/reportes/gemini-vistas-sin-uso.md` (líneas 7, 8, 9, 10, 14, 15, 17, 18, 20, 21)
**COMANDO:**
```
$ grep -nE "3,5|3\.5 d|0 peticion|0 clic|0 visitas|0 accesos|0 altas|0 rollback|0 accion" ordenes/reportes/gemini-vistas-sin-uso.md
```
**SALIDA:**
```
3:Auditoría de telemetría de 3,5 días: evaluación de 15 rutas, alias y subcomponentes candidatos a poda o cuarentena.
7:| `audit` (...) | 0 peticiones humanas en 3,5 días; enlaces por trace_id con 0 clics |
8:| `jobs` (...) | 0 visitas en 3,5 días |
9:| `chains` (...) | 0 clics en 3,5 días; arcos visibles en hipergrafo y mensajes |
10:| `relays` (...) | 0 visitas en 3,5 días; operadores miran canal Telegram directo |
14:| `topology` (...) | 0 visitas a `/topology`; `LiveHypergraph` es la versión viva |
15:| `adapters` (...) | 0 visitas a `/adapters`; visible en Portada y Terminal |
17:| `fleet` (...) | <2 accesos en 3,5 días; cubierto por pestañas de `/terminal` y cajón `/live` |
18:| `SpaceWizard` / `AltaRapida` (`/config`) | 0 altas por UI en 3,5 días (provisionamiento vía CLI/migraciones) |
20:| `historial-rol` (...) | 0 rollbacks en 3,5 días |
21:| `ack-inspector` (...) | 0 acciones en producción en 3,5 días; vital para rescate |
```
**COMANDO (buscar fuente de telemetría en el repo):**
```
$ grep -rln "audit_events" services/gateway/src console/src 2>/dev/null | head -5
$ grep -rln "telemetr\|access.log\|nginx" ordenes/ plan-reestructura/ 2>/dev/null | head -5
```
**SALIDA:**
```
(no hay referencias a telemetría, logs de acceso, ni a ninguna query a audit_events en el dossier)
```
**LECTURA:** El dossier `gemini-vistas-sin-uso.md` **enuncia** el dato («0 peticiones humanas en 3,5 días») pero **no pega la fuente**: no hay un log de nginx citado, no hay una query a `audit_events`, no hay un volcado CSV, no hay un comando de medición ejecutable, no hay un enlace a un panel. La frase «Auditoría de telemetría de 3,5 días» del preámbulo no se corresponde con ningún artefacto del repo. El repo **tiene** una tabla `audit_events` (la usan `messages.ts`, `observability.ts`, `messages/publishing.ts`), pero ni el dossier ni el `PENDIENTES` citan una query sobre ella.

**Conclusión:** el dueño va a firmar sobre una afirmación cuantitativa (0 visitas / 0 clics / 0 acciones en 3,5 días) cuya fuente no está en el repo. Si la evidencia existe, no es parte del dossier; si no existe, la cifra está inflada por invención. **No es verificable** desde este árbol.

---

### C5 — Riesgo de retirada (qué referencias vivas hay para cada vista)

**VEREDICTO:** MATIZADO — 2 son seguras, 4 requieren co-edición de vistas que se conservan, 2 no se pueden retirar limpiamente.
**AFIRMADO EN:** implicado en `PENDIENTES-DEL-DUEÑO.md:81-82` y dossier `gemini-vistas-sin-uso.md` columna «Recomendación».

**COMANDO (referencias vivas por vista):**
```
$ grep -rn "JobsRetiredNotice\|ChainPanel\|FleetAgentDetailPage\|RoleBriefTab\|AuditPanel\|HarnessStrip\|hypergraph-layout\|hypergraph\.css" \
    console/src --include="*.ts" --include="*.tsx" --include="*.css" 2>&1 | grep -v node_modules
```
**SALIDA (recortada a lo no-trivial):**
```
console/src/App.tsx:10:import { JobsRetiredNotice } from './features/landing/JobsRetiredNotice';
console/src/App.tsx:59:const FleetAgentDetailPage = lazy(async () => ({ default: (await import('./features/fleet/FleetAgentDetailPage')).FleetAgentDetailPage }));
console/src/App.tsx:93:{ id: 'jobs', label: '', icon: Boxes, component: JobsRetiredNotice },
console/src/App.tsx:262:<FleetAgentDetailPage tenantId={fleetAgentTarget.tenantId} alias={fleetAgentTarget.alias} />
console/src/features/landing/LandingPage.tsx:6:import { HarnessStrip } from './HarnessStrip';
console/src/features/landing/LandingPage.tsx:162:<HarnessStrip adapters={adapters.data?.items ?? []} error={adapters.data ? undefined : adapters.error} />
console/src/features/observability/ObservabilityPage.tsx:10:import { AuditPanel } from '../audit/AuditPanel';
console/src/features/observability/ObservabilityPage.tsx:136:<AuditPanel query={auditQuery} onQuery={setAuditQuery} />
console/src/features/live/AgentDrawer.tsx:10:import { ChainPanel } from './ChainPanel';
console/src/features/live/AgentDrawer.tsx:380:{traceId ? <ChainPanel traceId={traceId} /> : ( ... )}
console/src/features/live/DirectivaModal.tsx:7:import { RoleBriefTab, type RoleBriefTabProps } from './RoleBriefTab';
console/src/features/live/DirectivaModal.tsx:15:export interface DirectivaModalProps extends RoleBriefTabProps {
console/src/features/live/DirectivaModal.tsx:128:<RoleBriefTab ...
console/src/features/live/LiveHypergraph.tsx:19:} from '../topology/hypergraph-layout';
console/src/features/live/LiveFleetLegend.tsx:2:import { AclEdgeList } from '../topology/AclEdgeList';
console/src/features/live/LiveFleetLegend.tsx:3:import { TenantCards } from '../topology/TenantCards';
console/src/features/live/live-hypergraph/FlowArrow.tsx:1:import type { Point } from '../../topology/hypergraph-layout';
console/src/features/live/agent-state-derivation.test.ts:4:import { layoutHypergraph } from '../topology/hypergraph-layout';
```
**LECTURA por vista:**

| vista | retirada segura? | qué hay que tocar además del fichero |
|---|---|---|
| `jobs` | sí — solo `App.tsx` (drop import + drop route entry `'jobs'`) | `App.invariantes.test.tsx:35` actualiza un comentario |
| `chains` | sí — borrar `ChainPanel.tsx` + test y editar `AgentDrawer.tsx:10, 380` | `mocks/handlers.ts:37` (mock de `/v3/console/chains/:traceId` queda muerto) |
| `audit` | co-edición: borrar `AuditPanel.tsx` + `audit-summary.ts` + sus tests, editar `ObservabilityPage.tsx:10, 136` y limpieza de CSS huérfano en `styles/views.css:160-…` y `styles/responsive.css:60-86`; `mocks/handlers.ts:100` queda muerto |
| `relays` | **NO** — `ObservabilityPage.tsx` es compartido con `/signals` y `/audit`; solo se puede extraer la sub-sección «Tab 1» (~64 líneas dentro de la página de 139) y la constante `ESTADO_RELAY` (~5 líneas) |
| `topology` | **NO** — todo el directorio `topology/` (1.604 líneas) está consumido por `/live`; la única parte retirable eran los 244 de `HyperGraph.tsx` (ya caídos en `847e896`). La «retirada» aquí equivale a MOVER `hypergraph-layout*` + `AclEdgeList` + `TenantCards` al directorio `features/live/` y dejar `features/topology/` vacío (no es poda, es mudanza) |
| `fleet/:tenant/:alias` | sí — borrar `FleetAgentDetailPage.tsx` + test y editar `App.tsx:59-61, 170-175, 206-208, 259-267` (route matching, lazy import, render condicional) |
| `adapters` | co-edición: borrar `HarnessStrip.tsx` y editar `LandingPage.tsx:6, 162`; `App.tsx:111` ya tiene el alias `adapters: ''` (la ruta ya no existe) |
| `role-brief-tab` | co-edición: borrar `RoleBriefTab.tsx` + test y editar `DirectivaModal.tsx:7, 15, 128`; **pero `role-brief.ts` se queda** — lo siguen importando `DirectiveTab.tsx:8`, `HistorialRol.tsx:2`, `RolesPanel.tsx:3`, `roles.ts:1`, mocks de `handlers.ts:5, 369` y `data.ts:11`. La cuenta «role-brief-tab = 219 src» del dossier incluye 87 líneas de `role-brief.ts` que **no se pueden borrar** sin romper `HistorialRol` (que el dossier dice «conservar») y `DirectiveTab` (que el dossier da por vivo en /live). |

Resumen del riesgo: **de las 8, solo `jobs` y `fleet/:tenant/:alias` son retiradas limpias** (sin tocar vistas conservadas); otras 3 (`chains`, `audit`, `adapters`, `role-brief-tab`) requieren editar vistas que el dossier marca como conservadas; `relays` y `topology` **no son retirables** — `topology` ya está en alias en `App.tsx:110` desde antes del dossier, y `relays` no es un fichero sino un sub-componente de `ObservabilityPage.tsx`.

---

## Mensaje final — una línea por punto

- **C1 — ¿Son 8 vistas?** VERDADERO (8 elementos existen como unidades de código; 2 son sub-componentes dentro de vistas que se conservan, no rutas).
- **C2 — ¿~1.027 líneas reales de src?** **FALSO** — hoy son **783 src** en los 9 ficheros nombrados por `plano-objetivo.md:543`; los 244 de `HyperGraph.tsx` ya no existen (borrados en `847e896` 16:13, antes de la firma del `PENDIENTES` 17:07). De esos 783: **231** son limpiamente borrables, **385** requieren co-edición de vistas conservadas, **167** (`role-brief.ts` + `HarnessStrip.tsx`) son compartidos y **no deberían contarse**.
- **C3 — ¿hypergraph-layout lo usa /live?** VERDADERO — `LiveHypergraph.tsx:19`, `FlowArrow.tsx:1` y `agent-state-derivation.test.ts:4` lo importan; la advertencia del `PENDIENTES` aplica a una **mudanza** (mover `hypergraph-layout*` + `AclEdgeList` + `TenantCards` a `features/live/`), no a una poda. La única parte muerta del directorio (`HyperGraph.tsx`) ya cayó hoy.
- **C4 — «0 visitas humanas en 3,5 días»** NO RESPALDADO — el dossier lo afirma 10 veces sin pegar fuente: ni log de nginx, ni query a `audit_events`, ni artefacto ejecutable. El dueño firmaría sobre una cifra sin evidencia en el repo.
- **C5 — Riesgo de retirada** MATIZADO — 2 limpias (`jobs`, `fleet/:tenant/:alias`), 4 co-edición (`chains`, `audit`, `adapters`, `role-brief-tab`), 2 no retirables (`relays` = sub-componente de `ObservabilityPage`; `topology` ya en alias y sus ficheros son de /live).

**Cifra real de líneas a firmar:** **616 src exclusivas** (231 limpias + 385 con co-edición), no 1.027; y esa cifra incluye `role-brief.ts` 87 + `HarnessStrip.tsx` 80 que son **compartidos con vistas que se conservan** — descontándolos, **362 src** son el techo de poda realista.
