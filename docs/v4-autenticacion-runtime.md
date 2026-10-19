# Autenticación de proveedores en hosts V4

## Flujo desde la consola

`AgentProviderAuthBroker` liga el consentimiento humano, la empresa seleccionada, la cuenta, el perfil, el host y la operación durable. El gateway valida esos datos y el fence antes de enviar comandos al host enrolado mediante `POST /v3/fleet/hosts/:host_id/agent-auth`. El estado de autenticación solo se acepta si la identidad del proveedor coincide y pasa una llamada funcional de verificación.

El host ejecuta únicamente los comandos fijados por una política privada indicada en `CAUCE_FLEET_ENROLLED_AUTH_POLICY_FILE`. La política debe corresponder a la identidad del ordenador y fija perfiles, plantillas y ejecutables permitidos; el host vuelve a comprobar los fences durante el login, la verificación y la limpieza. Una sesión pendiente o un proceso detenido no acreditan autenticación.

## Causas visibles del login

El login ya no cae en un genérico «no se pudo verificar». La sesión de proveedor (`ProviderAuthSnapshot`) lleva un código cerrado `error` y, cuando la causa es la forma del contenedor, un motivo `reason`:

| Código (`error`) | Qué significa |
|---|---|
| `AUTHORITY_REVOKED` | La autoridad que respaldaba la operación fue revocada. |
| `SESSION_CONFLICT` | Otra sesión o una versión más nueva ocupa el mismo perfil u operación. |
| `INVALID_REQUEST` | La petición no cumple el contrato cerrado. |
| `HOST_UNAVAILABLE` | El ordenador no respondió o el helper del host falló sin acreditar deriva de imagen. |
| `RUNTIME_DRIFT` | El contenedor quedó con una imagen anterior a la aprobada. No se reanuda: hay que recrearlo. |
| `STOP_UNCONFIRMED` | No se confirmó la parada del login anterior; el perfil sigue reservado. |
| `IDENTITY_MISMATCH` | La cuenta conectada no es la identidad autorizada. |
| `FUNCTIONAL_CHECK_FAILED` | La cuenta aún no pasó una llamada funcional. |
| `LOGIN_FAILED` | El CLI del proveedor rechazó el inicio de sesión. |
| `SESSION_EXPIRED` | La ventana de login caducó. |

Motivos de deriva (`reason`, solo con `RUNTIME_DRIFT` o `STOP_UNCONFIRMED`):

| Motivo (`reason`) | Diferencia detectada en el contenedor |
|---|---|
| `CONTAINER_IMAGE_OR_OWNERSHIP_DRIFT` | La imagen o las etiquetas de propiedad no coinciden con la forma aprobada. Es el único motivo que el helper eleva directamente a `RUNTIME_DRIFT`; los demás motivos de forma viajan como `HOST_UNAVAILABLE` o `STOP_UNCONFIRMED` con su `reason`, para que la consola explique la diferencia sin marcar todavía la operación como deriva de imagen. |
| `CONTAINER_RESOURCE_LIMITS_DRIFT` | Los límites de recursos (memoria, CPU, procesos) no coinciden con la forma aprobada, incluidas las ampliaciones `resources` declaradas. |
| `CONTAINER_ISOLATION_DRIFT` | El aislamiento difiere: capacidades, redes, dispositivos o GPU, entorno del sidecar, ampliaciones declaradas, montajes, usuario de ejecución o huella del ejecutable. |

En la operación de flota, la deriva se guarda como `error.code = RUNTIME_DRIFT` con `step = authenticate` y `retryable = false`. La consola la muestra con la etiqueta **Requiere preparación** y el texto «El contenedor del agente quedó con una imagen anterior. Cancela esta operación y pulsa Preparar para recrearlo; luego inicia sesión». Una operación con deriva no es reanudable (`resumable` es falso); sí es cancelable. El flujo guiado **Recrear contenedor e iniciar sesión** hace ese camino en un solo recorrido (ver [Guía](v4-guia.md)).

El helper del host traduce su salida estándar de error a estos motivos con una tabla cerrada: solo las frases exactas `fleet effect failed: …` conocidas producen un `reason`; cualquier otra salida queda como fallo del helper, sin filtrar texto libre a la consola ni a los eventos.

## Reconciliación de agentes pendientes

El proceso del host (`AgentProviderAuthHost`) inspecciona en segundo plano, como mucho cada 30 segundos, las operaciones `awaiting_auth` de tipo `create`, `update`, `start` o `restore` que aún no tienen deriva marcada. Por cada una vuelve a consultar el binding del contenedor; si detecta deriva de imagen, envía un recibo cercado (`operation_id`, `operation_epoch`, `prepared_revision` y huella del ámbito) al gateway. El gateway solo marca `RUNTIME_DRIFT` si el recibo coincide con la operación vigente que él mismo inspecciona en ese momento, y deja un evento `step_completed` del paso `authenticate` con el recibo en su metadato. Una deriva que aparece mientras el operador mira la ficha se refleja así sin esperar a un nuevo intento de login.

## Limpieza del login fuera de la transacción

Reservar y liberar un perfil ya no ejecuta la parada remota dentro de la transacción de base de datos. La reserva pasa por tres estados guardados en los eventos de la operación: `reserved`, `releasing` y `released`. Al liberar, una primera transacción corta reclama el estado `releasing` con un identificador de liberación y una ventana de 360 segundos (por encima del tiempo límite de 330 segundos del comando remoto del broker); la llamada que detiene el login en el host se hace **fuera** de cualquier transacción; una segunda transacción confirma `released` si la parada se acreditó, o vuelve a `reserved` si no. Mientras una liberación está dentro de su ventana, una reserva nueva sobre la misma cohorte (ordenador, usuario de ejecución y perfil) se rechaza con `SESSION_CONFLICT` en lugar de competir por el contenedor. Si la parada no se confirma, el error es `STOP_UNCONFIRMED` y el perfil sigue reservado hasta que la recuperación confirme la parada. El mismo camino libera las reservas caducadas de operaciones anteriores antes de abrir un login nuevo.

## Recreación del contenedor por imagen o release

Cuando la imagen aprobada o el release del executor cambian, la siguiente operación del agente recrea su contenedor en lugar de reutilizar el anterior:

- Antes de tocar nada se comprueba que no haya una sesión de login abierta ni sin verificar sobre ese contenedor, que el perfil del proveedor viva dentro de los volúmenes persistentes del runtime (raíz de estado o de perfiles) y que los volúmenes propios sean los esperados. Si el perfil viviera solo en la capa escribible, la recreación se rechaza para no perder la sesión.
- Se guarda un recibo de refresco (`prepared`) con la identidad anterior y la imagen nueva. El contenedor anterior se detiene y se renombra como copia de respaldo, se crea el reemplazo con los mismos montajes —volumen de estado, volumen de perfiles y ampliaciones declaradas incluidas— y se arranca si antes corría. La validación del reemplazo es exacta: imagen, etiquetas, límites, aislamiento, montajes y ampliaciones deben coincidir con la forma aprobada.
- Si algo falla, se restaura el contenedor original y se conserva el recibo para recuperación; si el proceso se interrumpe, la siguiente operación recupera desde el recibo: con estado `prepared` restaura el original y con estado `succeeded` valida el reemplazo y retira la copia de respaldo. Los volúmenes nunca se borran en este camino.
- Al detener o limpiar una sesión, el helper acepta que el montaje del executor apunte al release anterior siempre que ambos releases sean directorios hermanos con nombre de revisión (40 o 64 caracteres hexadecimales), el montaje de ciclo de vida sea de solo lectura y todo el árbol del release anterior sea propiedad de root o del usuario del executor y no escribible por grupo ni otros. Un release que no cumple eso no se acepta como anterior válido.

Cambiar las ampliaciones de un agente usa esta misma recreación (ver [Ampliaciones](v4-ampliaciones.md)).

## Temporales privados de OpenClaw

Un agente OpenClaw no usa el temporal compartido del contenedor. Su entorno fija `TMPDIR` dentro de su propio perfil, en el subdirectorio `tmp`, y la caché de compilación de Node en `tmp/node-compile-cache`. Esos directorios se crean como directorios propios del perfil antes de preparar el agente, antes de medir sus capacidades y antes de lanzar el proceso de login, así que ni el runtime ni el login escriben temporales fuera del perfil.

## Python aislado en el contenedor

Todo el Python que el executor ejecuta dentro del contenedor del agente con `docker exec` va aislado: intérprete con `-I -B`, directorio de trabajo `/` y ruta de módulos limitada a los directorios del executor y del ciclo de vida (`/cauce/executor` y `/cauce/lifecycle`). El arranque es un cargador mínimo que solo incorpora esa ruta y ejecuta el script fijado; no se importa ningún módulo del directorio de trabajo, de `PYTHONPATH` ni del perfil del usuario. El helper de login que corre dentro del contenedor solo importa la biblioteca estándar y los módulos fijados del propio executor; cualquier otro import queda fuera del conjunto permitido y la comprobación de aislamiento lo rechaza. En el host, el executor y sus supervisores se lanzan además sin escribir bytecodes.

## Verificación de identidad

- **Grok:** usa un perfil dedicado mediante `GROK_HOME` y el comando `login --device-auth`. El verificador consulta `https://auth.x.ai/oauth2/userinfo` con el token activo y exige que la identidad remota coincida; luego requiere la respuesta al nonce de prueba.
- **Muse:** usa `login`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME` y `MUSE_NO_AUTO_UPDATE=1`. El verificador comprueba el `id_token` RS256 contra las claves JWKS de Meta, valida emisor, audiencia y vigencia, y exige la respuesta al nonce de prueba.

Los ejecutables y módulos auxiliares se fijan por hash. El soporte del verificador no acredita por sí solo una cuenta real autenticada. Las pruebas locales y sus límites están en la [matriz de verificación](v4-matriz-local.md).

## Autoridad firmada del ordenador

`POST /v3/fleet/hosts/:host_id/authority` reenvía la solicitud firmada al enclave central por un socket Unix. El enclave valida identidad, empresa, nonce, operación, claim y epoch antes de usar el emisor; la clave privada permanece en el enclave.

El gateway configura `CAUCE_FLEET_AUTHORITY_SOCKET`, `CAUCE_FLEET_AUTHORITY_OWNER_UID` y `CAUCE_FLEET_AUTHORITY_PEER_UID`. Si los UID difieren, también requiere `CAUCE_FLEET_AUTHORITY_GROUP_GID`. El enclave usa los archivos privados `CAUCE_FLEET_AUTHORITY_COMMAND_FILE` y `CAUCE_FLEET_AUTHORITY_DATABASE_URL_FILE`. Una configuración parcial impide el arranque.

La acción `ready` comprueba el emisor fijado, su política y el par de claves sin emitir credenciales. Las capacidades de creación dependen de esa disponibilidad; las de lectura de cuotas son independientes.

## Diagnóstico de login de agente para operadores

### Dónde mirar, en este orden

1. **La operación en la consola.** En la ficha del agente, pestaña **Operación**, la operación en `awaiting_auth` muestra su estado, el paso `authenticate` y, si hay deriva, la etiqueta **Requiere preparación**. El panel de conexión del proveedor muestra el código y el motivo ya traducidos. Es la primera fuente: dice qué hacer sin abrir ningún diario.
2. **Los eventos de la operación.** Cada reserva y liberación deja eventos `step_started` y `step_completed` del paso `authenticate` con el estado de la reserva (`reserved`, `releasing`, `released`) en su metadato, y la deriva confirmada deja un evento `step_completed` con el recibo de reconciliación. La operación guarda además `error.code`, `error.step` y `error.retryable`. Se leen desde el historial de operaciones de la propia ficha; no hace falta acceder a la base de datos para el diagnóstico habitual.
3. **El diario del executor en el ordenador del agente.** El proceso del host escribe en su error estándar una línea por comando fallido con el motivo cerrado, del tipo `Agent provider authentication command=<tipo> failed: <motivo>`, y `provider auth helper failed: <motivo>` cuando falla el helper dentro del contenedor. La reconciliación que no se puede verificar deja `Agent runtime reconciliation could not be verified`. En el ordenador se consulta con el diario de usuario del servicio del executor (`journalctl --user` sobre la unidad del executor de esa empresa y ordenador, filtrando por `provider authentication`). El diario nunca debe contener códigos del proveedor, tokens ni contenido del terminal: si aparece algo así, trátalo como incidente y no lo copies a un informe.

### Qué significa cada código y qué hacer

| Lo que ves | Significa | Qué hacer |
|---|---|---|
| **Requiere preparación** (`RUNTIME_DRIFT`) | El contenedor corre una imagen anterior a la aprobada tras un despliegue o un cambio de release. La operación no se puede reanudar. | Cancela la operación desfasada y pulsa **Recrear contenedor e iniciar sesión** (o **Preparar** y luego inicia sesión). La recreación conserva volúmenes, sesión del proveedor y ampliaciones. No intentes reanudar la operación anterior. |
| `CONTAINER_IMAGE_OR_OWNERSHIP_DRIFT` | La imagen o las etiquetas del contenedor no son las aprobadas. | Es la causa habitual de la deriva: recrea como en la fila anterior. Si se repite tras recrear, el ordenador no cargó la imagen aprobada: repite la preparación del ordenador y comprueba su diario. |
| `CONTAINER_RESOURCE_LIMITS_DRIFT` | Los límites observados no son los aprobados, incluidas las ampliaciones `resources`. | Revisa las ampliaciones del agente: un límite cambiado a mano en Docker no se adopta. Quita o declara la ampliación y recrea desde la consola. |
| `CONTAINER_ISOLATION_DRIFT` | Capacidades, redes, montajes, usuario o ejecutable difieren de la forma aprobada. | No corrijas el contenedor a mano. Cancela y recrea desde la consola; si persiste, revisa en el diario del executor qué validación falló y la política del ordenador. |
| `STOP_UNCONFIRMED`, «No se confirmó la parada» | El login anterior no acreditó su parada y el perfil sigue reservado. | Espera a que la ventana de liberación termine y vuelve a intentarlo. Si se repite, revisa el diario del executor en ese ordenador y confirma la parada desde la recuperación de la propia operación antes de abrir otro login. No borres el volumen de perfiles. |
| `HOST_UNAVAILABLE` | El ordenador no responde o su helper falló. Con `reason` de aislamiento, la forma del contenedor difiere pero aún no es deriva de imagen confirmada. | Comprueba que el ordenador está conectado y su executor listo. Revisa su diario. Si trae un motivo de aislamiento, recrea el contenedor desde la consola. |
| `SESSION_CONFLICT` | Hay otra sesión viva o una liberación en curso sobre el mismo perfil. | Espera a que termine la otra sesión o su liberación y reintenta. No abras dos logins del mismo agente a la vez. |
| `IDENTITY_MISMATCH` | Entraste con otra cuenta del proveedor. | Cancela la conexión, inicia sesión de nuevo y entra con la cuenta principal del agente. |
| `FUNCTIONAL_CHECK_FAILED` | La identidad coincide pero el CLI aún no responde a una llamada real. | Espera unos segundos y pulsa **Verificar conexión** otra vez. Si persiste, la cuenta puede tener la sesión incompleta: cancela y repite el login completo. |
| `SESSION_EXPIRED` | Pasó la ventana del login. | Vuelve a pulsar **Iniciar sesión** y completa el recorrido sin dejarlo a medias. |
| `AUTHORITY_REVOKED` | La autoridad de la operación ya no es válida. | Cancela la operación y vuelve a lanzarla desde la configuración actual. |
| `LOGIN_FAILED` | El proveedor rechazó el inicio de sesión. | Repite el login siguiendo lo que pida el propio CLI en el terminal. Si el proveedor pide un paso en su página, complétalo allí antes de verificar. |

### Qué no hacer

- No detengas ni borres el contenedor a mano para «arreglar» una deriva: el executor lo detecta como una diferencia más y la operación sigue sin poder acreditar su forma.
- No borres el volumen de perfiles para desbloquear un `STOP_UNCONFIRMED`: ahí vive la sesión del proveedor y borrarlo obliga a autenticar de nuevo sin resolver la reserva.
- No reanudes una operación marcada **Requiere preparación**: está marcada como no reintentable a propósito, porque su contenedor ya no es el que la operación preparó.
