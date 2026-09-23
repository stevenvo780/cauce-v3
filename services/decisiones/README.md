# Servicio de decisiones (Jev)

Los agentes de la flota le preguntan a **Jev** (System One de TypeSafe) las decisiones típicas: a quién
rutear, qué urgencia tiene un mensaje, si una acción pide aprobación humana, qué clase de fallo es.
Una decisión cuesta unos 875 tokens de entrada (USD 0,00004) y devuelve respuestas tipadas con su
confianza. Cuando la confianza no alcanza, la respuesta lo dice (`caer_a_llm: true`) y el agente
decide con su propio LLM, que es lo que hace hoy.

## Arquitectura

```
modelo ─ MCP stdio «cauce-decisiones» (sin credenciales)
       ─ socket 0600 del alias: POST /decisiones (sin turno y fuera de la cola de emisión)
       ─ adaptador: certificado mTLS del alias (el mismo con el que habla con el gateway)
       ─ servicio «decisiones» en vpstn: https://100.64.0.11:8447 (proyecto compose propio)
       ─ https://api.typesafe.ai/v1/systemone con la clave leída de un fichero
```

- **Identidad.** Sale del certificado de cliente. El servicio verifica la cadena contra la CA de Cauce
  y busca el SHA-256 del certificado en el mismo `mtls_identities.json` del gateway, que relee en cada
  petición: borrar la fila de un alias en ese registro lo revoca también acá. Hace falta rol `agent` o
  `adapter` y permiso `route`. Un cuerpo que traiga `alias`, `tenant` o `from` se rechaza.
- **Habilitación explícita, cerrada por defecto.** El servicio **no** consulta la base: deshabilitar un
  tenant, un agente o una membresía desde la consola corta al alias en el bus, pero su certificado
  sigue vigente acá. Por eso, además del certificado, hacen falta dos listas: `CAUCE_DECISIONES_TENANTS`
  (tenants cuyos agentes gastan la clave de Jev de Steven y mandan su `state` a TypeSafe, uno por uno y
  sin comodín) y `CAUCE_DECISIONES_ALIASES` (alias, o `*` para todos los de esos tenants). Vacías o
  ausentes = nadie. Para revocar a un alias acá, sacalo de la lista y reiniciá sólo este servicio.
- **La clave de Jev** sólo existe en vpstn. Se monta en este contenedor y en ningún otro, se lee en
  cada llamada (rotarla in-place no pide reinicio; ver «Rotar la clave de Jev») y no aparece en logs,
  errores, auditoría ni respuestas. En
  producción sólo se acepta el origen `https://api.typesafe.ai`, para que ningún error de configuración
  mande la clave a un sitio que imite a Jev.
- **El MCP no tiene credenciales.** Habla con el socket del adaptador, y el adaptador sólo convierte tres
  operaciones fijas en tres rutas fijas: el modelo no elige ni rutas, ni cabeceras, ni identidad.

### Por qué un servicio aparte y no una ruta del gateway

El mapa de identidad recomendaba montar la ruta en el gateway. Se eligió un servicio aparte por cuatro
motivos:

1. **Desplegarlo no recrea el gateway**, así que el bus no se interrumpe.
2. **No hay que reconstruir la imagen del bus** desde una rama. La línea viva y las ramas ya
   divergieron: construir desde una rama puede borrar código que producción sí tiene.
3. **Su fallo queda aislado.** Jev tiene colas de hasta 28 s y a veces responde 520 o 529; esa latencia
   no puede ocupar al gateway.
4. **La clave se monta en un solo contenedor.**

A cambio abre un puerto nuevo (8447 en 100.64.0.11). Los adaptadores lo alcanzan directamente, sin
pasar por la regla temporal de agora: el mapa midió que llegan a 100.64.0.11 desde ws-zeus, claw,
ctrl-infra, agv2-steven-hades-oc y server2. El servicio reutiliza el certificado de servidor del
gateway, cuyos SAN incluyen 100.64.0.11 (verificado), y también su registro de identidades. No
aparecen secretos nuevos.

## Contrato HTTP (mTLS obligatorio)

| Ruta | Qué hace |
|---|---|
| `GET /health` | Versión, catálogo y si la credencial de Jev está presente (nunca su valor). |
| `GET /v1/plantillas` | Resumen de cada plantilla: `state` esperado, decisiones posibles, opciones restringibles, si está habilitada. |
| `GET /v1/plantillas/:id` | Definición completa de una plantilla. |
| `POST /v1/decidir` | Recibe `{plantilla, state, opciones?: {restringir}}` o `{state, questions, umbrales?}`. Exactamente una de las dos formas. |

Una **plantilla** responde con esta forma:

```json
{ "plantilla": "aprobacion_humana", "version_plantilla": "1.0.0", "origen": "jev",
  "decision": "exige_aprobacion", "valor": null, "motivo": "…", "caer_a_llm": false,
  "confianza": 0.94, "marcas": ["irreversible"], "indicadores": {},
  "senales": { "borra_datos": { "tipo": "noul", "p": 0.99, "respuesta": "si", "certeza": 0.98, "firme": true } },
  "modelo": "jev-1.13.0", "modelo_calibrado": "jev-1.13.0", "jev_request_id": "req_…", "ms": 412,
  "solicitudes_jev": 1, "usage": { "input_tokens": 902, "output_tokens": 40 }, "redacciones": 0 }
```

Cómo leer los campos:

- **`origen`** es `jev`, o `prefiltro` si una regla determinista decidió sin llamar a Jev (por ejemplo,
  un `rm -rf`).
- **`confianza`** es la certeza de las respuestas en las que se apoyó la regla que decidió: en un
  `todas` cuenta la más débil; en un `alguna`, la rama más firme que lo hizo verdadero; en un `max`, el
  elemento que dio el máximo. Si no disparó ninguna regla, es la de las respuestas que las
  descartaron. No mezcla las preguntas del fan-out que no pesaron en la decisión; la certeza de cada
  una sigue en `senales`. Un score decide sólo con su `confidence` (0,6; 0,7 para declarar cumplida
  una respuesta): si la distribución no es firme, la plantilla cae al LLM.
- **`modelo_distinto_al_calibrado: true`** aparece cuando `jev-latest` ya apunta a otra versión: los
  umbrales se calibraron con `jev-1.13.0`.
- **Una pregunta libre** responde `respuestas` con cada señal, más `caer_a_llm` e `inciertas`. Los
  umbrales por defecto son: confianza 0,6 y noul firme a partir de 0,8 para «sí» o por debajo de 0,2
  para «no».

**Errores.** Todo error trae `{error, mensaje}`. Todo rechazo de `POST /v1/decidir` trae además
`respaldo`, el resultado que el agente debe aplicar: también un 400 por un campo faltante, un 403 por
alias fuera del piloto o un 413. Las plantillas de seguridad fallan cerradas: `aprobacion_humana` exige
aprobación y `guardia_privacidad_jarvis` bloquea. Las demás devuelven `caer_a_llm: true`. Cuando el
servicio ni siquiera contesta (adaptador sin `DECISIONES_URL`, servicio inalcanzable, adaptador caído,
timeout), el respaldo lo pone el adaptador con la misma regla: `RESPALDO_SIN_SERVICIO` en
`packages/adapter-sdk/src/sdk/mcp-emission/decisiones.ts`, que un test compara con el `si_falla` del
catálogo. Sólo `plantilla_desconocida` y `listar_plantillas` no traen respaldo.

| Código | HTTP | Cuándo |
|---|---|---|
| `solicitud_invalida` | 400 | La solicitud no pasa la validación. Se rechaza antes de pagar la llamada a Jev. |
| `plantilla_desconocida` | 404 | El id de plantilla no existe. |
| `state_demasiado_grande` | 413 | El `state` pasa de 64 KiB. |
| `solicitud_demasiado_grande` | 413 | `state` y `questions` juntos pasan de 96 KiB (unos 32k tokens a los ~3 bytes por token medidos; Jev admite 64k). |
| `no_autenticado` | 401 | Certificado no aprovisionado o vencido. |
| `no_autorizado` | 403 | Sin rol o sin permiso `route`, o alias fuera del piloto. |
| `plantilla_deshabilitada` | 403 | La plantilla exige habilitación y no está habilitada. |
| `limite_excedido`, `cupo_diario_agotado`, `servicio_ocupado` | 429 | Traen `retry-after`. |
| `jev_sin_credencial` | 503 | El servicio no tiene la clave de Jev. |
| `jev_limite`, `jev_sobrecargado`, `jev_red` | 503 | Jev limitó la tasa, está sobrecargado o no se pudo conectar. |
| `jev_timeout` | 504 | Jev no respondió dentro del presupuesto. |
| `jev_credencial_rechazada`, `jev_solicitud_rechazada`, `jev_error`, `jev_respuesta_invalida` | 502 | Jev rechazó la clave o la solicitud, falló, o devolvió algo inesperado. |

**Llamadas a Jev.** Cada intento tiene 15 s y la decisión entera tiene 30 s. Si un intento tarda más
de 3 s se lanza una segunda solicitud idéntica, y gana la primera que responda: lo medido fue bimodal,
con la mitad por debajo de 650 ms y colas de 5 a 28 s. Se reintentan 408, 429, 5xx, 520 y 529, con
backoff exponencial y respetando `retry-after`. Los 401 y 422 no se reintentan, y cortan también la
copia del hedge que siga en vuelo: el error que se audita es el de la credencial o el cuerpo, no un
timeout.

## Catálogo (`catalogo/`)

- **`catalogo.json`** tiene la versión del catálogo, el modelo con el que se calibró y la medición del
  23-09.
- **`plantillas/<id>.json`** tiene una plantilla por fichero. **Agregar una plantilla es agregar un
  fichero** y reiniciar el servicio. El cargador valida todo al arrancar, y una plantilla rota impide
  el arranque en vez de fallar en una decisión.

Campos de una plantilla:

- `id`, `version` (semver), `nombre`, `cuando_usar`, `state` (documentación) y `state_requerido`
  (rutas con punto).
- `questions`: las preguntas tal como las recibe Jev (`noul`, `choice` o `score`).
- `expansiones`: preguntas generadas en cada solicitud. Hay dos tipos:
  - `{por_opcion: <choice>, excepto, id: "encaja::{opcion}", pregunta}` usa `{opcion}` y
    `{criterio.<campo>}`.
  - `{por_elemento: <ruta de lista en state>, minimo, maximo, id: "cumple_req::{i}", pregunta}` usa `{i}`.
- `restricciones`: `{<choice>: {fijas: ["ninguno"], minimo: 2}}`. El agente las restringe con
  `opciones.restringir`.
- `conjuntos`: `{<nombre>: {defecto: [...], por_alias: {zeus: [...]}}}`. Se resuelve con el alias del
  certificado.
- `indicadores`: `{<nombre>: {ponderado: {id: peso}} | {max: CONJ} | {min: CONJ}}`. En `ponderado`, cada
  score se normaliza por su nivel máximo.
- `prefiltros`: `[{campos, patron, flags, solo_alias?, excepto_alias?, entonces}]`. Son regex sobre el
  `state` sin enmascarar y deciden sin llamar a Jev.
- `reglas`: `[{si: CONDICIÓN, entonces: RESULTADO}]`. Se evalúan en orden y gana la primera verdadera.
  Si ninguna lo es, se usa `sino`.
- `si_falla`: el resultado cuando Jev no responde. No puede depender de respuestas.
- `marcas` (señales informativas), `notas`, `evidencia` y `requiere_habilitacion` (motivo).

Una **condición** es una de estas formas:

- `{todas: [...]}`, `{alguna: [...]}`, `{no: …}`.
- `{p: id, ">=": x}` (noul).
- `{confianza: id, ...}`.
- `{eleccion: id, es | no_es | en}`.
- `{prob: id, opcion, ...}`.
- `{prob_elegida: id, ...}`.
- `{puntaje: id, ...}` y `{normalizado: id, ...}`.
- `{max | min: CONJ, ...}`.
- `{indicador: nombre, ...}`.

Los comparadores son `>=`, `>`, `<=` y `<`, y se pueden combinar para expresar franjas. Un conjunto
(`CONJ`) es una lista de ids, `@nombre` o `prefijo::*`. Un id puede llevar `{eleccion:<choice>}`: por
ejemplo, `encaja::{eleccion:destino}`.

La lógica es trivalente: si falta una respuesta, la condición no dispara, tampoco negada.

Un **resultado** es `{decision, motivo, valor?, llm?}`. `decision` y `valor` admiten
`{eleccion:<choice>}`, y `llm: true` significa «caer al LLM».

`test/fixtures/jev-grabado.json` guarda las respuestas reales de Jev a 33 casos sintéticos, cada una
con el SHA-256 de las preguntas que la produjeron (`questions_sha256`). `test/catalogo.test.ts`
comprueba que cada caso lleva a la decisión esperada y que el catálogo le sigue mandando las mismas
preguntas. Al cambiar una regla o un umbral, ese test es la regresión de calibración. Al cambiar el
texto de una pregunta (instructions o criteria), las respuestas grabadas dejan de valer: el test falla
hasta que se re-graba el caso contra Jev y se actualiza el hash.

## Configuración

| Variable | Defecto |
|---|---|
| `CAUCE_DECISIONES_TLS_CERT_FILE`, `_TLS_KEY_FILE`, `_CLIENT_CA_FILE`, `_IDENTITY_FILE` | obligatorias |
| `CAUCE_DECISIONES_JEV_KEY_FILE` | `/etc/cauce-v3/secrets/typesafe-jev.key` |
| `CAUCE_DECISIONES_JEV_URL` | `https://api.typesafe.ai/v1/systemone` (en producción no se acepta otro origen) |
| `CAUCE_DECISIONES_JEV_MODEL` | `jev-latest` (`jev-1.13.0` congela la calibración) |
| `CAUCE_DECISIONES_TIMEOUT_MS` / `_INTENTO_TIMEOUT_MS` / `_RONDAS` / `_HEDGE_MS` | 30000 / 15000 / 3 / 3000 |
| `CAUCE_DECISIONES_ALIASES` | vacío = nadie; `*` = todos los alias de los tenants habilitados (piloto: `zeus`) |
| `CAUCE_DECISIONES_TENANTS` | vacío = nadie; sin comodín (compose: `Steven`) |
| `CAUCE_DECISIONES_HABILITAR_PLANTILLAS` | vacío (`guardia_privacidad_jarvis` queda apagada) |
| `CAUCE_DECISIONES_POR_MINUTO` / `_RAFAGA` / `_TOKENS_DIA` / `_TOKENS_DIA_TOTAL` | 60 / 20 / 2000000 por alias / 20000000 la flota |
| `CAUCE_DECISIONES_CONCURRENCIA` / `_CONCURRENCIA_ALIAS` | 16 en total / 4 por alias |
| `CAUCE_DECISIONES_AUDIT_FILE` / `_AUDIT_MAX_BYTES` | `/var/lib/cauce-decisiones/auditoria.jsonl` / 50 MiB (rota a `.1`) |
| `CAUCE_DECISIONES_PORT` / `_HEALTH_PORT` / `_REDACTAR` | 8447 / 8088 (sólo 127.0.0.1) / `1` |

- **Límites.** Viven en memoria: al reiniciar se pierde, como mucho, una ráfaga y el cupo de un día.
- **Cupo diario, un techo y no una estimación.** Antes de llamar, cada decisión reserva su peor caso:
  los bytes que envía más 256 (lo medido fue de 1,5 a 2,7 bytes por token más unos 240 fijos), por
  cada solicitud que puede llegar a mandar (rondas por 2 si hay hedge). Al terminar cobra
  `usage.input_tokens` por cada solicitud que Jev pudo haber facturado: la ganadora, la copia del hedge
  aunque se aborte y los intentos que expiraron. No cobra las que Jev rechazó con un código HTTP de
  error. Sin `usage`, o si la respuesta no sirve, cobra la estimación. No probé si TypeSafe factura una
  solicitud abortada: se cuenta como si sí. `_TOKENS_DIA` acota así a unos USD 0,08 por alias y día, y
  `_TOKENS_DIA_TOTAL` a unos USD 0,84 por día para toda la flota. Cada línea de auditoría lleva
  `tokens_cobrados`.
- **Concurrencia.** Un alias no ocupa más de `_CONCURRENCIA_ALIAS` plazas: si un agente se desboca, el
  resto de la flota sigue decidiendo con Jev en vez de recibir `servicio_ocupado`.
- **Auditoría.** Registra una línea por decisión con alias, tenant, plantilla y versión, ids y tipos
  de las preguntas, SHA-256 y longitud del `state`, latencia, solicitudes a Jev, tokens cobrados al
  cupo, modelo, request id, usage, certeza por pregunta, decisión y `caer_a_llm`. **Nunca** guarda el `state`, las instrucciones
  ni la clave.

## Despliegue (preparado, no aplicado)

1. **Servicio, en vpstn como root.** El script, el compose y la imagen salen del commit, no del árbol
   de trabajo: sirve cualquier clon que tenga el commit, esté en la rama que esté. En vpstn el worktree
   de ws-zeus no sirve (su `.git` apunta a una ruta que sólo existe dentro del contenedor) y
   `/opt/cauce-v3` no es un repositorio. El clon principal sí tiene el commit, aunque su rama no traiga
   `deploy/decisiones`:

   ```
   G=/datos/workspaces/zeus/cauce-v3
   git -C "$G" show <commit>:deploy/decisiones/desplegar.sh > /root/desplegar-decisiones.sh
   CAUCE_DECISIONES_GIT=$G bash /root/desplegar-decisiones.sh plan <commit>      # no cambia nada
   CAUCE_DECISIONES_GIT=$G bash /root/desplegar-decisiones.sh aplicar <commit>
   ```

   `aplicar` hace cinco cosas:
   1. Deja la clave en `stev:stev 0400`, sin copiarla ni leerla, y anota el estado previo en
      `/etc/cauce-v3/decisiones.revert`.
   2. Construye `cauce-decisiones:<commit>` desde `git archive`.
   3. Guarda el `compose.yaml` de ese commit en `/etc/cauce-v3/decisiones.d/<commit>/`: `down`,
      `estado` y `anterior` usan siempre el compose que levantó el contenedor.
   4. La primera vez genera `/etc/cauce-v3/decisiones.env` con las rutas de `prod.env`; las siguientes
      sólo cambia la imagen y anota la que reemplaza (`IMAGEN_ANTES`).
   5. Levanta el proyecto compose `cauce-decisiones` y corre el humo: health, TLS y una decisión real
      con el certificado de zeus.

   El proyecto es independiente del bus: `deploy/deploy.sh` no lo toca, y este despliegue no toca el
   gateway.
2. **Adaptadores, de a uno.** Hacen falta dos cosas, en este orden:
   - **Una release del adaptador que incluya este commit**, porque trae la ruta `/decisiones` del
     socket y el bin `cauce-decisiones-mcp.js`. **Que no retroceda a nadie:** esta rama sale de
     `zeus/arnes-grok` y no tiene dos arreglos que hoy corren en caliente. Construida sólo desde acá,
     la release le quita a zeus (el piloto) el arreglo de `pasted_content` (su release actual termina en
     `-pasted-quiet`; ese arreglo existe sólo en el dist desplegado, no en ningún commit), y con Claude
     Code 2.1.280 zeus deja de cosechar: toda entrega queda en `started` hasta el reaper de 6 h. A
     jarvis le quita `d74334c0` (rama `zeus/jarvis-cuelgue`: el puente OpenClaw sale tras responder y
     el parser conserva la respuesta), y sus turnos quedan vivos para siempre. Primero hay que llevar
     los dos al fuente de la release (cherry-pick de `d74334c0`; portar el matcher de `pasted_content`
     a `packages/adapter-sdk/src/shared-session/transcript.ts` con su test) y comprobarlo:

     ```
     git merge-base --is-ancestor d74334c0 <commit-release> && echo jarvis-ok
     git grep -q -i pasted_content <commit-release> -- packages/adapter-sdk/src && echo zeus-ok
     ```

     Sin los dos `ok` no se construye. hades (`d6189328`) y argos/atlas (`a6fd5495`, el parche quiet)
     no pierden nada: ya están en esta rama.
   - **El supervisor que admite `DECISIONES_URL`, antes que el `.env`.** Se despliega copiándolo desde
     el staging de stev, sin reconstruir la imagen. El supervisor que corre hoy rechaza toda clave que
     no esté en su lista (`container alias config key is not allowlisted`) y sale con 2, y las unidades
     tienen `RestartPreventExitStatus=2`: systemd no lo reintenta y el alias queda caído en silencio en
     su próximo reinicio.

   Recién entonces, en `/home/stev/.config/cauce-v3/container-aliases/<alias>.env`, se ponen
   `BUNDLE_RELEASE`, `BUNDLE_SHA256` y `DECISIONES_URL=https://100.64.0.11:8447`. Antes de reiniciar
   `cauce-v3-container-<alias>.service`, mirá si hay una entrega en vuelo. En kant, que corre nativo en
   server2, la variable es `CAUCE_DECISIONES_URL` en el entorno de su unidad.
3. **MCP en cada arnés, sólo en los alias ya habilitados** en `CAUCE_DECISIONES_ALIASES` (a los demás
   el servicio les responde 403 con el respaldo). Se registra dentro del contenedor, como el usuario
   del arnés y sin turno en vuelo. Primero se simula y después se agrega `--aplicar`:

   ```
   B=/opt/cauce-v3-adapter/<alias>/releases/<release>/packages/adapter-sdk/dist/src/bin/cauce-decisiones-mcp.js
   python3 ops/scripts/decisiones-registrar-mcp.py --arnes claude   --config /home/dev/.claude/.claude.json --bin "$B"      # zeus, kant (su .claude.json)
   python3 ops/scripts/decisiones-registrar-mcp.py --arnes openclaw --config /home/dev/.openclaw/openclaw.json --bin "$B"  # argos
   python3 ops/scripts/decisiones-registrar-mcp.py --arnes openclaw --config /home/claw/.openclaw/openclaw.json --bin "$B" \
     --socket /home/claw/.openclaw/cauce-v3/jarvis/mcp-emission.sock --command /usr/bin/node                              # jarvis
   python3 ops/scripts/decisiones-registrar-mcp.py --arnes grok     --config /home/claw/.grok/config.toml --bin "$B"      # hades
   python3 ops/scripts/decisiones-registrar-mcp.py --arnes codex    --config "$CODEX_HOME/config.toml" --bin "$B" \
     --socket <runtimeStateDirectory del alias en ops/flota.json>/mcp-emission.sock                                     # socrates, tales
   ```

   - **El socket.** Es `<runtimeStateDirectory>/mcp-emission.sock`, con el directorio de
     `ops/flota.json`. Si el arnés ya tiene `cauce` registrado, el script lo toma de esa entrada. jarvis
     no la tiene, así que sin `--socket` el script aborta. Antes de registrar, comprobá con `ls -la`
     que el socket exista: si el adaptador no lo abre, cada decisión responde `adaptador_no_responde`
     con su respaldo.
   - **Lo que imprime.** Sólo la entrada y cuántas líneas cambian, nunca líneas del fichero: jarvis
     tiene una API key en claro en otro servidor MCP.
   - **Al escribir.** Deja un respaldo 0600 al lado del fichero.
   - **Cuándo entra en vigor.** El arnés toma el MCP en su próxima sesión.
   - **Por qué un servidor aparte.** Es independiente de `cauce`: registrarlo no enciende la emisión
     por MCP en alias que hoy no la tienen.
4. **Piloto.** Primero sólo zeus (`CAUCE_DECISIONES_ALIASES=zeus` y `CAUCE_DECISIONES_TENANTS=Steven` en
   `decisiones.env`). Después se agregan alias de a uno y se reinicia sólo este servicio. Un tenant
   cliente entra sólo si Steven lo decide: su `state` sale a un tercero y lo paga la clave de Steven.
5. **Efecto.** Una decisión desde el arnés y su línea en la auditoría, que se lee con
   `docker exec cauce-decisiones-decisiones-1 tail -n 5 /var/lib/cauce-decisiones/auditoria.jsonl`.

## Rotar la clave de Jev

El secreto de compose es un bind mount de un fichero y fija su inodo. Rotá **in-place**, como root:
`cat nueva.key > /etc/cauce-v3/secrets/typesafe-jev.key` conserva inodo, dueño y modo, y el servicio
la lee en la próxima decisión, sin reinicio. Si el fichero se **reemplazó** (`mv`, `install`, un
editor que guarda en uno nuevo), el contenedor sigue leyendo la clave vieja y el fichero nuevo (root
600) es ilegible para uid 1000: `desplegar.sh recrear` le devuelve `stev:stev 0400` y recrea el
contenedor con la misma imagen. En los dos casos, comprobá con `desplegar.sh estado`: el healthcheck
de Docker sigue verde sin credencial, a propósito, porque así se apaga Jev. Lo que delata una clave
ilegible es `credencial_jev: false` en `estado` y el evento `decisiones_sin_credencial_jev` en
`docker logs cauce-decisiones-decisiones-1`.

## Reversa

- **Un alias.** Quitar el MCP con `decisiones-registrar-mcp.py --arnes … --config … --quitar --aplicar`,
  o restaurar el respaldo. Después, borrar **la línea entera** `DECISIONES_URL` del `<alias>.env`: no
  dejarla vacía, porque `DECISIONES_URL=` también hace salir al supervisor con 2. Recién después volver
  al supervisor o al `BUNDLE_*` anteriores si hace falta, y reiniciar su unidad. Sin `DECISIONES_URL`,
  el adaptador responde `decisiones_no_configurado` con el respaldo (cerrado en las plantillas de
  seguridad).
- **Volver la release de ops** (los `~/.local/share/cauce-v3/ops-before-*`): antes,
  `grep -l '^DECISIONES_URL' /home/stev/.config/cauce-v3/container-aliases/*.env` tiene que dar vacío.
  El supervisor anterior no conoce la clave, y cada alias que la tenga no arranca en su próximo
  reinicio, sin que systemd lo reintente.
- **El servicio, a la versión anterior.** `desplegar.sh anterior` vuelve a la imagen que reemplazó el
  último `aplicar`, con el compose con el que se había desplegado, sin reconstruir ni llamar a git.
  Repetido, alterna entre las dos. Si esa imagen ya no está, `aplicar <commit-anterior>`.
- **El servicio, fuera.** `desplegar.sh revertir` hace `compose down`, conserva el volumen de auditoría
  y devuelve la clave a su dueño y modo anteriores.
- **Apagar Jev sin tocar nada más.** Vaciar `CAUCE_TYPESAFE_JEV_KEY_PATH` en `decisiones.env` (pasa a
  `/dev/null`) y recrear: `docker compose -p cauce-decisiones --env-file /etc/cauce-v3/decisiones.env
  -f /etc/cauce-v3/decisiones.d/<commit>/compose.yaml up -d --force-recreate` (no `recrear`, cuyo humo
  exige la credencial). Todas las decisiones responden `jev_sin_credencial` con su respaldo.

## Decisiones pendientes de Steven

- **Datos a un tercero.** Todo `state` sale hacia TypeSafe, y en la forma libre también las
  `questions` que escribe el agente. TypeSafe no entrena con esos datos, pero sin plan enterprise no
  hay retención cero. El servicio enmascara tokens, claves, JWT y URIs con credenciales en los valores
  de ambos antes de enviar (conservando el orden de campos y opciones) y rechaza con 400 un secreto
  escrito en un nombre de campo, un id de pregunta o una opción, que no se pueden enmascarar sin
  cambiar la pregunta. No quita datos personales.
- **`guardia_privacidad_jarvis`** envía justamente los textos personales que quiere proteger. Queda
  apagada hasta que Steven la habilite en `CAUCE_DECISIONES_HABILITAR_PLANTILLAS`.
- **Gasto.** Jev cobra por token de entrada; los topes diarios por alias y de la flota lo acotan de verdad (ver Configuración).
