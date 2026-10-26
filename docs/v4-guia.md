# Guía de uso y administración de Cauce V4

Abre la consola de tu instalación e inicia sesión. Cada acción se limita a la empresa activa y a los permisos de tu cuenta. La versión publicada se consulta en [HISTORIAL](../deploy/HISTORIAL.md); los procedimientos del operador están en [Operación](operacion.md).

El menú es **Chat**, **Oficina**, **Cuentas**, **Mis cuotas**, **Colas y DLQ**, **Señales y auditoría**, **Ajustes**, **Terminal** y **Ayuda** (`console/src/nav.ts`). Esta guía recorre el alta y el día a día. El mapa de cada vista, sus pestañas y sus botones está en [Consola](consola.md#vistas).

## Registrarte y entrar en tu empresa

1. En la pantalla de acceso, pulsa **Crear cuenta y empresa**. Completa tu nombre, correo, contraseña (12 caracteres o más), el nombre de la empresa y el identificador: de 2 a 63 caracteres, empieza por una letra y usa minúsculas, números o guiones.
2. Al terminar se crean la empresa y tu acceso como dueño, y entras en el **Chat**.
3. El chat ya lista dos agentes en borrador, sin ordenador: `owner` (con tu nombre, en la sala `office`) y `context-director`. El aviso «Sin preparar» no es una caída. El espacio de la empresa tiene un identificador que empieza por `hub-`. Para conectar un ordenador y añadir agentes, abre **Ajustes**.

Si administras la plataforma, el selector de empresa permite cambiar la empresa activa. Compruébala antes de crear o borrar recursos. Los demás usuarios trabajan dentro de su empresa y de los espacios autorizados.

## Invitar a una persona a tu empresa

1. Abre **Ajustes → Acceso y roles → Personas → Administrar personas**. Si la tarjeta muestra **Invitar persona**, ese botón abre el mismo formulario.
2. Pulsa **Invitar persona**. El formulario se titula igual. Completa correo de acceso, nombre y permiso web: **Lector** u **Operador**.
3. Elige el **Espacio de la persona**. En **Identidad de la persona**, puedes dejar **Crear identidad para este correo**: funciona aunque la empresa nueva aún no tenga agentes habilitados.
4. Define una contraseña inicial, revisa **Habilitar acceso al crear** y pulsa **Crear cuenta de persona**. Entrega el acceso por un canal privado; este flujo crea la cuenta y no envía una invitación por correo.

El permiso de operador no concede por sí solo administración de empresa. Para asignarla, abre **Ajustes → General → Empresas → Autoridad de empresa**. **Retirar** revoca el acceso y conserva su autoría; **Restaurar** permite iniciar una sesión nueva. La purga puede rechazarse si quedan la membresía del alta o la auditoría del retiro: la cuenta queda retirada y sin acceso. Tras retirarla, el inicio de sesión puede decir **Correo o contraseña incorrectos**.

## Conectar un ordenador

1. Abre **Ajustes → Computadoras → Conectar un ordenador → Añadir ordenador**.
2. Escribe identificador y nombre, pulsa **Crear invitación** y conserva la invitación antes de cerrar: es de un solo uso y tiene caducidad.
3. En el ordenador destino, usa un usuario dedicado a tu empresa con Cauce CLI y los requisitos que indica la pantalla. Ejecuta el comando de enrolamiento mostrado y pega la invitación por su entrada estándar.
4. Si aparece el comando **`cauce hosts setup`**, ejecútalo allí para instalar el ejecutor. Comprueba **`cauce hosts status`** y vuelve a la consola para **Releer invitaciones**.

El latido confirma conexión; el ejecutor listo confirma que puede operar agentes. Si la pantalla solo ofrece enrolamiento, falta habilitar la preparación firmada de esa instalación. Detalles y recuperación: [alta de servidor](v4-alta-servidor.md).

## Registrar una cuenta y ver su cuota

1. Abre **Mis cuotas** y pulsa **Registrar cuenta**. Ese botón abre el formulario. Elige proveedor, escribe el **Nombre de la cuenta** y pulsa el **Registrar cuenta** de dentro del formulario.
2. En su tarjeta, pulsa **Iniciar sesión**. Si no hay un ordenador con ejecutor de cuotas, el botón queda deshabilitado: la tarjeta dice **Pendiente de autenticación** y **Sin datos**, y **Entornos de consulta** avisa que no hay ejecutor. No es cuota agotada. Conecta antes un ordenador en **Ajustes → Computadoras**. Si hay varios ordenadores compatibles, elige uno; Cauce prepara el entorno de consulta cuando falta.
3. Completa el login del proveedor en la terminal web privada. Si exige autorización en su página, sigue las instrucciones que muestra el propio CLI. Cuando termine, pulsa **Verificar conexión** y espera la confirmación de identidad.
4. En **Entornos de consulta**, cuando ya exista un entorno, usa **Consultar cuotas**. Sin ordenador compatible, **Crear entorno** no se puede completar y **Consultar cuotas** todavía no aparece. **Actualizar cuotas y entornos** relee el estado de la página. **Fijar cuenta** mantiene a mano las tarjetas que sigues.

Las ventanas, porcentajes disponibles y reinicios vienen del CLI del proveedor; cada proveedor puede informar ventanas distintas. En el formulario el proveedor Codex se llama **GPT / Codex**. Revisa la hora de lectura. **Sin datos**, **Datos antiguos** y **Error de consulta** son estados distintos de cuota agotada. **Sin lector de cuota** significa que ese proveedor no informa ventanas. Si la sesión vence, vuelve a **Iniciar sesión** y repite la consulta.

El saldo se consulta en **Mis cuotas**. **Cuentas** mantiene **Inventario** y **Asignaciones**, para administrar pagadores y ruteo; la antigua pestaña **Consumo** está retirada. Para mantener el CLI o retirar su contenedor, usa **Actualizar CLI** o **Eliminar entorno**. Si **Actualizar CLI** falla, el aviso nombra la operación y su causa; vuelve a intentarlo y, si se repite, el diario del ejecutor en ese ordenador trae el motivo. Eliminar una cuenta exige retirar antes sus entornos y asignaciones. Capacidades y límites: [cuotas](v4-cuotas.md).

Registrar, editar o borrar la cuenta lo hacen el dueño de la empresa o un administrador de plataforma. Un administrador de la empresa puede crear el entorno, consultarlo, usar **Actualizar CLI** y **Eliminar entorno**, pero **Registrar cuenta** queda deshabilitado: el título dice «Solo el dueño de la empresa o un administrador de plataforma registra cuentas de cuotas. Pide a uno de ellos que la registre.» Si intenta guardar, el título es «Tu rol no permite guardar cuentas de cuotas. Pide al dueño de la empresa o a un administrador de plataforma que lo haga.» Quien solo lee puede consultar el saldo. Si el rol no alcanza para el entorno, el aviso es «Tu rol no permite operar entornos de cuotas. Pide a un dueño o administrador de la empresa que lo haga.»

### Claude para un agente OpenClaw

Un agente OpenClaw que usa Claude entra con el método `cli`: el login de Claude Code queda aislado por cuenta, dentro del perfil de esa cuenta, y OpenClaw lo ejecuta con su runtime `claude-cli` y ese mismo directorio de configuración. Cauce comprueba la identidad con `claude auth status`, que devuelve el correo de la cuenta. El método `setup-token` sigue disponible, pero no expone el correo: no puede demostrar la identidad.

1. En la tarjeta de la cuenta, pulsa **Iniciar sesión**.
2. Abre el enlace que muestra el terminal web y autoriza la cuenta en la página de Claude.
3. Pega el código en el terminal y pulsa **Verificar conexión**.

Cambiar de método reescribe solo el `openclaw.json` del agente, de forma atómica.

### Quién puede hablar con un agente OpenClaw

OpenClaw no tiene sesión humana aislada: un mensaje de la consola solo llega a su sesión canónica si quien lo escribe figura en la lista de humanos compartidos. Esa lista son los dueños y admins activos de la empresa del propio agente, nunca de otra empresa. Al añadir o quitar un admin la lista cambia y el contenedor del agente se recrea en la siguiente admisión. Los demás arneses (codex, claude, grok, muse) usan sesiones humanas aisladas y no dependen de esta lista.

## Compartir una cuenta entre agentes

En la ficha del agente, abre la pestaña **Ajustes** y, en **Cuentas de cuota**, elige la cuenta, pulsa **Previsualizar cuenta** y después **Guardar cuenta de cuota**. Puedes vincular la misma cuenta a varios agentes: comparten la suscripción y el saldo. La ficha y la oficina muestran sus datos; **Mis cuotas** permite seguirla incluso sin agentes. Una cuenta sin sesión verificada requiere primero **Iniciar sesión** en su tarjeta. Para cambiarla, repite esa previsualización y el guardado.

## Crear y preparar un agente

1. Abre **Ajustes → Agentes → Añadir agente** y elige **Registrar el agente**.
2. Completa espacio de trabajo, alias y nombre visible; avanza por computadora y grupo inicial. Puedes registrarlo sin computadora y asignarla después desde la pestaña **Ajustes** de su ficha.
3. En la revisión, pulsa **Previsualizar alta** y después **Crear registro**. El registro se crea deshabilitado; aún falta preparar su ejecución.
4. Con una computadora asignada, pulsa **Preparar en la computadora**, revisa el plan y encola la operación. También puedes abrir la ficha, ir a **Ejecución** y elegir **Preparar agente**. Completa la autenticación del proveedor cuando se solicite.

El asistente también ofrece **Solo preparar, sin desplegar**. Una operación en cola o en ejecución todavía no está completada: revisa sus pasos y el estado final antes de iniciar el trabajo. Operación y CLI: [gestión de espacios](v4-cli.md).

Si el agente estaba pausado y su grupo principal quedó deshabilitado, al reprepararlo la propia ficha marca ese grupo para que lo habilites: el aviso «Para activar el agente su grupo principal debe quedar habilitado» señala la casilla **Habilitar membresía** que hay que marcar, y los rechazos conocidos de la preparación se muestran ya traducidos con la acción siguiente en lugar del mensaje crudo del servidor.

Si tras un despliegue el contenedor quedó con una imagen anterior, la operación puede registrar `RUNTIME_DRIFT` mientras espera autenticación (`awaiting_auth`). Pulsa **Iniciar sesión**: el login prepara o recrea el contenedor antes de abrir el terminal, conservando volúmenes, sesión del proveedor y ampliaciones. Completa el login y verifica la cuenta para que la ficha reanude la operación. Si usas el panel de la operación y pide **Reanudar**, púlsalo después de verificar la cuenta.

## Crear una sala

1. Abre **Ajustes → Espacios y salas** y, en la tabla **Salas**, pulsa **Crear sala/grupo**.
2. El espacio es el identificador `hub-…` de tu empresa. El de la sala tiene entre 1 y 128 caracteres.
3. Pulsa **Previsualizar cambio** y después **Confirmar creación**.
4. Arriba, **Alta de espacios** ofrece **Un solo recurso** y **Espacio completo, paso a paso**. En **Un solo recurso**, **Recurso** elige **Sala**, **Espacio** lleva el `hub-…` y **Sala** el identificador. **Previsualizar el alta** y después **Crear**. La opción **Membresía: una persona o un agente en una sala** solo añade una pertenencia y no crea el agente. **Espacio completo, paso a paso** recorre **Espacio**, **Sala**, **Membresía** y **Revisar y aplicar**, con **Previsualizar paso** y **Aplicar paso** en cada uno.
5. Para quitarla, en la misma tabla pulsa **Eliminar**, luego **Previsualizar cambio** y **Confirmar eliminación**. El aviso nombra la sala borrada. **Retirar** es una operación distinta.

## Editar, detener o eliminar un agente

Abre su ficha desde **Ajustes → Agentes**. Las pestañas son **Estado**, **Ajustes**, **Ejecución**, **Ampliaciones** y **Grupos**. **Ajustes** edita el registro: **Previsualizar cambio** y después **Aplicar cambio**. **Ejecución** prepara, actualiza, inicia o detiene su ejecución y muestra el resultado remoto. En **Estado**, **Arrancar** y **Detener** abren **Ejecución** con la acción elegida; ahí se previsualiza y se confirma.

Antes de parar nada, **Actualizar ejecución** de un agente Codex, Claude, Grok o Muse con TUI compartida en contenedor propio comprueba que la conversación se podrá continuar. Si la actualización conserva modelo, esfuerzo y cuenta, el SDK vigente comprueba que reanuda la conversación actual. Si cambia alguno de los tres, comprueba que lanza la nueva selección con la identidad exacta de la operación. Si la comprobación falla, la operación se detiene en ese paso con el motivo «La TUI compartida no podría continuar la conversación de este agente…»: no se paró nada y el agente sigue con su ejecución anterior. El aviso explica qué hacer. Con **Abrir terminal** revisa el historial del agente. En Codex deja solo la conversación propia en su carpeta de sesiones. En Claude, Grok o Muse indica cuál continuar con `shared-session.js seed --native-id <id>`. Después prepara una actualización nueva. La consola todavía no ofrece empezar una conversación nueva.

Cancelar una **Actualizar ejecución** que falló al principio conserva el runtime anterior solo si la preparación ya terminó, el resto de pasos salvo el de parar siguen pendientes, hay una sola fila anterior del agente y la colocación no cambió: misma clave de runtime, modo contenedor, ordenador, nombre de contenedor, usuario y los dos directorios de la colocación. En la tarjeta **Operación de flota** pulsa **Cancelar**. El titular dice que la operación se canceló y que no se siguieron aplicando pasos; el estado queda **Cancelada**. El contenedor vuelve a la imagen anterior, con sus volúmenes y la generación de credencial previa. Si el adaptador ya estaba en marcha y el paro no llegó a cumplirse, el proceso sigue. La fila del agente queda deshabilitada, con ciclo de vida fallido. Después, en **Estado**, pulsa **Arrancar**: solo abre **Ejecución** con **Iniciar** elegido. Nada arranca hasta **Previsualizar operación** y **Confirmar operación**.

Esa cancelación no se admite si ya empezaron los pasos de credenciales o de runtime. Esas compensaciones paran y revocan, y exigen la comprobación de paro o de revocación.

Si **Actualizar ejecución** falla al refrescar la imagen, la tarjeta no pega la causa en inglés: dice «El ejecutor no pudo completar este paso.» La causa está en el diario del gateway, en la línea `fleet host command failed component=fleet.executor` y su `stderr`, que empieza por `fleet effect failed:`. Cuando el retroceso sale bien, esa línea dice que el contenedor original quedó restaurado y los volúmenes conservados, y nombra la causa ya sin secretos. Si el adaptador estaba en marcha, se vuelve a levantar sobre esa imagen; si estaba parado, sigue parado. Si el propio retroceso falla, el contenedor original se conserva para recuperarlo y la misma línea nombra también ese fallo: el adaptador no está ya en marcha. La fila queda igualmente deshabilitada; el paso siguiente en la consola es otra vez **Arrancar** y confirmar **Iniciar**. Este aviso no es el de **Actualizar CLI** en Mis cuotas: aquel nombra la operación en la propia tarjeta. El detalle operativo está en [Operación](operacion.md#detener-e-iniciar-desde-la-web).

Para darlo de baja, en **Estado** pulsa **Retirar o eliminar…** si tiene o tuvo un entorno de ejecución, o **Ir a eliminar…** si no lo tiene. Si ya está retirado, el botón es **Eliminar definitivamente…**. Si tiene o tuvo un entorno de ejecución, sigue los dos pasos del diálogo:

1. **Retirar** detiene la ejecución y conserva registro, mensajes e historial. Puede revertirse con **Restaurar**.
2. Cuando el retiro termine, pulsa **Releer inventario** y continúa con **Eliminar definitivamente**. Lee la previsualización y confirma lo que se borrará; esta operación es irreversible.

Si no tiene entorno de ejecución, **Ir a eliminar…** abre **Ajustes**: usa **Eliminar registro**, revisa sus dependencias en la previsualización y confirma. Los mensajes enviados se conservan. Un alias con historial o identidad de ejecución puede seguir reservado tras eliminar el agente. Antes de una eliminación definitiva de un espacio, descarga su copia.

## Cambiar el contexto para el siguiente turno

1. Desde la ficha, abre **Perfil y contexto**.
2. Usa **Perfil** para sus campos de perfil y **Ficheros** para el manual y los demás documentos nativos. **Directiva** muestra en solo lectura el rol, el manual y la memoria; el manual se edita con **Editar el manual en Ficheros**. **Git** es el repositorio y **Versiones y aplicación** los archivos versionados de `context/` y `directives/`.
3. En **Versiones y aplicación**, elige o añade un archivo, edita su contenido y pulsa **Guardar nueva versión**.
4. El contexto guardado se adopta en el siguiente turno natural que termina bien. Revisa **Guardado**, **Versión deseada**, **Aplicación** y **Usado por el agente**. **Usado por el agente** muestra el número `applied_version`. Si ese campo viniera vacío, diría «Sin aplicación verificada». Mientras no coincide con **Versión deseada**, el aviso es «El agente aún no acredita la versión » más ese número y «. Guardar una versión no demuestra que ya la esté usando.» **Aplicación** dice «Aplicada» solo cuando los dos números coinciden. La consola no pinta `applied_at`: ese instante se escribe en la base en el mismo paso que sube el número, y solo si el turno acabó en `done` con testigo de adopción y de consumo del mismo `input_sha256`. Un turno que falla no mueve ni el número ni el instante.

**Aplicar al agente** solicita la aplicación mediante un turno dedicado; úsalo si necesitas adelantarla. Si hay conflicto, conserva tu borrador, relee y concilia el contenido antes de volver a guardar. Un borrador del editor no es una versión persistida. Estructura, edición local y límites: [archivos y contextos](v4-archivos-contextos.md).

## Ver el historial de contextos y recuperar una versión

1. Abre **Perfil y contexto → Versiones y aplicación** y baja a **Historial**.
2. Usa **Ver diferencias de versión** para comparar y **Restaurar versión** para recuperar contenido; confirma la restauración. Se crea una versión nueva y se conserva el historial anterior.
3. En el mismo panel, revisa **GitHub** y el commit: **Sincronizado**, **Pendiente** y **Error de sincronización** indican estados diferentes del guardado y la aplicación.
4. Si falla la publicación, el contenido guardado se conserva. Corrige la conexión o pide ayuda al operador y pulsa **Reintentar sincronización**.

Los contextos se publican en un repositorio privado compartido, separados por empresa y agente; se consultan desde Cauce con los permisos de la empresa. La pestaña **Historial** reúne además las revisiones del perfil y las escrituras de ficheros.

## Trabajar desde la oficina, el chat o la terminal

En **Oficina**, abre un agente para consultar su estado, cuenta y cuota, o entrar en **Chat**, **Terminal** y **Perfil y contexto**. Las salas de la empresa salen de sus recursos. El campus añade lugares fijos del plano (**Cafetería**, **Parque**, **Residencia**, **Recepción** y **Taller**): no son salas tuyas. Para editar el plano, pulsa **Plano editable**, guarda con **Guardar plano** y comprueba el resultado al volver a abrirlo. El cansancio representa disponibilidad de cuota; la falta de datos o un error se muestran por separado. **Sin datos** en un agente sin cuenta no es cuota agotada.

Esa disponibilidad se dibuja como barra de vida en la ficha del agente, en la hoja de la oficina, en la tarjeta del campus (no en un visitante) y en el panel del grupo. Mide la ventana que se agota antes: el menor porcentaje restante entre las ventanas leídas bien. Por encima del 50 % va en verde, desde el 20 % en ámbar y por debajo del 20 % en rojo. Si no hay número —sin datos, error, datos antiguos, en pausa, pendiente de autenticación, sin lector, o mientras se lee— la barra es un rayado gris: no se lee como gastada ni como llena. El texto al lado es `5h` o `sem` con el porcentaje, o el estado (**Disponible**, **Cansado**, **Sin disponibilidad** y los demás de Mis cuotas). **Cansado** sigue siendo menos del 25 % de la cuenta; el color de la barra usa los cortes del 50 % y del 20 % de la ventana límite.

En **Chat**, abre la tarjeta del agente aunque diga **Sin preparar**. Escribe en **Mensaje para …** y pulsa Enter. Sin ordenador el envío queda en cola: verás **Lease sin dato · envío en cola** y **recibiendo…**. No es un fallo de la caja.

En la terminal, confirma el agente y el modo permitido antes de escribir. Desde el CLI puedes iniciar tu sesión con `cauce login`, abrir `cauce <tenant>/<alias>` y salir con `Ctrl-]`. Si expira el acceso, usa `cauce login --renew`. En un equipo sin navegador, `cauce login --dispositivo` muestra un código: ábrelo en `/dispositivo`, pulsa **Consultar solicitud** y después **Autorizar** o **Rechazar**. Comandos y permisos: [CLI](v4-cli.md), [terminal](terminal-pty.md).

## Recuperar la TUI tras un Ctrl+C

**Reiniciar agente** cierra o recrea la TUI y reanuda la conversación exacta. No abre una conversación en blanco. No es el botón **Reiniciar este agente y verificar archivos**, que recarga archivos en el panel nativo.

Aparece en la hoja del agente de **Oficina** y en **Terminal** cuando hay un agente elegido. No está en la ficha de **Ajustes → Agentes**. Si falta el permiso de escritura de configuración, el botón no se pinta. El servidor exige sesión fresca de la consola, permiso de operador `control` y rol de dueño, administrador de la empresa o administrador de plataforma. Si no, responde «Solo quien administra la empresa del agente puede reiniciarlo.» El agente tiene que estar habilitado y no retirado.

Al pulsarlo el rótulo pasa a **Comprobando conversación…**. Si hay una conversación reanudable y ninguna entrega en vuelo (`leased`, `accepted` o `started`), el texto dice qué va a pasar. Con la TUI presente: «Se cerrará la TUI actual y se reanudará la conversación exacta. Confirma solo si necesitas recuperarla.» Si falta: «Se recreará la TUI ausente reanudando la conversación exacta.» Confirmas con **Confirmar reinicio y reanudar**. El resultado es **Reanudado** o **Recreado**, y la consola abre la terminal en modo TUI. **Cancelar** cierra el aviso sin tocar nada.

No se confirma si no hay una conversación reanudable verificada: «No hay una conversación reanudable verificada. Reiniciar sin reanudar causaría amnesia; esta acción está bloqueada.» Si hay entregas en vuelo, el aviso es «Hay N entrega en vuelo. El reinicio está bloqueado hasta que terminen.» o el plural «entregas». **Confirmar reinicio y reanudar** queda deshabilitado. Si aun así la petición llega con entregas vivas, el servidor responde 409 y «N entrega(s) en vuelo: reiniciar puede perder el trabajo. Espera a que terminen y vuelve a consultar.» Si la identidad del runtime cambia entre la consulta y la confirmación, hay que volver a comprobar. Esta vía no abre una conversación en blanco ni recrea el contenedor de un V4 con TUI compartida ya activa.

OpenClaw, y un agente sin clave de runtime, usan el canal PTY directo. OpenClaw reabre la TUI con `--session` sobre la conversación durable y deja el adaptador activo. Si no hay una conversación durable segura, no cierra ninguna TUI. Si otra terminal apunta a otra conversación de OpenClaw, hay que cerrarla y volver a consultar. Si el ejecutor aún no publica esta recuperación, OpenClaw dice que hay que volver a abrir la terminal para reanudar la sesión guardada y que no se reinició el adaptador. El resto de runtimes, en ese mismo caso, dice que no publican recuperación de TUI.

Un V4 que no es OpenClaw y ya tiene clave de runtime pasa por una operación de flota de recuperación. Esa vía admite claude, codex, grok y muse. Con el adaptador vigente y la TUI compartida activa, no recrea el contenedor ni sustituye el adaptador. Si el adaptador corre otra release u otra imagen, o está caído por un Ctrl+C, la consulta dice «El adaptador corre con una versión anterior…» o «El adaptador está detenido…»: la operación lo detiene como **Detener** y lo arranca como **Arrancar** con la versión vigente (recrea el contenedor si cambió la release), solo después de comprobar que esa versión reanuda la misma conversación. Si no puede acreditarlo, no modifica el agente. Un intento sin recibo no se repite solo: pide una vista previa nueva. Un agente detenido con **Detener** no se recupera con **Reiniciar agente**: se arranca con **Arrancar**. Si la reanudación se acredita, la tarjeta de la operación dice «Reanudó la misma conversación y conservó el contenedor y el adaptador.» Si la TUI compartida no está activa, la consulta no detiene ni modifica el runtime y el motivo es «Este adaptador necesita activar su TUI compartida antes de recuperarla; no se detuvo ni modificó el runtime.» Solo acepta el proceso cuyo alias visible y cuya clave física coinciden con la TUI acreditada; no toma el de otro alias. Esto describe lo que hace el botón. No acredita una aceptación en producción de cada arnés.

Un agente V3 que todavía entra por el canal PTY directo reanuda esa misma conversación y no usa el paro y el arranque de flota. Si no publica la recuperación, el botón queda en el aviso de runtime sin soporte y no reinicia el adaptador.

## Descargar y recuperar una copia del espacio

En **Perfil y contexto** está **Backup del espacio**. Pulsa **Crear backup del espacio** y espera a que esté lista antes de descargar. **Actualizar estado del backup** relee el recibo; **Actualizar copias** relee la lista. Con la copia lista, **Descargar backup ZIP** guarda el archivo y comprueba su SHA-256. **Eliminar copia** pide confirmación (**Eliminar copia definitivamente** o **Conservar copia**) y borra esa copia almacenada, no el espacio del agente. Revisa el tamaño, SHA-256 y las omisiones de `space-manifest.json`: las credenciales, sesiones, logs y temporales no viajan; los proyectos se copian sin `.git`.

La restauración se hace con `cauce spaces restore` en un directorio nuevo o vacío, validando la identidad del agente. Luego se reautentican sus proveedores. Sigue los comandos del [runbook de copias](v4-runbook-copias.md).

## Retirar o purgar una empresa

En **Ajustes → General → Empresas**, **Retirar** conserva los datos y revoca su operación. Lee el aviso y escribe el identificador para confirmar. Retirar tu empresa de origen revoca tu propio acceso.

Solo el **administrador de plataforma** puede usar **Purgar definitivamente**, y solo sobre una empresa ya retirada. Debe escribir su identificador y pulsar **Confirmar purga definitiva**. Revisa las dependencias que muestre el servidor; una purga bloqueada no se completa. Si se confirma, sus datos se borran de forma irreversible.

## Resolver un fallo o publicar una actualización

Si una acción falla, conserva su identificador y el paso afectado. **Señales y auditoría**, el historial de operaciones y `cauce diagnose <id>` permiten seguir la causa. Ante una sesión vencida, vuelve a entrar; ante un conflicto de revisión, relee antes de reintentar. Durante un despliegue, si el servidor no responde unos segundos, verás «Reconectando con el servidor…»: las lecturas se reintentan solas y no tienes que recargar; una escritura que cayó en ese momento no se repite sola y el aviso te ofrece **Reintentar** cuando quieras ejecutarla, o **Descartar**. Si el fallo es de login de un agente, la tabla de códigos y el orden de consulta están en [diagnóstico de login](v4-autenticacion-runtime.md#diagnóstico-de-login-de-agente-para-operadores). Si el adaptador pierde el arriendo y el socket cierra con `consumer_placement_mismatch`, el significado está en [identidad rechazada del arriendo](operacion.md#identidad-rechazada-del-arriendo).

El operador publica un candidato con el gate de tres pasos y el procedimiento **`corte.sh` → `deploy1-local.sh` → `deploy1-vps.sh`**, seguido de smoke y recorrido funcional. Requisitos, copias, actualización del controlador y reversión: [Desplegar V4](operacion.md#desplegar-v4).
