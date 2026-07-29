# Pendientes — corte del 2026-07-25, 23:00 UTC

Todo lo que quedó abierto: lo que se saltó para entregar Prometeo, y lo que tiene cada agente de la
flota. Los estados de agentes no son un resumen de lo que yo creía: se le preguntó a los 14 por el
bus a las 22:54 y esto es lo que contestaron.

**Cómo leer la evidencia.** Una respuesta en `done` **no prueba** que el agente ejecutó. Kant contestó
a las 22:55 *"no tengo tareas en curso, pendientes ni bloqueos"* y a las 22:59, ante una sonda con el
hash esperado guardado, contestó `NO PUEDO EJECUTAR / bwrap: No permissions to create a new
namespace`. **No puede correr un solo comando: su primera respuesta era inventada.** Cualquier
"no tengo nada pendiente" de esta lista vale lo que valga la capacidad de ejecutar de quien lo dijo.

---

## 1. La flota: 14 alias, 4 con trabajo, 1 cadáver

Las 14 unidades systemd están `active running` en kratos. 13 corren el bundle
`bus-v3-20260725-mediafix-e25ca5630310`; jarvis sigue en `bus-v3-20260725-headroll-aa03f3f`.

| Alias | Tenant | Estado | Qué pasa |
|---|---|---|---|
| **kant** | Steven | 🔴 **muerto** | No ejecuta. `bwrap: No permissions to create a new namespace`. Responde conversando y **fabrica** estado. |
| **vulcano** | Pablo | 🟠 capado | Bash bloqueado por *don't ask mode*; solo pasa `ls`. |
| **janus** | Miguel | 🟠 capado | Claude Code sin auth: `OAuth session expired and could not be refreshed`. |
| **hegel** | Jhon | 🟠 sin canal | Ejecuta bien, pero no tiene por dónde hablarle a Jhon. |
| **jarvis** | Steven | 🟡 sin credencial | Ejecuta; le falta sesión del panel DEV de Prometeo. Único en bundle viejo. |
| argos, atlas, dedalo, iza, kratos, midas, salva, seneca, socrates | varios | 🟢 ociosos | "Nada en curso, nada pendiente, sin bloqueos." Nueve alias sanos y **sin trabajo asignado**. |

> El dato incómodo no es que estén rotos: es que **nueve agentes verificados están sin hacer nada**
> porque nadie les asignó nada. La capacidad está ahí, ociosa.

### 1.1 Los cuatro bloqueos concretos

**kant — desbloquear la ejecución** · el bloqueo raíz de la tarea #12 de seccomp
Su contenedor `ctrl-infra` nunca se recreó con el perfil acotado. El perfil ya está escrito y
commiteado (`ops/security/seccomp-userns.json`, commit `69b48ce`): habilita `clone`/`unshare` para
bwrap sin apagar el filtro. Falta recrear el contenedor con ese perfil y con `Init` activado — hoy
corre `sleep infinity` como PID 1 y acumula 3.700+ zombies.
Runbook relacionado, sin commitear: `ops/runbooks/salva-bwrap-namespace-fix.md`.

**vulcano — allowlist de `git` y `node`**
> *"Permission to use Bash has been denied because Claude Code is running in don't ask mode"*

Con eso caído no puede ni verificar git ni correr `node --test`. Lo que reportó de su último trabajo
(T100 scaffold, `/workspace/work/novacode-sales-scaffold`, 13/13 tests) lo leyó de artefactos viejos,
**no lo re-verificó hoy**, y lo dijo. Se arregla en el `settings.json` de ws-pablo.

**janus — reautenticar Claude Code**
`OAuth session expired and could not be refreshed`. Es el mismo procedimiento que se usó anoche para
la VPS de Prometeo (tmux con `remain-on-exit on` + `pipe-pane`; el CLI necesita eventos de teclado
reales, un fifo no sirve). Además espera conexión de Google Workspace, que coordina con Miguel.

**hegel — no tiene canal para hablarle a Jhon** · tarea #11
Dos caminos y los dos fallan:
- Telegram → `unsupported channel: telegram`
- sesión directa → `Session send visibility is restricted to the current session tree`

Tiene además la cotización **Polidinámica v2** terminada esperando decisión de pricing y autorización
de envío, y le falta la contraseña de aplicación de Gmail. **Todo eso está frenado por el mismo canal
que no existe.** Arreglar el puente de Telegram para hegel destraba las tres cosas de una.

**jarvis — sesión del panel DEV**
`/cuentas` redirige a `/login`. Meta/Instagram sí está autenticado; lo que falta es la credencial del
panel. Necesita eso para repetir el OAuth real de Instagram en Prometeo DEV.

### 1.2 Trabajo de Pablo que espera un dato suyo

vulcano dejó dos cosas a medio metro de la meta:
- Dos repos locales **sin remote**: no hay destino de push. Requiere luz verde humana.
- Landing `novacode-agentes-ia`: los 2 CTAs de `#contacto` apuntan a `novacode.com.co/home` porque no
  hay WhatsApp/email/form real de Novacode. **Son 2 `href`, 5 minutos**, en cuanto llegue el dato de
  Pablo Uzuriaga.

---

## 2. Deuda de Cauce V3 que se saltó por entregar Prometeo

### 2.1 🔴 Dos commits colgando, sin rama, a un `git gc` de desaparecer

```
5f65b353  fix(adapter): verify claude harness has required version (pinned 2.1.218)
          → ops/scripts/container-adapter-supervisor.sh  (+41)
bf3254df  fix(ops): run supervisor suite under a non-root identity
          → ops/tests/container-supervisor.test.mjs      (+46 −3)
```

`git branch --contains` devuelve **vacío** para los dos: no están en `main` ni en ninguna rama. Existen
solo como objetos sueltos. Es lo más urgente y lo más barato de esta lista: darles rama antes que nada.

### 2.2 🟠 El release gate incentiva falsificar la evidencia · tarea #13

`source-digest.py` incluye `apps/console` en el digest. Cualquier cambio de consola invalida la
evidencia de inyección de fallos del runtime — evidencia que es cara de regenerar y que no tiene nada
que ver con la consola. El resultado predecible es que alguien la edite a mano en vez de recorrerla.
Ya pasó. Hay que sacar `apps/console` del digest de runtime o partir el gate en dos.

### 2.3 🟠 CI/CD propio: el plan obvio era peligroso · tarea #10

Steven no quiere usar el GCP que paga Miguel. La alternativa evidente era `agora-forgejo`, y la fase
de crítica encontró que **es el almacenamiento de producción de Agora**: 43 usuarios reales, 40
repos, Actions ya habilitado, y el binario escanea `.github/workflows`. Un runner global le habría
dado a los 43 usuarios ejecución de código **en la misma máquina que corre el core de Cauce V3**.

Opciones vivas: forge separado · runner atado a repos específicos y jamás global · otro host.
Nota operativa: el MCP `cloud-offload` cortó por timeout 3 veces a 1800 s, así que la delegación
externa no está disponible para replantear esto.

### 2.4 🟡 jarvis en el bundle viejo

Único alias sin el arreglo de adjuntos (`e25ca56`): si le llega un mensaje con solo imagen o audio,
deja al usuario sin respuesta. El rollout lo salteó a propósito porque tenía trabajo en vuelo, y
reiniciar un adaptador con una entrega en `leased`/`started` la mata sin que se re-reclame sola.

**Ahora mismo jarvis reporta "no hay ejecución en curso": es la ventana.** El script está listo en el
scratchpad, hace compare-and-swap contra el bundle esperado y no pisa nada si otro ya migró. La
migración automática anterior se canceló; **espera tu OK para correrla**.

### 2.5 🟡 Consola: terminales visibles pero sin motor · tarea #3

Ruteo y navegación SPA desplegados (`9fe0c03`). La UI de terminales está en producción pero
**headless**: no hay contenedor `terminal-relay` en el compose de producción, así que la página
Terminal da 502 por diseño. O se despliega el relay o se esconde la entrada del menú — hoy parece
rota sin estarlo.

Sin commitear en el worktree:
```
 M apps/console/src/features/terminal/OperatorWorkspace.tsx
 M apps/console/src/features/terminal/terminal-panel.css
?? ops/runbooks/salva-bwrap-namespace-fix.md
?? packages/store/test/materialization-crosstenantroom-postgres.test.ts
```

### 2.6 🟢 Test desactualizado en el emisor de Instagram · tarea #15

El arreglo de float64 cambió `.json()` por `.text()` en `instagram-reply-sender`; el mock solo
implementa `json()`. **Producción funciona y está verificada** — es el doble de prueba el que quedó
viejo. Cosmético, pero va a confundir al próximo que toque ese archivo.

---

## 3. Prometeo: lo que quedó abierto

Funciona de punta a punta. Primera respuesta real a las 20:51:47, 8 segundos, con ID de mensaje de
Meta. Los dos hilos de prueba (`stev_vallejo`, `jhon_alv_r`) volvieron a `handler=bot`, que era por
qué ni vos ni el tester recibían respuesta. **Decile al tester que vuelva a escribir.**

Lo que falta:

1. **Catálogo real de Specula.** Hoy responde con lo que hay cargado. Faltan 3–5 productos con
   precios reales y 2–4 políticas (envío, garantía, pago, devoluciones). Es lo único que separa las
   respuestas de "convincentes" de "correctas", y el cliente vende cursos de maestrías en salud.
2. **Qué pasa después de escalar.** Cuando el bot escala, el hilo queda en `handler=human` y ahí se
   queda. Recomendación: devolverlo a `bot` tras N horas sin respuesta humana, avisando al lead.
   **Es un sí/no tuyo**, porque define si un lead puede quedar en silencio indefinido.
3. **Rotar el token OAuth** que se filtró al transcript. Ya borré la grabación del servidor y dejé
   `/etc/prometeo/dev.env` en 0600 root:root, pero **el token sigue siendo válido hasta que lo rotes**.

---

## 4. Lo que depende de vos y de nadie más

| # | Qué | Por qué solo vos | Desbloquea |
|---|---|---|---|
| 1 | **Rotar el token OAuth filtrado** | Es tu credencial | Cierra la exposición |
| 2 | **Catálogo de Specula**: 3–5 productos con precios + 2–4 políticas | Solo el cliente tiene los datos | Que las respuestas sean *correctas*, no solo verosímiles |
| 3 | **Sí/no**: ¿el hilo vuelve al bot tras N horas sin humano? | Decisión de producto | Que ningún lead quede en silencio |
| 4 | **OK para migrar jarvis** ahora que está ocioso | Cancelaste la corrida anterior | Último alias con el bug de adjuntos |
| 5 | **Aprobar des-privilegiar ws-prizma / ws-humanizar** | Cambia el modelo de seguridad de tu flota | Cierra #12, unifica los dos modelos |
| 6 | **Dato de contacto de Novacode** (de Pablo Uzuriaga) | Es de Pablo | 2 hrefs, 5 min de vulcano |
| 7 | **Método de pago de GitHub** | Es tu cuenta | Opciones de CI/CD |
| 8 | **Decisión de pricing de Polidinámica v2** + autorización de envío | Es comercial tuyo/de Jhon | Trabajo terminado de hegel |

Todo lo demás de este documento lo puedo hacer yo o repartir entre los nueve agentes ociosos.

---

## 5. Orden sugerido

1. **Darle rama a los dos commits colgando** — minutos, y es lo único que puede perderse solo.
2. **Destrabar kant** (perfil seccomp + `Init`) — es el bloqueo raíz de #12 y devuelve un alias.
3. **Destrabar vulcano y janus** — allowlist y reauth; devuelven dos alias más con trabajo real detrás.
4. **Puente de Telegram para hegel** — un arreglo, tres pendientes suyos liberados.
5. **jarvis al bundle nuevo** mientras la ventana esté abierta.
6. **Relay de terminales**: desplegarlo o esconder el menú.
7. **Release gate** — sacar `apps/console` del digest de runtime.
8. **CI/CD** — replantear con las tres opciones vivas, nunca un runner global sobre `agora-forgejo`.
