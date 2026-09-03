# Plano de traspaso sellado de secretos — notas de diseño

Este documento recoge el razonamiento que `scripts/calidad.mjs` obligó a sacar de los comentarios
de `audit.ts`, `routes.ts` y `store.ts` para no superar el tope de líneas de comentario de un
fichero nuevo. El código no cambió: cada bloque de aquí es la prosa que estaba ahí, movida, no
reescrita en su sustancia. La decisión de diseño en sí — el sobre cifrado, el AAD que ata el sellado
al traspaso concreto, el `x25519` fijo sin negociación — está en
`docs/adr/007-traspaso-sellado-de-secretos.md`; esto es el detalle de implementación por debajo de
esa decisión.

## `audit.ts`

### Nunca en claro

El trail de auditoría escribe directo contra el pool, por la misma razón que documenta
`services/gateway/src/terminal/audit.ts`. Su unión de acciones (`SecretAuditAction`) es propia:
ampliarla para que coincida con `TerminalAuditAction` dejaría que una consulta pensada para el
terminal alcanzara una fila de credencial. Nunca se registra un secreto ni los bytes sellados: del
ciphertext sólo es durable su sha256 truncado a 16 hex — suficiente para atar una fila `secret.read`
a su `secret.granted`, inútil para cualquier otra cosa.

### Escalera de denegaciones, sólo para las filas DENY

El límite de tasa cubre las filas de denegación y nada más. Una denegación la escribe la misma
petición que el atacante controla, así que un `secret.denied` sin freno convierte un flood que el
techo ya rechazó en una SEGUNDA escritura sin límite, sobre la tabla que lee la consola: medido,
4071 filas en 40 s. `audit_events` no tiene barrido de retención para estas filas, así que lo que no
se acota aquí queda para siempre.

La ventana la abre el EMISOR — tenant, alias y canal del principal autenticado — y nada que la
petición pueda elegir. Abrirla por el destinatario en cambio dejaba que un flooder rotara el NOMBRE
del destinatario y abriera una ventana nueva por petición: medido, 24046 filas en 20 s contra las 16
que la misma inundación escribe a nombre fijo. Un límite que el llamador puede esquivar no es un
límite.

Se usa una escalera que dobla en vez de una fila por ventana: una sola fila por ventana esconde el
tamaño del flood hasta que la ventana rota, y el número que necesita quien audita es el que se ve
MIENTRAS pasa. Se escribe la 1ª, 2ª, 4ª, 8ª… denegación de la ventana, cada una con su cuenta
corriente, así que cuatro mil denegaciones se vuelven trece filas que ya dicen cuán grande se está
poniendo.

Las denegaciones de un mismo emisor comparten esa cuenta sea cual sea el motivo por el que se
rechazaron, así que la primera denegación de cada motivo distinto también se escribe, hasta un tope:
un flood contra el techo no puede enterrar debajo la única denegación de ruteo. Un emisor cuesta
entonces como mucho una escalera más un puñado de filas "primera-de-su-tipo" por ventana, y el mapa
guarda 512 emisores — la ventana más vieja se va cuando se llena, y un emisor desalojado simplemente
abre una ventana nueva. La escalera degrada en MÁS filas, nunca en menos hechos: perder una
denegación no es un cambio que este plano haga para ahorrarse una fila.

### `handoffDigest`

Toda fila sobre un traspaso lo lleva, denegaciones incluidas. Sin esto un `secret.denied` en la ruta
de reclamo no nombra ningún traspaso y quien audita no puede saber cuál fue rechazado; el digest
correlaciona las filas sin escribir un id que también sirva para direccionar la ruta de reclamo.

## `routes.ts`

### Los cuatro invariantes del plano

El plano de traspaso de credenciales selladas vive FUERA de `/v3/console/`, como las rutas del relay
de terminal: quien llama es un agente con su propio certificado de cliente, no un navegador. Cuatro
invariantes sostienen cada ruta:

- la identidad es el principal autenticado; un cuerpo que nombra el SUJETO de la llamada se rechaza
  en vez de ignorarse, para que un mal uso falle ruidoso en vez de reinterpretarse en silencio;
- ningún campo de petición o respuesta puede llevar un valor en claro: el secreto existe sellado o
  no existe;
- un desconocido recibe 404, nunca 403: un error de autorización confirmaría que el traspaso existe;
- nada destructivo responde a un GET, y toda mutación confirma junto con su propia fila de auditoría
  o con ninguna de las dos. Un traspaso consumido que nadie puede probar que fue consumido es el
  agujero que este plano evita.

### Errores opacos: lista de admitidos, no de rechazados

Cualquier otro plano puede responder 400 con el texto que sea que se lanzó; aquí un desconocido no
debe aprender ningún hecho, así que sólo llegan al cliente los errores que este plano lanza a
propósito — más los de autenticación y autorización, cuyo texto habla del llamador y nunca del
despliegue. Un fallo del driver, un pool muerto o un `TypeError` colapsan todos en un único 500
opaco: un error de conexión lleva el host y el puerto de la base, y un fallo interno no es un error
del cliente al que haya que decirle que deje de reintentar.

### Claves de cuerpo rechazadas

`REFUSED_REQUEST_KEYS` es una lista de rechazo, no de permitidos: cada clave o bien restablece la
identidad (`tenant_id`, `alias`, `from_tenant`, `from_alias`) o podría colar un valor en claro
(`value`, `plaintext`, `secret`, `credential`, `token`, `password`).

### Piso de TTL

El techo de 24 horas es también un CHECK de la base; rechazar aquí nombra el campo en vez de la
fila. El PISO en cambio es política de admisión propia de este plano y vive aquí por eso: un
traspaso que expira antes de que el destinatario pueda plausiblemente hacer polling y reclamarlo
nunca fue un traspaso, fue una forma de escribir una fila de 64 KiB que ningún conteo de filas vivas
volvería a ver.

### Cursor de paginación

El cursor es la clave de orden de la última fila servida, nada más: no nombra ningún traspaso que el
llamador no tuviera ya, y no lleva estado que el gateway tenga que guardar.

### 409 sin eco del driver

Un id que choca no puede responder con las palabras propias del driver: `duplicate key value
violates unique constraint "secret_handoffs_pkey"` es un oráculo de existencia más una divulgación
gratuita del esquema.

### Denegación de la petición que la causó

`auditDenial` la escribe la propia petición que provocó el rechazo, así que el flood que el techo
rechaza no debe volverse un flood de filas de auditoría. La ventana pertenece al EMISOR autenticado
y a nada que la petición nombre — un cuerpo que rota el destinatario debe costar el mismo puñado de
filas que uno que lo repite. `denials_in_window` dice cuántas denegaciones representa la fila; la
escalera que decide cuáles se escriben vive en `audit.ts`.

### `key_published` sólo cuando cambia lo que el alias anuncia

Un agente publica su PROPIA mitad pública. El sujeto es el principal autenticado y el cuerpo no
puede nombrar a nadie: publicar una clave para otro alias dejaría que el publicador se convirtiera
en el destinatario de todo traspaso futuro dirigido a ese alias.

`read` es el permiso porque ésta es la mitad RECEPTORA del plano, la misma autoridad que lista y
reclama traspasos: un alias que no puede recibir uno no tiene por qué anunciar la clave a la que
otros sellarían. `route` es la mitad emisora y no pertenece aquí — dejaría que un agente que sólo
puede enviar se hiciera direccionable.

Sólo se audita una publicación que CAMBIA lo que el alias anuncia: un `key_id` nuevo, o bytes
nuevos. Mover el `not_after` de la clave ya publicada es un toque, no un evento, y auditarlo escribió
17363 filas permanentes en 10 s a partir de una sola fila, medido. La fila lleva el `key_id` y una
huella, nunca los bytes. Crear identidades está acotado por alias por la misma razón: el `key_id` lo
elige quien llama y cada uno nuevo es una fila durable aquí más una fila durable de auditoría.

### La clave pública del destinatario

Sin esta ruta el plano no se podría usar en absoluto: `agent_sealing_keys.public_key` sería de sólo
escritura y ningún emisor podría direccionar jamás a un destinatario. Está protegida por la misma
autoridad de ruteo que el traspaso — un alias sólo conoce la clave de alguien a quien ya se le
permite entregarle un secreto.

### El emisor sella en su propio proceso; el gateway no puede abrir nada

El `id` lo elige el EMISOR porque el AAD del sellado lo ata: el blob queda criptográficamente unido
al traspaso al que pertenece, así que el id tiene que existir antes de que exista el sellado. Es un
asa opaca, no una afirmación de identidad — la mitad de identidad sigue viniendo del principal, y un
id repetido lo rechaza la clave primaria en vez de sobrescribir nada.

La fila, el barrido de retención y la auditoría `secret.granted` confirman juntos: un traspaso que
existe sin su fila de auditoría sería una credencial reclamable que nadie sabe que fue concedida.

El sobre se decide PRIMERO, en este proceso y contra ninguna tabla: un cuerpo que este plano
rechazaría de todos modos no debe comprar una consulta de ruteo, ni la fila de auditoría que escribe
un rechazo. Si el destinatario existe sólo se pregunta de una petición que merece la pregunta.

El barrido corre ANTES de que el techo cuente: el destinatario que está en el techo es precisamente
aquel cuyos restos asentados están ocupando los cupos, y un rechazo que vuelve antes nunca barre.

La auditoría del rechazo corre FUERA de la transacción a propósito: el rechazo no tiene nada que
confirmar, y una fila DENY revertida junto con el traspaso que rechazó sería un flood que nadie
puede ver después.

### Lo que espera al destinatario

`GET /v3/secrets` los nombra; no lleva ninguno de ellos, y nunca más de una página: los emisores
deciden cuántos traspasos existen, así que el tamaño de la respuesta tampoco puede ser suyo decidir.
`next_cursor` es null cuando la página es la última.

### Reclamo de un solo uso, sólo por POST

El destinatario lee una vez, y sólo mediante un POST. El reclamo destruye lo que devuelve, así que
jamás puede colgar de un GET: un prefetch, una vista previa de enlace, una sonda de monitoreo, un
reintento o un `<img src>` en la página de un atacante quemarían el secreto sin recuperación posible
y sin forma de distinguirlo de una lectura legítima. Como POST, los dos ganchos CSRF de este gateway
lo tratan como inseguro, y a un principal del canal consola se le rechaza directamente: este
traspaso es entre agentes, y una sesión de navegador es exactamente la credencial que una petición
cross-site puede tomar prestada.

Cualquier otro recibe 404 — un 403 confirmaría que el traspaso existe a alguien sin relación con él.
Reclamo y fila de auditoría confirman juntos.

### Revocación

El emisor retira lo que dio, y sólo mientras haya algo que retirar: un traspaso ya leído está
consumido, y responder 204 ahí escribiría `secret.revoked` después de `secret.read` y dejaría un
rastro afirmando que se recuperó una credencial ya entregada.

Un operador con `control` también puede revocar, pero sólo sobre un borde que toca su propio
tenant: `control` no es una licencia sobre tenants ajenos. Todos los demás necesitan `route`, el
mismo permiso con el que crearon el traspaso.

## `store.ts`

### Cursor a precisión de microsegundo

`cursor_at` es el `created_at` de la fila renderizado por PostgreSQL a precisión de microsegundo: el
driver devuelve un `Date` de JavaScript redondeado a milisegundos, y un cursor construido a partir de
eso cae ANTES de la fila de la que vino y la sirve dos veces.

### `visible` en el reclamo

`visible` responde únicamente "¿es quien llama el destinatario de un traspaso que existe?", nada
más.

### `already_read` en la revocación

Un traspaso ya leído deja de ser revocable: retirar lo que ya se entregó escribiría una fila
`secret.revoked` después de `secret.read` y dejaría un rastro diciendo que se recuperó una
credencial cuando no fue así. `already_read` separa ese caso de un traspaso que quien llama no puede
ver en absoluto.

### Techo de claves de sellado por alias

Cuántos `key_id` puede CREAR un alias dentro de la ventana. La rotación es "primero lo nuevo, después
se apaga lo viejo" y poco frecuente, así que este techo está muy por encima de cualquier cadencia
honesta; existe porque el `key_id` lo elige quien llama y cada uno nuevo es una fila permanente aquí
más una fila permanente `secret.key_published` en la auditoría. Refrescar un `key_id` que el alias ya
publicó nunca lo rechaza este techo: la guarda pregunta si la identidad es NUEVA, así que una
rotación ya anunciada sigue funcionando aunque el techo esté lleno.

`publishSealingKey` es idempotente sobre los mismos bytes; volver a ligar un `key_id` a bytes
DISTINTOS se rechaza DENTRO de la sentencia, así que ninguna carrera puede colar una clave pública
sustituida más allá de una comprobación de lectura-y-luego-escritura.

Dos cosas que una deshabilitación debe sobrevivir, ambas decididas aquí en vez de con
lectura-y-luego-escritura: repetir los mismos bytes bajo el mismo `key_id` actualiza `not_after` y
nada más; volver a publicar los mismos bytes bajo un `key_id` NUEVO se rechaza, porque esa fila
nacería `enabled` y volvería a dejar que ese mismo material de clave direccionara al alias.

`published` y `refreshed` se distinguen porque sólo el primero es un evento: `prior` lee el estado
con el que arrancó la sentencia — un `WITH` ve la instantánea, nunca el `INSERT` de al lado — así que
quien llama moviendo el `not_after` de la clave que ya anuncia es un toque, no una publicación nueva,
y no debe escribir una fila de auditoría por petición. Lo que el alias anuncia no cambió.

### Clave activa

La única clave contra la que un traspaso puede sellarse hoy: la más nueva, habilitada, sin expirar.
La rotación es "primero lo nuevo": los traspasos en vuelo siguen siendo legibles, pero nada NUEVO se
dirige a una clave vieja.

### Página acotada de traspasos pendientes

Un destinatario nunca recibe una respuesta sin límite: el emisor elige cuántos traspasos existen, así
que el tamaño de página no puede ser decisión del emisor. Se pagina por conjunto de claves (keyset)
sobre el mismo orden `(created_at,id)` que ya provee el índice de pendientes — un `OFFSET` saltaría
filas a medida que los reclamos se asientan por debajo. Lo que se le dice al destinatario que existe
lo nombra; no lleva ninguno de ellos. Se lee y se descarta una fila de más: es lo que distingue una
página llena que es la ÚLTIMA de una página llena con más detrás, así que el destinatario nunca
vuelve por un viaje redondo vacío.

### Techo por ventana de creación, no por lo que sigue vivo

Un traspaso lo crea el EMISOR contra un destinatario que nunca lo pidió, y cualquier agente con
`route` puede direccionar cualquier alias al que pueda rutear. Sin un techo, un emisor llena el
buzón de otro agente — y su disco, con blobs de 64 KiB — tan rápido como pueda hacer POST.

Se cuenta lo que se CREÓ para ese destinatario dentro de la ventana, NO lo que sigue vivo. Contar
sólo lo vivo acotaba únicamente el buzón: un emisor que elegía un `expires_at` a unos cientos de
milisegundos de distancia creaba filas invisibles al conteo en el instante en que aterrizaban, y aun
así residentes en disco — medido: 2131 filas y 133 MiB en 20 s mientras el conteo de vivos marcaba 32
todo el tiempo. Toda fila dentro de la ventana está en disco o ya fue barrida, así que este conteo es
la cifra de disco; el CHECK de la base acota cualquier vida a 24 h, así que ninguna fila sobrevive a
su ventana.

El conteo y el `INSERT` son UNA sola sentencia, así que no existe ventana de
lectura-y-luego-escritura; emisores concurrentes igual se pasan del techo por lo que está en vuelo —
medido: de 35 a 47 filas contra un techo de 32 con 64 POSTs simultáneos, hasta un 47 % de exceso. Eso
acota una inundación sin pretender ser una cuota exacta. Devuelve `false` cuando el techo rechazó la
fila.

Se cuenta por DESTINATARIO porque es el buzón del destinatario lo que debe quedar acotado, y eso
significa que un emisor con autoridad de ruteo puede ocupar los cupos de uno honesto. Eso no es
silencioso, pero lo que la auditoría acota es al EMISOR, no al borde: los rechazos van a la escalera
que dobla de ese emisor en `audit.ts`, así que una inundación escribe un puñado de filas por minuto
que nombran a quién se rechazó, cuántos rechazos representa cada fila y para qué — no una fila por
cada destinatario que logró nombrar. Un cupo vuelve en cuanto el barrido se lleva la fila asentada
que lo ocupaba.

### Barrido antes que el techo

La retención se ata al ASENTAMIENTO, y a nada más: una fila leída, revocada o expirada hace más
tiempo que la gracia es hasta 64 KiB de ciphertext que nadie podrá abrir jamás. Atarla a la EDAD en
cambio dejaba un traspaso que expiró en 300 ms residente durante una semana; atarla al asentamiento
hace que los restos de una inundación desaparezcan minutos después de aterrizar. La gracia es corta
porque el ciphertext en reposo es un pasivo, y no es cero para que una fila no desaparezca de debajo
de quien esté mirando qué pasó.

`read_at` y `revoked_at` se excluyen mutuamente por construcción — un reclamo rechaza una fila
revocada y una revocación rechaza una ya leída — así que `COALESCE` nombra el instante en que la
fila se asentó, cayendo a `expires_at` para una que nadie tocó nunca.

Corre en lote para que una concesión nunca se vuelva un borrado sin límite, y corre ANTES de que el
techo decida: el destinatario que está en el techo es exactamente aquel cuyos restos hay que barrer
para que vuelvan los cupos que ocupan.

### Reclamo en una sola sentencia

Lectura de una sola vez, en UNA sentencia. Bajo READ COMMITTED un segundo lector bloquea sobre la
fila, re-evalúa el predicado con `read_at` ya escrito y no devuelve nada; leer primero y escribir
después dejaría la ventana que esta sentencia no tiene. La subconsulta `visible` corre sobre la misma
instantánea, así que informa el estado ANTES del reclamo: eso es lo que separa "no eres el
destinatario" (404) de "ya no está" (410) sin confirmarle nada a un desconocido.

### Revocación condicional

Condicional por la misma razón que el reclamo: predicado y escritura son una sentencia, y la
subconsulta `already_read` lleva el mismo alcance así que un desconocido tampoco aprende nada. El
digest se calcula dentro de PostgreSQL para que el ciphertext nunca salga de la base rumbo a la fila
de auditoría.

## Qué NO está acotado, y por qué eso es aceptable

Tres escrituras de este plano se dejaron deliberadamente sin techo ni escalera propios:

- **La auditoría de `secret.granted`.** Se escribe una fila por cada concesión aceptada, sin
  throttle propio — a diferencia de `secret.denied`, que sí lo tiene. No hace falta: el volumen de
  filas `secret.granted` ya está acotado por `MAX_HANDOFFS_PER_RECIPIENT`, el mismo techo que decide
  si el `INSERT` se acepta. Un flood de concesiones exitosas no puede superar lo que el techo del
  buzón del destinatario ya permite.
- **El `UPDATE` de refresco de `publishSealingKey`.** Repetir la misma publicación (mismo `key_id`,
  mismos bytes) dispara un `UPDATE` de `not_after` en cada petición, sin límite de tasa y sin fila de
  auditoría. Es intencional: la fila no cambia lo que el alias anuncia, así que no es un evento que
  auditar, y el `UPDATE` no crea estado nuevo — es indistinguible de un cliente que reintenta la
  misma publicación.
- **El toque silencioso de una clave deshabilitada.** El `ON CONFLICT` de `publishSealingKey`
  selecciona por `(tenant_id,alias,key_id)`, no por si la clave está `enabled`. Repetir la
  publicación de un `key_id` que ya fue deshabilitado actualiza su `not_after` igual, sin
  reactivarla y sin fila de auditoría — sólo toca metadata de una fila que ya no direcciona a nadie.
  El camino que SÍ se rechaza (`disabled_material`) es el de bytes iguales bajo un `key_id`
  DISTINTO, porque ésa sí volvería a hacer que el material deshabilitado direccionara al alias.

Ver `docs/adr/007-traspaso-sellado-de-secretos.md` para la decisión criptográfica que estas tres
notas dan por sentada: el sobre sellado, el AAD que lo ata al traspaso concreto y el fallo cerrado
ante cualquier apertura inválida.
