# ADR-007: traspaso sellado de credenciales entre agentes

**Estado:** aceptado. El plano del gateway y la migración `039` están en el árbol; la mitad
receptora vive en `@cauce/adapter-sdk` pero todavía ningún binario de arnés cablea el transporte.

## Contexto

Un agente necesita a veces darle a otro una credencial concreta: la clave de un proveedor para una
tarea puntual, un token de despliegue, la contraseña de un servicio. Hasta ahora las únicas vías
eran pegarla en el texto del mensaje —que queda literal en `messages.body`, en la transcripción del
arnés y probablemente en un log— o que una persona la copie a mano fuera del sistema.

El bus no puede resolverlo transportando el valor en claro y prometiendo cuidarlo. PostgreSQL es la
fuente durable: lo que pasa por ahí queda en un backup, en un volcado off-site que es append-only,
y a la vista de cualquiera con acceso a la base. La única propiedad que sirve es que **el gateway
no pueda leer lo que transporta**.

## Decisión

Cifrado de sobre, sellado por el **emisor**, opaco para el gateway, abierto por el adaptador del
**destinatario**:

```
k      = HKDF-SHA256(ikm = X25519(efímera, destinatario), salt = "cauce-v3/secret-handoff/v1", info = AAD, L = 32)
sellado = AES-256-GCM(k, nonce, claro, aad = AAD) || tag
```

Una sola suite, nombrada. No hay negociación de algoritmo por fila: un `algorithm` libre sería
exactamente la superficie que este diseño no quiere tener, y por eso la columna lleva un CHECK que
sólo admite `x25519`.

El `AAD` es también el `info` del HKDF, y ata el sobre a su traspaso concreto:

```json
{"v":1,"id":…,"from_tenant":…,"from_alias":…,"to_tenant":…,"to_alias":…,"key_id":…}
```

El orden de las claves ES el contrato. Con ese amarre, **un sobre sellado no se puede reenviar a
otro destinatario**, ni con otro id, ni contra otra clave publicada: no hay nada más que comprobar
para que un replay falle cerrado. El id lo elige el emisor porque el sellado lo ata; es un asa
opaca, no una afirmación de identidad — la identidad sigue saliendo del principal autenticado, y un
id repetido lo rechaza la clave primaria en vez de pisar nada.

Toda apertura que falla —longitudes malas, clave equivocada, ciphertext, nonce, clave efímera o
amarre manipulados— levanta **el mismo error con el mismo texto**: quien llama no puede convertirse
en un oráculo de descifrado, y ningún fragmento de claro ni de material de clave puede llegar a un
mensaje, a un log ni a una traza.

## Construcción

**La mitad privada la genera el adaptador dentro de su contenedor** y se escribe `0600` con
`O_EXCL`; una segunda arrancada que pierde esa carrera relee lo que escribió la ganadora, porque dos
mitades de una misma identidad harían indescifrable todo lo sellado contra la clave publicada. Sólo
la **mitad pública** se publica (`POST /v3/sealing-keys`), y el sujeto es siempre el principal
autenticado: publicar una clave por otro alias convertiría al publicador en destinatario de todos
sus traspasos futuros. Reatar un `key_id` a bytes distintos se rechaza **dentro de la sentencia**,
no con un lee-y-escribe que una carrera podría colar.

**Esquema `039`** (aditivo: dos tablas nuevas, ninguna fila reescrita; con las tablas vacías el
sistema se comporta igual que antes):

- `agent_sealing_keys` — mitad pública por `(tenant, alias, key_id)`, 32 bytes crudos con CHECK de
  longitud, `not_after` opcional, `enabled`, y `ON DELETE CASCADE` contra `agents`: una clave sin
  dueño sólo serviría para que el próximo que reutilice el nombre herede material ajeno. El
  `key_id` entra en la clave primaria porque la rotación es make-before-break y sobrescribir la
  fila dejaría ilegible lo sellado en vuelo. Sellar algo **nuevo** sólo se admite contra la clave
  vigente (la más reciente, habilitada y no caducada).
- `secret_handoffs` — el traspaso: emisor, destinatario, `label`, `sealed`, `sealing_key_id`,
  `ephemeral_public`, `nonce`, `expires_at`, `read_at`, `revoked_at`. **No existe columna `value`,
  `plaintext` ni `hint`**: si no existe la columna, no hay dónde equivocarse.

**Caducidad obligatoria y acotada por la base**, no por cortesía de la aplicación:
`expires_at > created_at AND expires_at <= created_at + interval '24 hours'`. Un traspaso que nadie
recoge deja de ser recogible pase lo que pase con el código que lo creó.

**Lectura única** por `UPDATE` condicional en UNA sentencia:

```sql
UPDATE secret_handoffs SET read_at=now()
 WHERE id=$1 AND to_tenant=$2 AND to_alias=$3
   AND read_at IS NULL AND revoked_at IS NULL AND expires_at > now()
```

Bajo `READ COMMITTED` el segundo lector se bloquea en la fila, reevalúa el predicado con `read_at`
ya escrito y devuelve cero filas. Comprobar antes y escribir después dejaría la ventana que esta
sentencia no tiene. La **revocación** es condicional por la misma razón: el emisor por identidad,
o un operador con `control` confinado a un tenant del borde.

**Se reclama con `POST /v3/secrets/:id/claim`, jamás con un `GET`.** La lectura destruye lo que
devuelve, así que no puede colgar de un método seguro: un prefetch, una vista previa de enlace, una
sonda de monitorización, un reintento o un `<img src>` en una página ajena quemarían el secreto sin
recuperación y sin forma de distinguirlo de una lectura legítima. Como `POST`, los dos ganchos CSRF
del gateway lo tratan como inseguro, y un principal del canal `console` se rechaza de plano: el
traspaso es entre agentes, y una sesión de navegador es justo la credencial que una petición
cross-site puede tomar prestada. `GET /v3/secrets` sigue existiendo y lista **sólo referencias**, y
nunca más de **20 por página**, con cursor keyset sobre el mismo `(created_at,id)` que ordena el
índice: quien decide cuántos traspasos existen es el emisor, así que el tamaño de la respuesta no
puede ser suyo también. Un `OFFSET` se saltaría filas conforme las reclamaciones se asientan por
debajo.

**Un traspaso lo crea el emisor contra un destinatario que no lo pidió**, y cualquier agente con
`route` puede dirigirse a cualquier alias al que sepa rutear. Sin techo, un emisor llena el buzón
ajeno —y su disco— con sobres de hasta 64 KiB que el otro tiene que paginar. Por eso el recuento de
traspasos del destinatario y el `INSERT` son **una sola sentencia**: por encima de **32** la fila no
entra y la petición recibe 429 `too_many_handoffs`.

El recuento es de lo **creado en las últimas 24 h**, no de lo vivo. Contar lo vivo acotaba sólo el
buzón: bastaba elegir un `expires_at` a 300 ms para escribir filas que el recuento no volvía a ver
nunca y el disco sí —medido: 2131 filas y 133 MiB en 20 s mientras el recuento de vivos informaba
de 32 todo el rato—. Como la base impide que una fila viva más de 24 h y la barrida se lleva lo
resuelto minutos después, todo lo que un destinatario tiene en disco cae dentro de la ventana: el
recuento **es** la cifra de disco. La lista de pendientes sigue siendo de lo vivo, que es lo único
que el destinatario puede reclamar.

Tres piezas más lo sostienen, y ninguna basta sola. La caducidad tiene **suelo de 30 s** además del
techo de 24 h, y pedir menos responde 400 nombrando el suelo: un traspaso que caduca antes de que el
destinatario pueda sondear y reclamarlo no era un traspaso, era una forma de escribir una fila de
64 KiB. La barrida corre **antes** de que el techo decida, así que el destinatario que está en el
techo es justo aquel cuya basura se retira y a quien le vuelven los huecos. Y el índice de
pendientes lleva `expires_at` dentro, con un índice completo por `(destinatario, created_at)` para
el recuento, de modo que ni el techo ni la página recorren la basura que ignoran.

No hay ventana de lee-y-escribe; emisores concurrentes pueden pasarse por los que estén en vuelo
—medido: entre 35 y 47 filas para un techo de 32 con 64 POST simultáneos, hasta un 47 % de exceso—,
que acota una inundación sin fingir ser una cuota exacta. La fila `secret.denied` se escribe **fuera** de la
transacción a propósito: un rechazo no tiene nada que confirmar, y una denegación revertida junto al
alta que rechazó es una inundación que después no ve nadie. Pero el rechazo lo provoca quien inunda,
así que auditarlo sin límite convertía la inundación ya rechazada en una **segunda** escritura sin
techo, esta vez en `audit_events` —medido: 4071 filas en 40 s—, y en esa tabla la retención de 014
no barre nunca estas filas: lo que no se acote aquí es permanente. Los rechazos se escriben en
**escalera de duplicación**: el 1.º, 2.º, 4.º, 8.º… de cada ventana de un minuto, y cada fila lleva
`denials_in_window` con el recuento vivo, así que cuatro mil rechazos son trece filas que ya dicen
lo grande que se está haciendo. Se eligió la escalera y no «una fila por minuto» porque una sola
fila esconde el tamaño de la inundación hasta que la ventana rueda, y el número que hace falta es
el que se lee mientras ocurre.

La ventana es **por EMISOR** —tenant, alias y canal del principal autenticado— y por nada que la
petición pueda elegir. Atarla al par (emisor, destinatario) fue un error medido: bastaba variar el
`to_alias` de cada petición para abrir ventana nueva cada vez —24 046 filas en 20 s frente a las 16
que escribe la misma inundación con un nombre fijo—, porque `target_not_routable` no necesita que
el destinatario exista. Un techo que quien llama puede rodear no es un techo. Del mismo modo, el
sobre se valida **antes** de preguntar por la autoridad de ruteo: una petición que este plano va a
rechazar igual no compra ni una consulta a la base ni la fila de auditoría que cuesta un rechazo.
Como un emisor comparte una sola escalera para todos sus motivos, el **primer** rechazo de cada
motivo distinto se escribe aunque no caiga en un escalón, hasta un tope: una inundación contra el
techo no puede enterrar el único rechazo de ruteo que había debajo.

El techo de traspasos es **por destinatario**, y eso deja que un emisor ruteable ocupe los huecos de
uno honesto: nada de eso ocurre a oscuras —cada fila nombra al emisor, el motivo y cuántos rechazos
representa— y ningún hueco dura más de 24 h.

**En la lectura, un desconocido recibe 404, nunca 403**: un error de autorización confirmaría que
el traspaso existe, que es justo el hecho que conviene ocultar. El resto del plano sí responde con
códigos que hablan, porque ahí no hay nada que ocultarle a quien pregunta por lo suyo: 403 al
sellar sin autoridad de ruteo sobre el destinatario o al pedir su clave pública, 409 ante un `id`
repetido, un `key_id` reatado a bytes distintos, una clave que el destinatario no publica como
vigente o unos bytes deshabilitados que alguien intenta republicar bajo un `key_id` nuevo, 429
cuando el destinatario ya tiene lleno su cupo de traspasos recientes o el alias el de claves
recientes, y 410 al destinatario legítimo de un traspaso ya leído, revocado o caducado —y al emisor
que intenta revocar uno ya leído, porque retirar lo ya entregado escribiría un `secret.revoked`
después de su `secret.read` y dejaría un rastro que dice que una credencial se retiró cuando no se
retiró—. El único 403 del camino de lectura es el del canal `console`, y no es un oráculo: se
levanta antes de mirar ninguna fila, así que no distingue un traspaso que existe de uno que no. Las
rutas viven fuera de `/v3/console/` porque quien llama es un agente con su propio certificado, no
un navegador.

**Ningún otro error habla.** La respuesta lleva lista blanca: sólo los errores que este plano
levanta a propósito, más los de autenticación y autorización —cuyo texto describe a quien llama, no
al despliegue—, salen con texto; un fallo de driver, un pool muerto o un `TypeError` colapsan a un
500 opaco. Un error de conexión lleva el host y el puerto de la base, y un fallo interno no es un
error del cliente al que haya que pedirle que deje de reintentar. La validación va toda por
`safeParse`, así que ningún texto lanzado por un esquema escapa por este camino.

**Cada mutación confirma su fila y su fila de auditoría en UNA transacción** (`withTransaction`,
como el plano de control de sesiones). Un traspaso que existe sin su `secret.granted`, o consumido
sin su `secret.read`, sería una credencial reclamable que nadie sabe que se otorgó: ese agujero no
depende aquí del orden de dos escrituras sueltas.

**La clave pública se puede descubrir**: `GET /v3/sealing-keys/:tenant/:alias` devuelve la vigente
del destinatario —`key_id`, algoritmo, bytes y `not_after`— con la **misma** autoridad de ruteo que
hace falta para sellarle algo. Sin esta ruta `agent_sealing_keys.public_key` sería de sólo escritura
y ningún emisor podría dirigirse a nadie; con ella, un alias sólo aprende la clave de alguien a
quien ya tiene permitido entregar un secreto.

**Qué se audita**: `secret.key_published`, `secret.granted`, `secret.read`, `secret.revoked` y
`secret.denied`, con una lista blanca de campos —`label`, tenant y alias del destinatario,
`sealing_key_id`, `key_id`, la huella de la clave publicada, motivo, la sha256 del `id` del traspaso
—el asa que ata las cuatro líneas de un mismo traspaso sin escribir el `id` en claro— y la sha256
del ciphertext recortada a 16 hex, que sirve para atar un `read` con su `granted` y para nada más. Publicar la
mitad pública se audita porque **rotar la clave anunciada decide a quién van dirigidos todos los
traspasos futuros** de ese alias; republicar los mismos bytes no vuelve a habilitar una clave que
estaba deshabilitada. Se audita **sólo cuando cambia lo que el alias anuncia** —un `key_id` nuevo o
unos bytes nuevos—: mover el `not_after` de la clave ya publicada es un roce, no un suceso, y
auditarlo escribía 17 363 filas permanentes en 10 s a partir de una sola fila —medido—. `POST
/v3/sealing-keys` exige el permiso **`read`**, el mismo de la mitad receptora del plano (listar y
reclamar): quien no puede recibir un traspaso no tiene por qué anunciar la clave a la que se le
sellaría; `route` es la mitad emisora y ahí no pinta nada. Y como el `key_id` lo elige quien llama y
cada uno nuevo es una fila durable más su fila de auditoría, un alias no puede **crear** más de 8
identidades de clave por ventana de 24 h: refrescar una que ya publicó nunca choca con ese techo,
y el rechazo, cuando llega, va a la misma escalera por emisor que los demás.

**Jamás se audita** el valor ni los bytes sellados; el `label` NOMBRA la
credencial («ANTHROPIC_API_KEY»), no la contiene. El cuerpo de la petición rechaza de plano las
claves `tenant_id`, `alias`, `from_tenant`, `from_alias`, `value`, `plaintext`, `secret`, `credential`,
`token` y `password`: un mal uso falla ruidoso en vez de reinterpretarse en silencio.

**Las filas ya resueltas se podan, y sólo ésas.** Cada `POST /v3/secrets` borra, dentro de su propia
transacción y **antes** de que el techo decida, hasta 200 traspasos cuya resolución —leído, revocado
o caducado, lo que llegara primero: `COALESCE(read_at,revoked_at,expires_at)`— es de hace más de
**15 minutos** (`FOR UPDATE SKIP LOCKED`, sobre un índice por `created_at`). La retención va atada a
la **resolución**, no a la antigüedad: atada a la antigüedad, un traspaso que caducaba a los 300 ms
se quedaba una semana en disco sin que nada lo contara. La gracia es corta porque ciphertext que
nadie puede volver a abrir es sólo pasivo, y no es cero para que una fila no desaparezca bajo quien
está mirando lo que acaba de pasar. Es también lo que devuelve los huecos del techo. Nada de lo que
borra es prueba: la prueba vive en `audit_events`.

En el destinatario el valor existe como **un fichero `0600` en un directorio `0700` propio de los
secretos —nunca el de los adjuntos ni el espacio de trabajo del agente—, mientras dura el turno**.
El amarre se reconstruye desde la referencia que trajo la entrega y desde la identidad propia del
adaptador, nunca desde el sobre recibido: quien pudiera contestar el transporte elegiría si no el
AAD que abre su propio blob. En particular el `key_id` del AAD sale de la clave local y el
`sealing_key_id` que declara el sobre se compara contra él. Un traspaso que no se puede abrir se
salta y se anota con un código de razón por comprobación; no cuesta el turno.

**El punto de suelta del adaptador es mecánico**, porque el agente recibe la RUTA en su prompt y el
inliner desreferencia cualquier ruta absoluta que devuelva. Antes de leer nada, un artifact que
resuelve dentro del directorio de secretos o a la ruta de un secreto se retiene con
`uri: cauce:secret-withheld`; se retiene también el que tenga el sha256 de un secreto, lo haya leído
el inliner de una ruta o lo haya escrito el modelo como `data:` —que se decodifica y se hashea—; y
el valor literal se sustituye por la marca de redacción en la respuesta, en los cuerpos delegados,
en los `notify` y en los tres campos de texto libre de un artifact. La huella y el valor se capturan
**al materializar el secreto**, con el claro en la mano: releer el fichero al armar el ACK le daba
al agente un desarme de un solo comando sobre un fichero que es suyo. Nada de esto puede costar el
turno. Lo que este punto **no** puede hacer está en Consecuencias.

## Alternativas rechazadas

- **HPKE contra las hojas mTLS que ya existen.** Habría evitado un material de clave nuevo, pero no
  se puede: las hojas de agente se emiten **RSA-3072 con `keyUsage=digitalSignature,keyEncipherment`**,
  y sobre todo **el gateway no guarda el certificado, guarda su huella sha256**. No tiene el cuerpo
  público de nadie contra el que sellar, y almacenarlo para esto convertiría el registro de
  identidades en un almacén de material criptográfico que hoy no es.
- **Un plano de blobs genérico.** Una tabla de objetos cifrados con permisos por encima resuelve
  más casos y por eso mismo pierde las propiedades que valen: la lectura única, la caducidad
  obligatoria y el hecho de que la fila no tenga dónde alojar un valor en claro dejan de ser
  estructurales y pasan a depender de que la capa de aplicación se comporte.
- **Guardar el valor en `messages.body`, aunque fuera cifrado.** El cuerpo se copia a
  transcripciones, a `dead_letters`, a la consola y a los volcados off-site append-only. Un secreto
  ahí no se puede retirar después: la poda de bytes de adjuntos existe precisamente porque ese
  camino es de ida.

## Consecuencias

- El gateway transporta credenciales sin poder leerlas. Un volcado de la base, un backup filtrado o
  un operador con acceso ven ciphertext y metadatos de ruteo.
- El emisor sólo puede sellar hacia quien tiene autoridad de ruteo sobre el destinatario (misma
  sala del tenant, o arista ACL habilitada con `allow_route` y `allow_control`), y contra la clave
  que el destinatario tiene publicada como vigente.
- **No sirve para revivir un adaptador muerto.** Reclamar un traspaso exige un turno vivo del
  destinatario, y un adaptador sin credencial no tiene turno. La vía del operador fuera de banda
  sigue siendo el canal de arranque.
- **El destinatario ve el claro, y eso es el canal, no un fallo del canal.** Lo que se sostiene es
  una afirmación estrecha: *Cauce nunca escribe el valor fuera de ese fichero `0600`*. Lo que no se
  sostiene, y no hay que escribirlo como si sí: que el valor no pueda aparecer nunca en un mensaje,
  en una transcripción o en un log. El bloque de contexto **pide** al modelo que no lo repita, y una
  instrucción no es un control; el punto de suelta borra el **valor literal** y retiene los **bytes
  exactos**, no el mismo secreto partido en trozos, recodificado o parafraseado. Si eso llega a `messages.body`, llega también a
  `dead_letters`, a la consola y a los volcados off-site append-only: el mismo camino de ida que
  esta ADR le reprocha a guardar el valor en el cuerpo. La redacción de publicación
  (`CAUCE_REDACT_PUBLISH`) mitiga sólo familias conocidas; una contraseña de base de datos o un
  token a medida no encajan en ninguna. **Quien decide qué credencial vale la pena traspasar tiene
  que contar con eso.**
- El `down` de `039` no lleva la compuerta «después de que haya evidencia» que sí llevan otras
  migraciones: estas tablas guardan estado efímero, no prueba. Tirarlas destruye traspasos en vuelo
  —el emisor los vuelve a sellar— y no destruye ninguna prueba: la auditoría vive en `audit_events`
  y la migración no la toca.

## Fuera de alcance, dicho explícitamente

- **Negociación de capacidad de adjuntos en el borde de delegación.** No hay columna de capacidad
  en `agents` y no se inventa: un destino que no puede con los bytes degrada igual que un artifact
  fuera de cupo.
- **Materialización de credenciales por alias.** Qué credencial recibe cada agente, y cuándo, es
  decisión del dueño; aquí sólo está el canal.
- **Rotación de identidades en `ops/`.** El gateway ya admite dos registros vivos del mismo
  principal; el bloqueo make-before-break está en los scripts de aprovisionamiento.
- **`client_max_body_size` en los nginx de la consola.** Hoy no está declarado en ninguno de los
  dos ficheros, así que rige el defecto de nginx, muy por debajo del tope de publicación del
  protocolo.
