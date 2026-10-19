# Guía de uso y administración de Cauce V4

Abre la consola de tu instalación e inicia sesión. Cada acción se limita a la empresa activa y a los permisos de tu cuenta. La versión publicada se consulta en [HISTORIAL](../deploy/HISTORIAL.md); los procedimientos del operador están en [Operación](operacion.md).

## Registrarte y entrar en tu empresa

1. En la pantalla de acceso, pulsa **Crear cuenta y empresa**. Completa tu nombre, correo, contraseña (12 caracteres o más), el nombre de la empresa y un identificador libre: empieza por una letra y usa minúsculas, números o guiones.
2. Al terminar se crean la empresa y tu acceso como dueño, y entras en el **Chat**.
3. El chat ya lista dos agentes en borrador, sin ordenador: `owner` (con tu nombre, en la sala `office`) y `context-director`. El aviso «Sin preparar» no es una caída. El espacio de la empresa tiene un identificador que empieza por `hub-`. Para conectar un ordenador y añadir agentes, abre **Ajustes**.

Si administras la plataforma, el selector de empresa permite cambiar la empresa activa. Compruébala antes de crear o borrar recursos. Los demás usuarios trabajan dentro de su empresa y de los espacios autorizados.

## Invitar a una persona a tu empresa

1. Abre **Ajustes → Acceso y roles → Personas → Administrar personas**. Si la tarjeta muestra **Invitar persona**, ese botón abre el mismo formulario.
2. Pulsa **Crear persona** o **Invitar persona**, el que veas. Completa correo de acceso, nombre y permiso web: **Lector** u **Operador**.
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

Las ventanas, porcentajes disponibles y reinicios vienen del CLI del proveedor; cada proveedor puede informar ventanas distintas. Revisa la hora de lectura. **Sin datos**, **datos antiguos** y **error** son estados distintos de cuota agotada. Si la sesión vence, vuelve a **Iniciar sesión** y repite la consulta.

El saldo se consulta en **Mis cuotas**. **Cuentas** mantiene **Inventario** y **Asignaciones**, para administrar pagadores y ruteo; la antigua pestaña **Consumo** está retirada. Para mantener el CLI o retirar su contenedor, usa **Actualizar CLI** o **Eliminar entorno**. Si **Actualizar CLI** falla, el aviso nombra la operación y su causa; vuelve a intentarlo y, si se repite, el diario del ejecutor en ese ordenador trae el motivo. Eliminar una cuenta exige retirar antes sus entornos y asignaciones. Capacidades y límites: [cuotas](v4-cuotas.md).

## Compartir una cuenta entre agentes

En la ficha del agente, abre **Registro → Cuentas de cuota**, elige la cuenta, pulsa **Previsualizar cuenta** y después **Guardar cuenta de cuota**. Puedes vincular la misma cuenta a varios agentes: comparten la suscripción y el saldo. La ficha y la oficina muestran sus datos; **Mis cuotas** permite seguirla incluso sin agentes. Una cuenta sin sesión verificada requiere primero **Iniciar sesión** en su tarjeta. Para cambiar la cuenta de ejecución, usa **Operar agente** y comprueba su autenticación.

## Crear y preparar un agente

1. Abre **Ajustes → Agentes → Añadir agente** y elige **Registrar el agente**.
2. Completa espacio de trabajo, alias y nombre visible; avanza por computadora y grupo inicial. Puedes registrarlo sin computadora y asignarla después desde **Editar registro**.
3. En la revisión, pulsa **Previsualizar alta** y después **Crear registro**. El registro se crea deshabilitado; aún falta preparar su ejecución.
4. Con una computadora asignada, pulsa **Preparar en la computadora**, revisa el plan y encola la operación. También puedes abrir la ficha, ir a **Operación** y elegir **Preparar agente**. Completa la autenticación del proveedor cuando se solicite.

El asistente también ofrece **Solo preparar, sin desplegar**. Una operación en cola o en ejecución todavía no está completada: revisa sus pasos y el estado final antes de iniciar el trabajo. Operación y CLI: [gestión de espacios](v4-cli.md).

Si el agente estaba pausado y su grupo principal quedó deshabilitado, al reprepararlo la propia ficha marca ese grupo para que lo habilites: el aviso «Para activar el agente su grupo principal debe quedar habilitado» señala la casilla **Habilitar membresía** que hay que marcar, y los rechazos conocidos de la preparación se muestran ya traducidos con la acción siguiente en lugar del mensaje crudo del servidor.

Si tras un despliegue la operación muestra **Requiere preparación**, el contenedor quedó con una imagen anterior y esa operación ya no se puede reanudar. Pulsa **Recrear contenedor e iniciar sesión** en la propia operación: la consola cancela la operación desfasada, comprueba la preparación, encola la recreación, sigue sus pasos y abre el inicio de sesión en un solo camino, conservando volúmenes, sesión y ampliaciones. Si un paso falla, el camino se detiene en ese paso y **Reintentar** lo retoma desde ahí con la misma solicitud; cancelar el camino guiado solo cancela la operación desfasada, sin recrear nada.

## Crear una sala

1. Abre **Ajustes → Espacios y salas** y, en la tabla **Salas**, pulsa **Crear sala/grupo**.
2. El espacio es el identificador `hub-…` de tu empresa. El de la sala lo eliges tú: minúsculas, números o guiones.
3. Pulsa **Previsualizar cambio** y después **Confirmar creación**.
4. Arriba, **Un solo recurso** crea lo mismo con otros nombres: en **Recurso** elige **Room**, en **Tenant** escribe el `hub-…` y en **Room** el identificador de la sala. **Membership** solo añade una pertenencia y no crea el agente.
5. Para quitarla, en la misma tabla pulsa **Eliminar**, luego **Previsualizar cambio** y **Confirmar eliminación**. El aviso nombra la sala borrada. **Retirar** es una operación distinta.

## Editar, detener o eliminar un agente

Abre su ficha desde **Ajustes → Agentes**. **Registro** edita sus datos; **Operación** prepara, actualiza, inicia o detiene su ejecución y muestra el resultado remoto.

Para darlo de baja, pulsa **Eliminar**. Si tiene o tuvo un entorno de ejecución, sigue los dos pasos del diálogo:

1. **Retirar** detiene la ejecución y conserva registro, mensajes e historial. Puede revertirse con **Restaurar**.
2. Cuando el retiro termine, pulsa **Releer inventario** y continúa con **Eliminar definitivamente**. Lee la previsualización y confirma lo que se borrará; esta operación es irreversible.

Si no tiene entorno de ejecución, la acción abre **Registro**: usa **Eliminar registro**, revisa sus dependencias en la previsualización y confirma. Los mensajes enviados se conservan. Un alias con historial o identidad de ejecución puede seguir reservado tras eliminar el agente. Antes de una eliminación definitiva de un espacio, descarga su copia.

## Cambiar el contexto para el siguiente turno

1. Desde la ficha, abre **Perfil y contexto**.
2. Usa **Perfil** para sus campos de perfil, **Ficheros** para documentos nativos o **Versiones y aplicación** para archivos versionados de `context/` y `directives/`.
3. En **Versiones y aplicación**, elige o añade un archivo, edita su contenido y pulsa **Guardar nueva versión**.
4. El contexto guardado se adopta en el siguiente turno natural. Revisa **Guardado**, **Versión deseada**, **Aplicación** y **Usado por el agente**: guardar no acredita que una conversación ya lo esté usando.

**Aplicar al agente** solicita la aplicación mediante un turno dedicado; úsalo si necesitas adelantarla. Si hay conflicto, conserva tu borrador, relee y concilia el contenido antes de volver a guardar. Un borrador del editor no es una versión persistida. Estructura, edición local y límites: [archivos y contextos](v4-archivos-contextos.md).

## Ver el historial de contextos y recuperar una versión

1. Abre **Perfil y contexto → Versiones y aplicación** y baja a **Historial**.
2. Usa **Ver diferencias de versión** para comparar y **Restaurar versión** para recuperar contenido; confirma la restauración. Se crea una versión nueva y se conserva el historial anterior.
3. En el mismo panel, revisa **GitHub** y el commit: **Sincronizado**, **Pendiente** y **Error de sincronización** indican estados diferentes del guardado y la aplicación.
4. Si falla la publicación, el contenido guardado se conserva. Corrige la conexión o pide ayuda al operador y pulsa **Reintentar sincronización**.

Los contextos se publican en un repositorio privado compartido, separados por empresa y agente; se consultan desde Cauce con los permisos de la empresa. La pestaña **Historial** reúne además las revisiones del perfil y las escrituras de ficheros.

## Trabajar desde la oficina, el chat o la terminal

En **Oficina**, abre un agente para consultar su estado, cuenta y cuota, o entrar en **Chat**, **Terminal** y **Perfil y contexto**. Las salas de la empresa salen de sus recursos. El campus añade lugares fijos del plano (cafetería, parque, residencia, recepción y taller): no son salas tuyas. Para editar el plano, pulsa **Plano editable**, guarda con **Guardar plano** y comprueba el resultado al volver a abrirlo. El cansancio representa disponibilidad de cuota; la falta de datos o un error se muestran por separado. **Sin datos** en un agente sin cuenta no es cuota agotada.

En **Chat**, abre la tarjeta del agente aunque diga **Sin preparar**. Escribe en **Mensaje para …** y pulsa Enter. Sin ordenador el envío queda en cola: verás **Lease sin dato · envío en cola** y **recibiendo…**. No es un fallo de la caja.

En la terminal, confirma el agente y el modo permitido antes de escribir. Desde el CLI puedes iniciar tu sesión con `cauce login`, abrir `cauce <tenant>/<alias>` y salir con `Ctrl-]`. Si expira el acceso, usa `cauce login --renew`. Comandos y permisos: [CLI](v4-cli.md), [terminal](terminal-pty.md).

## Descargar y recuperar una copia del espacio

En **Perfil y contexto** está **Backup del espacio**. Pulsa **Crear backup del espacio** y espera a que esté lista antes de descargar. Revisa el tamaño, SHA-256 y las omisiones de `space-manifest.json`: las credenciales, sesiones, logs y temporales no viajan; los proyectos se copian sin `.git`.

La restauración se hace con `cauce spaces restore` en un directorio nuevo o vacío, validando la identidad del agente. Luego se reautentican sus proveedores. Sigue los comandos del [runbook de copias](v4-runbook-copias.md).

## Retirar o purgar una empresa

En **Ajustes → General → Empresas**, **Retirar** conserva los datos y revoca su operación. Lee el aviso y escribe el identificador para confirmar. Retirar tu empresa de origen revoca tu propio acceso.

Solo el **administrador de plataforma** puede usar **Purgar definitivamente**, y solo sobre una empresa ya retirada. Debe escribir su identificador y pulsar **Confirmar purga definitiva**. Revisa las dependencias que muestre el servidor; una purga bloqueada no se completa. Si se confirma, sus datos se borran de forma irreversible.

## Resolver un fallo o publicar una actualización

Si una acción falla, conserva su identificador y el paso afectado. **Señales y auditoría**, el historial de operaciones y `cauce diagnose <id>` permiten seguir la causa. Ante una sesión vencida, vuelve a entrar; ante un conflicto de revisión, relee antes de reintentar. Durante un despliegue, si el servidor no responde unos segundos, verás «Reconectando con el servidor…»: las lecturas se reintentan solas y no tienes que recargar; una escritura que cayó en ese momento no se repite sola y el aviso te ofrece **Reintentar** cuando quieras ejecutarla, o **Descartar**. Si el fallo es de login de un agente, la tabla de códigos y el orden de consulta están en [diagnóstico de login](v4-autenticacion-runtime.md#diagnóstico-de-login-de-agente-para-operadores).

El operador publica un candidato con el gate de tres pasos y el procedimiento **`corte.sh` → `deploy1-local.sh` → `deploy1-vps.sh`**, seguido de smoke y recorrido funcional. Requisitos, copias, actualización del controlador y reversión: [Desplegar V4](operacion.md#desplegar-v4).
