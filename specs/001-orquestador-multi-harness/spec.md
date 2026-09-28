# Feature Specification: Cauce como orquestador de agentes multi-harness

**Feature Branch**: `dev` (sin ramas de tarea; convivencia por sector según constitución IV)

**Created**: 2026-09-27

**Status**: Draft

**Input**: Cauce debe ser un orquestador de agentes multi-harness. Se volvió
innecesariamente monstruoso (+73k/−20k líneas en 922 ficheros entre `main` y
`dev`) y necesita parámetros explícitos y medibles. Establecer el SDD completo
y un plan claro de corrección + validación contra el ambiente de pruebas.

## User Scenarios & Testing

### User Story 1 - Hablar entre harness distintos (Priority: P1)

Steven (Telegram) le pide algo a argos (Claude); argos delega en un agente
Codex u OpenClaw; el resultado vuelve por Telegram. Lo mismo para Miguel →
janus, Jhon → hegel. Los 5 escenarios esenciales de
`docs/flota-y-participantes.md` son los journeys de aceptación.

**Why this priority**: es la visión punto 1 (interoperabilidad entre harness)
y el criterio de éxito del producto. Sin esto Cauce es un bus, no un
orquestador.

**Independent Test**: arnés e2e (`ops/harness/runner.mjs --live`) contra
`ops/compose.test.yaml`: publicar → reclamar con lease → ACK en escalera
`accepted>started>done|failed` → verificar efecto en BD. Verde = historia
probada.

**Acceptance Scenarios**:

1. **Given** dos agentes habilitados de harness distintos, **When** uno publica
   un mensaje al otro, **Then** el destinatario lo reclama con lease y lo
   confirma, y la BD refleja `done`.
2. **Given** un lease reclamado, **When** otro consumidor intenta reclamar la
   misma entrega, **Then** recibe 409 y la primera reclamación sigue vigente.
3. **Given** un consumidor caído a mitad de `started`, **When** vence el
   `ack_deadline`, **Then** el dispatcher re-siega la entrega para reintento.

---

### User Story 2 - Parámetros del orquestador explícitos y medibles (Priority: P1)

El operador (o el dueño) puede leer en UN lugar cada parámetro que gobierna el
sistema —presupuestos de contexto por harness, deadlines de ACK, reintentos,
cuotas, topes de fichero— con su unidad, su fuente (medido vs fijado por el
dueño) y su valor vigente. Ningún comportamiento crítico depende de una
constante escondida.

**Why this priority**: es el reto pedido ("mejor establecimiento de
parámetros") y la cura del monstruo: lo que no tiene parámetro explícito no se
puede operar, validar ni podar.

**Independent Test**: `quickstart.md` §"parámetros": un script recorre la tabla
de parámetros y verifica cada uno contra el árbol (existe, tiene test o sonda)
o lo marca `[NEEDS CLARIFICATION]` pendiente del dueño. Cero parámetros
fantasma = historia probada.

**Acceptance Scenarios**:

1. **Given** la tabla de parámetros, **When** se audita cada fila, **Then**
   toda fila tiene unidad, fuente y valor, o una pregunta abierta registrada.
2. **Given** un parámetro medido por alias (p. ej. `project_doc_max_bytes`),
   **When** cambia el hecho en runtime, **Then** el hecho medido prevalece
   sobre el defecto sin editar código.
3. **Given** dos unidades distintas (caracteres UTF-16 vs bytes UTF-8),
   **When** se aplican topes, **Then** jamás se mezclan (confundirlas yerra
   hasta 4× en manuales no ASCII).

---

### User Story 3 - Alta y baja trivial de agentes (Priority: P2)

Dar de alta un agente es una fila en BD + aprovisionar; darlo de baja es
deshabilitar en BD primero y retirar. Ninguna de las dos toca código ni N
capas (`ops/runbooks/alta-y-baja-de-agente.md`).

**Why this priority**: visión punto 2; es el freno contra el acoplamiento que
hizo crecer al monstruo.

**Independent Test**: en la pila de pruebas, insertar fila → regenerar flota →
`validate.sh` verde → el alias reclama; luego deshabilitar → `acquireLease`
rechaza con `delivery consumer is disabled`.

**Acceptance Scenarios**:

1. **Given** una fila nueva en `agents` + `memberships`, **When** corre
   `regenerate-fleet.sh` + `validate.sh`, **Then** manifests y units derivan
   byte a byte y el alias opera.
2. **Given** un agente con `enabled=false`, **When** pide lease, **Then** el
   gateway lo rechaza dentro de la transacción del lease.

---

### User Story 4 - Rescate por TUI/CLI cuando las colas se atascan (Priority: P2)

Desde cualquier dispositivo, el operador ve colas, modifica prioridades,
destraba procesos, rota credenciales y reinicia o hace rollout — por CLI y por
web (escenario esencial 5).

**Why this priority**: es la vía de rescate; sin ella un atasco (como el de
hegel o el cuello OpenClaw/jarvis) deja al dueño ciego.

**Independent Test**: contra la pila de pruebas, atascar una entrega a
propósito y destrabarla por CLI (`ops/cli/cauce`) verificando el cambio de
estado en BD.

**Acceptance Scenarios**:

1. **Given** entregas atascadas visibles en consola/CLI, **When** el operador
   re-siega o reintenta, **Then** el estado en BD cambia y queda auditado.
2. **Given** una sesión de consola sin atribución, **When** intenta escribir
   gobierno o tomar el teclado, **Then** se le niega (abrir shell y leer:
   pendiente de decisión del dueño).

---

### User Story 5 - UI multi-socio con auditoría (Priority: P3)

Cualquier socio entra con su cuenta, ve qué pasa y queda registro de
comportamiento para detectar patrones indeseables (contaminaciones de contexto).

**Why this priority**: visión puntos 5–7; depende de US1–US4 estables. Se
especifica ahora para que la poda no cierre puertas, se implementa después.

**Independent Test**: dos roles distintos ven vistas acordes a su permiso y
toda mutación deja fila de auditoría consultable.

**Acceptance Scenarios**:

1. **Given** un socio sin `config.write`, **When** abre la consola, **Then** la
   vista de config aparece deshabilitada.
2. **Given** cualquier mutación, **When** se consulta la auditoría, **Then**
   aparece quién, qué y cuándo.

---

### Edge Cases

- Lease perdido a mitad de consumo: el perdedor descarta buffer, marca
  `fenced` y NO confirma; el ganador conserva el claim.
- ACK de epoch vieja: sólo se rescata si es terminal; cualquier otro se
  rechaza y cierra con 4401 en WS.
- Tag de framing desconocido en terminal-relay: corta la conexión completa
  (comportamiento actual documentado; revisar si debe aislarse por sesión).
- Reinicio del relay: mata terminales por diseño; la consola debe anunciarlo
  de inmediato, no operar a ciegas.
- `enabled=false` a mitad de lease: el lease vigente termina, no se renueva.
- Base de pruebas compartida entre suites: prohibido; una base efímera por
  fichero (las suites de integridad envenenan `schema_migrations` a propósito).

## Requirements

### Functional Requirements

- **FR-001**: El sistema MUST entregar mensajes entre agentes de harness
  distintos (claude, codex, openclaw) con leases cercados por
  `claim_token` + `epoch` + intento.
- **FR-002**: El sistema MUST exponer la tabla única de parámetros del
  orquestador con unidad, fuente (medido/dueño) y valor vigente por fila.
- **FR-003**: El sistema MUST aplicar presupuestos de contexto por harness
  desde `PRESUPUESTOS_DE_CONTEXTO` sin mezclar unidades jamás.
- **FR-004**: El gateway MUST rechazar leases de consumidores deshabilitados
  dentro de la transacción (`delivery consumer is disabled`).
- **FR-005**: El dispatcher MUST re-segar entregas vencidas (`ack_deadline`)
  para reintento con backoff acotado.
- **FR-006**: El operador MUST poder destrabar entregas por CLI y por consola,
  con auditoría de cada acción.
- **FR-007**: La consola MUST negar escritura de gobierno y toma de teclado a
  sesiones sin atribución.
- **FR-008**: El sistema MUST regenerar manifests/units byte a byte desde
  `ops/flota.json` y fallar `validate.sh` ante cualquier deriva.
- **FR-009**: El sistema MUST correr el gate completo en el propio host
  (timer local), nunca en GitHub Actions.
- **FR-010**: El sistema MUST validar cada release contra `ops/compose.test.yaml`
  (migración + gateway + dispatcher saludables + arnés e2e verde) antes de
  publicar `main`.
- **FR-011**: El sistema MUST [NEEDS CLARIFICATION: presupuesto de contexto de
  claude y hermes — no hay tope medido; el dueño debe fijar número o aceptar
  sólo el techo nativo].
- **FR-012**: El sistema MUST [NEEDS CLARIFICATION: retención y poda de
  grabaciones de TUI — se escriben 0600 con tope por sesión y nadie las borra].
- **FR-013**: El sistema MUST [NEEDS CLARIFICATION: poda de `secret.granted`
  y de auditoría sin tope].
- **FR-014**: El sistema MUST [NEEDS CLARIFICATION: si la recarga de contexto
  por el propio alias se acepta o es sólo de operador].
- **FR-015**: El sistema MUST [NEEDS CLARIFICATION: SLO de latencia por
  escenario esencial — sin número del dueño no hay "cuello de botella" medible].

### Key Entities

- **Agent**: fila en `agents`; identidad (tenant, alias, harness), `enabled`,
  credenciales rotables. Nada sin fila existe para el sistema.
- **Membership**: fila en `memberships`; quién puede hablar con quién y con
  qué alcances.
- **Message**: fila en `messages`; cuerpo dirigido de un agente a N
  destinatarios.
- **Delivery**: fila en `deliveries` por destinatario; 8 estados; reclamable
  con lease.
- **Claim/Lease**: `claim_token` + `epoch` + intento + `ack_deadline`;
  contrato vivo entre gateway y consumidor.
- **ContextRevision**: revisión del contexto nativo por harness con fencing
  por generación de contenedor (larga y corta).
- **Parámetro del orquestador**: unidad + fuente + valor vigente; medido en
  runtime o fijado por el dueño, nunca inventado.

## Success Criteria

### Measurable Outcomes

- **SC-001**: El arnés e2e contra `ops/compose.test.yaml` corre verde
  (publicar → reclamar → ACK → efecto en BD) en cada validación de release.
- **SC-002**: `pnpm typecheck && pnpm lint && pnpm test:unit` verde en `dev`
  antes de cada commit de código; `pnpm test` completo verde en el nocturno.
- **SC-003**: Cero parámetros fantasma: toda fila de la tabla de parámetros
  tiene unidad + fuente + valor o pregunta abierta registrada para el dueño.
- **SC-004**: El conteo de ficheros sobre el tope de `calidad.mjs` sólo baja
  (hoy 19 por encima de 800); ningún fichero nuevo lo supera.
- **SC-005**: Deuda de despliegue a cero: toda fila de `HISTORIAL.md`
  pendiente queda registrada o explícitamente recortada por el dueño.
- **SC-006**: Los 5 escenarios esenciales son ejecutables y verificables:
  cada uno tiene camino de prueba documentado en `quickstart.md`.

## Assumptions

- La flota viva (kratos, BD productiva) sólo la toca el dueño; este spec
  valida contra la pila de pruebas y el árbol, no contra producción.
- El ambiente de pruebas es `ops/compose.test.yaml` en el propio host
  (verificado: imágenes construyen, servicios arrancan saludables).
- Los 14 agentes / 4 tenants de `ops/flota.json` son la flota de referencia
  hasta que la BD diga otra cosa.
- `docs/roadmap.md`, `docs/v3.1-pendientes.md` y `docs/version-3.1.md` siguen
  vigentes; este spec los ordena, no los reemplaza.
