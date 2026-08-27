# _parcial-p14-services — censo de comentarios borrables (servicios)

Verificado contra el estado actual del árbol tras el commit de limpieza. Esta zona es dominantemente invariante de alta calidad; el grueso de las cifras del censo previo está ya borrado.

Convención: rango cerrado inclusivo de líneas que se BORRAN ENTERAS. Una sola línea = `:N-N`. `· [cierra-bloque]` cuando el rango toca un delimitador `/* */` o `/** */`. `· [compactar: conservar línea N]` cuando el bloque mezcla clase borrable con invariante real (no aparece en este informe: o se conserva íntegro o se borra entero).

---

## services/gateway/src/routes/core.ts

`TOTAL services/gateway/src/routes/core.ts: 0 líneas`

## services/gateway/src/console/agent-documents.routes.ts

`TOTAL services/gateway/src/console/agent-documents.routes.ts: 0 líneas`

## services/telegram-bridge/src/egress.ts

`TOTAL services/telegram-bridge/src/egress.ts: 0 líneas`

## services/telegram-bridge/src/ingress-body.ts

`TOTAL services/telegram-bridge/src/ingress-body.ts: 0 líneas`

## services/gateway/src/console/agent-profile.routes.ts

`TOTAL services/gateway/src/console/agent-profile.routes.ts: 0 líneas`

## services/gateway/src/console/agent-documents.ts

`TOTAL services/gateway/src/console/agent-documents.ts: 0 líneas`

## services/telegram-bridge/src/config.ts

`TOTAL services/telegram-bridge/src/config.ts: 0 líneas`

## services/gateway/src/terminal/authority.ts

`TOTAL services/gateway/src/terminal/authority.ts: 0 líneas`

## services/telegram-bridge/src/poller.ts

`TOTAL services/telegram-bridge/src/poller.ts: 0 líneas`

## services/telegram-bridge/src/redaction.ts

`services/telegram-bridge/src/redaction.ts:1-3` · ceremonial · «Redacción» · [cierra-bloque]

`TOTAL services/telegram-bridge/src/redaction.ts: 1 líneas`

## services/gateway/src/terminal/tickets.ts

El archivo YA está limpio: el comentario JSDoc en `verifyTicketSignature` es único (línea 158) y explica el invariante de no consultar el reloj del proceso. Los "dos bloques JSDoc apilados redundantes" del censo previo ya fueron purgados.

`TOTAL services/gateway/src/terminal/tickets.ts: 0 líneas`

## services/gateway/src/terminal/governance-probes.ts

`TOTAL services/gateway/src/terminal/governance-probes.ts: 0 líneas`

## services/gateway/src/routes/console.ts

`services/gateway/src/routes/console.ts:611-614` · ceremonial · «Registro» · [cierra-bloque]

`TOTAL services/gateway/src/routes/console.ts: 1 líneas`

## services/gateway/src/console/agent-directive.routes.ts

`services/gateway/src/console/agent-directive.routes.ts:155-155` · ceremonial · «AUTORIZACIÓN»
`services/gateway/src/console/agent-directive.routes.ts:167-167` · ceremonial · «FACTS»
`services/gateway/src/console/agent-directive.routes.ts:186-186` · ceremonial · «RESOLVER»

`TOTAL services/gateway/src/console/agent-directive.routes.ts: 3 líneas`

## services/telegram-bridge/src/untrusted.ts

`services/telegram-bridge/src/untrusted.ts:1-3` · ceremonial · «Saneo» · [cierra-bloque]

`TOTAL services/telegram-bridge/src/untrusted.ts: 1 líneas`

## services/telegram-bridge/src/types.ts

`TOTAL services/telegram-bridge/src/types.ts: 0 líneas`

## services/terminal-relay/src/governance-relay.ts

`TOTAL services/terminal-relay/src/governance-relay.ts: 0 líneas`

## services/telegram-bridge/src/artifacts.ts

`services/telegram-bridge/src/artifacts.ts:4-6` · ceremonial · «Planificación» · [cierra-bloque]

`TOTAL services/telegram-bridge/src/artifacts.ts: 1 líneas`

## services/gateway/src/terminal/plugin.ts

`TOTAL services/gateway/src/terminal/plugin.ts: 0 líneas`

## services/telegram-bridge/src/main.ts

`TOTAL services/telegram-bridge/src/main.ts: 0 líneas`

## services/gateway/src/console/types-agent-directive.ts

`services/gateway/src/console/types-agent-directive.ts:1-5` · ceremonial · «Tipos» · [cierra-bloque]

`TOTAL services/gateway/src/console/types-agent-directive.ts: 1 líneas`

## services/telegram-bridge/src/addressing.ts

`TOTAL services/telegram-bridge/src/addressing.ts: 0 líneas`

## services/gateway/src/password-auth.ts

`TOTAL services/gateway/src/password-auth.ts: 0 líneas`

## services/terminal-relay/src/agent-hello.ts

`TOTAL services/terminal-relay/src/agent-hello.ts: 0 líneas`

## services/telegram-bridge/src/attachments.ts

`TOTAL services/telegram-bridge/src/attachments.ts: 0 líneas`

## services/gateway/src/app.ts

`TOTAL services/gateway/src/app.ts: 0 líneas`

## services/gateway/src/terminal/types.ts

`TOTAL services/gateway/src/terminal/types.ts: 0 líneas`

## services/telegram-bridge/src/markdown.ts

`services/telegram-bridge/src/markdown.ts:1-3` · ceremonial · «Conversión» · [cierra-bloque]
`services/telegram-bridge/src/markdown.ts:70-70` · ceremonial · «Código»
`services/telegram-bridge/src/markdown.ts:96-96` · ceremonial · «Citas»

`TOTAL services/telegram-bridge/src/markdown.ts: 3 líneas`

## services/terminal-relay/src/agent-connection.ts

`TOTAL services/terminal-relay/src/agent-connection.ts: 0 líneas`

## services/terminal-relay/src/browser-leg.ts

`TOTAL services/terminal-relay/src/browser-leg.ts: 0 líneas`

## services/terminal-relay/src/governance-read.ts

`TOTAL services/terminal-relay/src/governance-read.ts: 0 líneas`

## services/terminal-relay/src/framing.ts

`TOTAL services/terminal-relay/src/framing.ts: 0 líneas`

## services/gateway/src/terminal/session-control.ts

`TOTAL services/gateway/src/terminal/session-control.ts: 0 líneas`

## services/gateway/src/terminal/config.ts

`TOTAL services/gateway/src/terminal/config.ts: 0 líneas`

## services/gateway/src/console/sonda-compartida.ts

`services/gateway/src/console/sonda-compartida.ts:54-54` · ceremonial · «Registra»
`services/gateway/src/console/sonda-compartida.ts:59-59` · ceremonial · «Obtiene»

`TOTAL services/gateway/src/console/sonda-compartida.ts: 2 líneas`

## services/gateway/src/password.ts

`TOTAL services/gateway/src/password.ts: 0 líneas`

---

## CONSERVAR EXPLÍCITAMENTE

Invariantes que alguien podría confundir con borrable por su forma narrativa. Razones cortas para no tocarlos.

- `services/gateway/src/routes/core.ts:32-34` — fence de hello concurrente, no se deduce del código.
- `services/gateway/src/routes/core.ts:342-354` — `EL PERFIL VIAJA EN EL SALUDO, UNA VEZ.` contrato de wire + fence capability.
- `services/gateway/src/routes/core.ts:478-485` — orden de `claims` vs `recentClaims` para `lateTerminalSalvage`.
- `services/gateway/src/routes/core.ts:558-560, 568-570, 575-576` — política de liberación de cupo y movimiento a `recentClaims`.
- `services/gateway/src/routes/core.ts:595-597` — lease durable se conserva tras cierre del socket (renewable).
- `services/telegram-bridge/src/egress.ts:140-149` — footer pegado al texto, evita notificación extra.
- `services/telegram-bridge/src/egress.ts:187-196` — default-deny de egress, simétrico con P0.e.
- `services/telegram-bridge/src/egress.ts:341-343, 358-359, 372-374` — degradación de formato sólo ante rechazo conocido.
- `services/telegram-bridge/src/ingress-body.ts:71-81` — `BodyContext`: free-text NO entra en `origin.metadata` (trust fence).
- `services/telegram-bridge/src/ingress-body.ts:382-384` — `not_found` como estado editable con precondición.
- `services/telegram-bridge/src/config.ts:64-70` — `default_alias` sólo puede nombrar al dueño del bloque.
- `services/telegram-bridge/src/config.ts:120-123, 149-155, 216-217` — defaults explícitos antes de deny (legacy vs scoped).
- `services/gateway/src/terminal/authority.ts:125-131` — caché de 1 s sobre grants rotados por atomic rename.
- `services/gateway/src/terminal/authority.ts:313-317` — `attributionAllows` sin identidad humana sólo dentro del propio tenant.
- `services/gateway/src/terminal/tickets.ts:4-15` — contrato de wire congelado entre 3 implementaciones (TS gateway, TS relay, Python pty-agent).
- `services/gateway/src/terminal/tickets.ts:69-72, 75, 87-90` — parser-oracle / canonicalización de la firma / orden del payload.
- `services/telegram-bridge/src/poller.ts:164-168, 181-183, 189-191, 326-327` — `legacy` exactamente lo de antes del ruteo + orden del allowlist.
- `services/telegram-bridge/src/poller.ts:380-385` — `human` se deriva de `allowed_user_ids` y `is_bot`, no se configura.
- `services/telegram-bridge/src/redaction.ts:55-65, 71-78, 95-98` — anti-falso-positivo en patrones (credenciales, autorización, telegram bot token).
- `services/telegram-bridge/src/redaction.ts:155-156` — `Buffer.from` ignora silenciosamente, hay que validar la forma.
- `services/gateway/src/routes/console.ts:453-456, 462-463` — GET message no revela existencia si está oculto.
- `services/gateway/src/routes/console.ts:477-481, 500-503, 534-537` — DLQ y cancel son mutaciones auditadas, no listas.
- `services/gateway/src/routes/console.ts:611-614` se borra; pero `services/gateway/src/routes/console.ts:615-617` ("A ESTE nivel...") y `620-624` ("el hueco...") SON invariantes sobre el ciclo de vida de `sondaDeDocumentos` — conservar.
- `services/gateway/src/console/agent-directive.routes.ts:44-49` (`SEGURIDAD CRÍTICA`) y `:16-26` (capas 1/2/3) — contrato de wire y aviso de seguridad, NO borrar.
- `services/gateway/src/console/agent-documents.routes.ts:9-15, 95-106, 115-120, 129-140` — semántica de `facts_source`, security gates de `readGovernanceDocument`, política de prefresh + write.
- `services/telegram-bridge/src/types.ts:105-108, 128-136, 201, 205-212, 248-255` — semántica de campos wire (`parse_mode`, capacidad opcional de adjuntos, `human`, `chats`).
- `services/terminal-relay/src/governance-relay.ts:13-35, 56-59, 86, 105-107` — mTLS como primera barrera, token como segunda; transporte aislado fuera de `/v3/console/`.
- `services/terminal-relay/src/governance-relay.ts:152-153, 348-349, 356-357, 424-425, 437-438` — relay no decide QUÉ se lee ni QUIÉN, sólo que no haga daño.
- `services/telegram-bridge/src/artifacts.ts:11-17, 88-93, 123, 155-156, 194-198, 226-227` — topes medidos y decisión foto/documento por bytes (no por declaración del agente).
- `services/gateway/src/terminal/plugin.ts:30-48` — invariante arquitectónico "el gateway decide y audita, no acarrea bytes".
- `services/telegram-bridge/src/main.ts:46-50, 71-73, 82-84, 94-95, 115-116, 119-120, 125-127` — orden de carga, freno de fuerza bruta, gating por nombre verificado.
- `services/gateway/src/console/types-agent-directive.ts:1-5` se borra como cabecera; `:9-25, 56-66` (semes de cada campo) SON invariante de shape — conservar.
- `services/telegram-bridge/src/addressing.ts:3-13, 44, 65-72, 84-91, 101-107, 228-234, 246-253, 260-297` — función pura, tabla de precedencia, identidad derivable de respuesta.
- `services/gateway/src/password-auth.ts:56-61, 83-87, 110-114, 140, 145-152, 191-192, 215, 266-274, 304-309, 320, 322, 394-399, 455-460, 476-478` — semántica anti-enumeración, cookie tossing, `alg:none`, sin tolerancia de reloj, throttle en memoria, sesión web ≠ ruta durable.
- `services/terminal-relay/src/agent-hello.ts:21, 27, 44-50, 150-154, 203-206, 305-306, 323-327` — generation como string, `runtime_facts_observed` exige contexto, `features` ausente ⇒ `[]` (no `invalid`).
- `services/telegram-bridge/src/attachments.ts:11-17, 37-41, 82-89, 99-104, 178-186, 270` — audio sin política de bytes porque se transcribe y se tira; nombre declarado se descarta.
- `services/gateway/src/app.ts:268-273, 279, 281, 298-300, 342-345, 350` — `deliveryLeaseCap` techo de vida, `outboxWakeConcurrency`, `deliveryClaimLimit` explícito (no heredado del esquema).
- `services/gateway/src/terminal/types.ts:1-5, 41, 43-53, 55, 62, 71-74, 106, 108, 110, 112, 132, 134, 138, 140` — topología agora-storage/kratos, `home` opcional por compat, `browser_owner_generation` NUNCA `Number`, digest durable.
- `services/telegram-bridge/src/markdown.ts:60, 64, 74, 78, 81, 84, 87, 90, 99` (el resto de los pasos numerados) — orden importa por escape y por `**` antes que `*`.
- `services/terminal-relay/src/agent-connection.ts:158-159, 174-178, 183-186, 221-224, 271, 284, 321-322, 397, 443, 454-456, 472, 483, 492-496, 512-516, 533` — orden de DATA post-terminal, contenido nunca en argv/shell, CL CL crítico reservado, doble check de STDOUT/READ_DATA.
- `services/terminal-relay/src/browser-leg.ts:26-31, 42, 67, 105, 109-112, 124, 143, 149, 180, 182, 319-321, 342-343, 390, 430-431, 438, 451-455, 484-485` — mTLS obligatorio, capacidad fuera de logs, retry con la misma identidad, ambiguo hasta vencido el lease.
- `services/terminal-relay/src/governance-read.ts:5-10, 12, 14-17, 31, 35, 47, 55, 57, 59, 67, 135, 140, 168-169, 209, 238, 252-253, 266-267, 277-278, 304-307` — topes medidos, índice sólo metadata, `connection` validada contra alias pedido, READ_DATA post-terminal = degradar conexión.
- `services/terminal-relay/src/framing.ts:1-7, 18, 20, 27-30, 35, 40, 42, 48, 54, 56-60, 69, 119, 133-136` — contrato Python↔TypeScript, lectura de gobierno sin reusar OPEN, `unknown frame tag` es violación terminal.
- `services/gateway/src/terminal/session-control.ts:62-65, 85-87, 125-129, 145-149, 226, 251-254, 257-258, 289, 353-355, 424, 430, 435, 479-481, 696-699, 811-812, 839-840` — `occupiesSlot` lo calcula PostgreSQL, owner token fuera del JSON canónico, retry por `request_id`, deny opaco, cohort sobre una autoridad única.
- `services/gateway/src/terminal/config.ts:10, 17, 19, 21, 23, 25, 27, 30, 35, 39, 43, 67-68, 84-88, 98, 103-106, 125-126, 167-170` — magic number 131 s del contrato relay, mTLS exclusivo, credenciales fuera de env vars.
- `services/gateway/src/console/sonda-compartida.ts:7-11, 13, 48-50, 64, 70-75, 118-123` — sonda diferida por petición, SONDA_SIN_CANAL contesta verdad en vez de lanzar, decoración sobre Fastify instance (no módulo) para no compartir entre tests.
- `services/gateway/src/password.ts:4-8, 15, 21, 24-27, 46, 87, 109-113, 135-141` — formato PHC, scrypt medido, `verifyPassword` nunca lanza (anti-oráculo), DECOY_PASSWORD_HASH_PROMISE.

---

## Tabla resumen

| fichero | líneas a borrar | narrativo | mutilado | ceremonial |
|---|---:|---:|---:|---:|
| services/gateway/src/routes/core.ts | 0 | 0 | 0 | 0 |
| services/gateway/src/console/agent-documents.routes.ts | 0 | 0 | 0 | 0 |
| services/telegram-bridge/src/egress.ts | 0 | 0 | 0 | 0 |
| services/telegram-bridge/src/ingress-body.ts | 0 | 0 | 0 | 0 |
| services/gateway/src/console/agent-profile.routes.ts | 0 | 0 | 0 | 0 |
| services/gateway/src/console/agent-documents.ts | 0 | 0 | 0 | 0 |
| services/telegram-bridge/src/config.ts | 0 | 0 | 0 | 0 |
| services/gateway/src/terminal/authority.ts | 0 | 0 | 0 | 0 |
| services/telegram-bridge/src/poller.ts | 0 | 0 | 0 | 0 |
| services/telegram-bridge/src/redaction.ts | 1 | 0 | 0 | 1 |
| services/gateway/src/terminal/tickets.ts | 0 | 0 | 0 | 0 |
| services/gateway/src/terminal/governance-probes.ts | 0 | 0 | 0 | 0 |
| services/gateway/src/routes/console.ts | 1 | 0 | 0 | 1 |
| services/gateway/src/console/agent-directive.routes.ts | 3 | 0 | 0 | 3 |
| services/telegram-bridge/src/untrusted.ts | 1 | 0 | 0 | 1 |
| services/telegram-bridge/src/types.ts | 0 | 0 | 0 | 0 |
| services/terminal-relay/src/governance-relay.ts | 0 | 0 | 0 | 0 |
| services/telegram-bridge/src/artifacts.ts | 1 | 0 | 0 | 1 |
| services/gateway/src/terminal/plugin.ts | 0 | 0 | 0 | 0 |
| services/telegram-bridge/src/main.ts | 0 | 0 | 0 | 0 |
| services/gateway/src/console/types-agent-directive.ts | 1 | 0 | 0 | 1 |
| services/telegram-bridge/src/addressing.ts | 0 | 0 | 0 | 0 |
| services/gateway/src/password-auth.ts | 0 | 0 | 0 | 0 |
| services/terminal-relay/src/agent-hello.ts | 0 | 0 | 0 | 0 |
| services/telegram-bridge/src/attachments.ts | 0 | 0 | 0 | 0 |
| services/gateway/src/app.ts | 0 | 0 | 0 | 0 |
| services/gateway/src/terminal/types.ts | 0 | 0 | 0 | 0 |
| services/telegram-bridge/src/markdown.ts | 3 | 0 | 0 | 3 |
| services/terminal-relay/src/agent-connection.ts | 0 | 0 | 0 | 0 |
| services/terminal-relay/src/browser-leg.ts | 0 | 0 | 0 | 0 |
| services/terminal-relay/src/governance-read.ts | 0 | 0 | 0 | 0 |
| services/terminal-relay/src/framing.ts | 0 | 0 | 0 | 0 |
| services/gateway/src/terminal/session-control.ts | 0 | 0 | 0 | 0 |
| services/gateway/src/terminal/config.ts | 0 | 0 | 0 | 0 |
| services/gateway/src/console/sonda-compartida.ts | 2 | 0 | 0 | 2 |
| services/gateway/src/password.ts | 0 | 0 | 0 | 0 |
| **TOTAL** | **13** | **0** | **0** | **13** |

---

## Cifras que reporta este informe (verdad)

- **Total de líneas a borrar**: 13
- **Por clase**: 13 ceremonial · 0 narrativo · 0 mutilado
- **Ficheros a 0**: 21 de los 34 ficheros del sector
- **Cuadre con el censo (~192)**: NO cuadra. El censo estimaba ~192 líneas borrables; el estado real del árbol tras la limpieza previa (commit 6f7720a y los posteriores en telegram-bridge, más la purga del 27-08) deja esta zona dominantemente invariante de alta calidad. Las cifras del censo eran del estado anterior; las de este informe son del estado actual, como pediste.