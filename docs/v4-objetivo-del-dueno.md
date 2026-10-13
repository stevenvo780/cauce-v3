# Completar Cauce V4

Completa Cauce V4 como un sistema totalmente funcional, multiempresa y multitenant. No quiero maquetas, funcionalidades únicamente documentadas ni pantallas desconectadas de las operaciones reales. Todo lo que se pueda hacer desde la interfaz debe ejecutar la acción correspondiente, reflejar su estado real y estar correctamente probado.

Aprovecha los mecanismos que ya funcionan, especialmente las terminales remotas, la comunicación entre agentes, el CLI de Cauce y la lectura de cuotas mediante los CLI de los proveedores. Revisa la implementación existente antes de añadir componentes nuevos: la prioridad es integrar, simplificar y completar el sistema, no duplicarlo.

**La tarea incluye implementar, migrar, desplegar y verificar. No termina al escribir el código ni al entregar un plan.** Utiliza el entorno local disponible, los servidores autorizados y la máxima paralelización viable mediante subagentes.

## 1. Multiempresa, registro y aislamiento

Todo el sistema debe ser multitenant. Las empresas **Humanizar** y **Praxis** deben quedar completamente funcionales, con sus respectivos usuarios, agentes, ordenadores, salas, clientes, credenciales y configuraciones.

Además, cualquier persona debe poder registrarse, crear su propia empresa y registrar sus ordenadores para utilizar Cauce sin depender de una configuración manual por parte del administrador del sistema.

El aislamiento entre empresas debe aplicarse tanto en la interfaz como en el backend, las comunicaciones y las operaciones remotas. Ninguna empresa debe poder consultar o modificar los recursos de otra mediante rutas, identificadores, terminales, archivos, eventos o acciones del CLI.

Revisa el sistema de membresías. Si cumple una función real en la pertenencia de usuarios a empresas, los permisos o la colaboración, consérvalo y simplifícalo. Si contiene conceptos o componentes redundantes que no aportan utilidad, elimínalos. No elimines los controles necesarios para el aislamiento multitenant y la gestión de permisos.

## 2. Credenciales y cuotas por agente

Implementa un espacio para administrar las credenciales y cuentas utilizadas por los proveedores, con el aislamiento y los permisos correspondientes. Las credenciales sensibles no deben exponerse en la interfaz, los registros de errores, GitHub ni la documentación.

Cada agente ya tiene asociado un tipo de *harness*. Utiliza esa información para identificar cómo consultar sus cuotas, reutilizando las terminales remotas y el mecanismo de lectura mediante CLI que ya existe.

El sistema debe consultar las cuotas en el ordenador o entorno donde se ejecuta el agente y mostrarlas en la web. Debe presentar el saldo o porcentaje disponible, las ventanas de consumo y sus reinicios cuando esa información esté disponible.

No impongas las mismas ventanas a todos los proveedores. Muestra la ventana de cinco horas, la semanal o cualquier otra únicamente cuando el proveedor y la cuenta realmente las tengan. Para GPT y los demás proveedores, utiliza lo que reporte el mecanismo de consulta correspondiente, sin asumir ventanas inexistentes.

**Varios agentes pueden compartir una misma cuenta y, por tanto, las mismas cuotas. Esto es válido y no debe tratarse como un error.** Corrige la lógica actual que interpreta esa situación como una duplicidad incorrecta. Cada agente debe poder mostrar la cuota de su cuenta asociada, aunque esa misma información aparezca en otros agentes. Cuando corresponda, indica que el consumo es compartido, sin presentarlo como si cada agente tuviera un saldo independiente.

La información debe incluir su estado y momento de actualización. Si una consulta falla o el proveedor no ofrece determinado dato, muestra esa situación con claridad; no inventes valores ni presentes información antigua como si estuviera actualizada.

## 3. Espacio «Mis cuotas»

Crea una sección llamada **«Mis cuotas»** para registrar y consultar cuentas de proveedores sin necesidad de vincularlas a un agente.

Desde esta sección, el usuario debe poder elegir un proveedor e instanciar un entorno Docker aislado con el CLI correspondiente. Ese entorno debe ofrecer una terminal restringida a las operaciones necesarias para autenticar la cuenta, consultar sus cuotas y mantener el CLI. No debe convertirse en una terminal general con acceso arbitrario al servidor.

Debe ser posible actualizar el CLI y administrar el ciclo de vida del entorno desde la interfaz, incluyendo su creación, consulta, edición de configuración y eliminación.

La sección debe incluir una vista gráfica cuidada que permita fijar las cuentas o tarjetas de cuotas que el usuario quiera seguir. Esta vista debe distinguirse de las cuotas por agente, aunque ambas puedan mostrar información de una misma cuenta.

El resultado debe permitirme trasladar a la web el uso cotidiano del CLI de cuotas: quiero consultar mis cuotas actuales desde Cauce sin tener que abrir manualmente una terminal.

## 4. Oficina interactiva y configurable

La oficina debe reflejar los recursos reales de cada empresa. Las salas deben aparecer, desaparecer o actualizarse cuando se creen, eliminen o editen. Lo mismo debe ocurrir con los agentes y sus asignaciones.

Desde la oficina debe ser posible entrar al detalle de un agente y consultar su información, su estado, sus contextos y las cuotas disponibles de la cuenta que utiliza.

Añade una representación gráfica de **«cansancio»** que refleje el estado real de sus cuotas. Debe permitir distinguir visualmente entre un agente con suficiente disponibilidad, uno próximo a agotar su cuota y uno sin disponibilidad. La ausencia de datos o un error de consulta deben mostrarse como estados diferentes, no confundirse con agotamiento.

El mapa, las salas y sus partes deben ser editables según la estructura de cada empresa. La oficina no puede depender de una distribución fija ni de agentes definidos de forma estática en el código.

Los cambios deben persistir y reflejarse correctamente después de recargar la página, volver a iniciar sesión o acceder desde otro navegador autorizado.

## 5. Migración de agentes a servidores locales

Mueve a **Gaia, Hegel, Hades y Argos** a servidores de mi red local para liberar recursos en la VPS principal y comprobar que la operación distribuida entre varios ordenadores funciona correctamente.

La VPS principal es:

```bash
ssh <usuario>@<host-prod>
```

**Kant conoce la infraestructura local. Utiliza Cauce para preguntarle por los servidores, sus accesos, su disponibilidad y cualquier requisito relevante para la migración.** También están registrados los accesos SSH de los servidores 1, 2 y 3. Identifica cuáles pertenecen realmente a mi red local: los destinos de esta migración deben ser servidores locales, no otras VPS.

Antes de decidir dónde ubicar cada agente, comprueba la RAM, el almacenamiento y los recursos disponibles. Distribúyelos de acuerdo con la capacidad real de cada ordenador.

Migra toda la información necesaria para conservar su funcionamiento e identidad: configuración, contextos, datos persistentes, espacios de trabajo y demás archivos relevantes. Verifica también las credenciales, los permisos y las conexiones que necesiten en el destino.

Coordina la migración con la reorganización de archivos y el versionado de contextos descritos más adelante. No traslades el desorden actual sin revisarlo ni pierdas información durante la normalización.

No elimines los datos ni los contenedores de origen hasta comprobar que los agentes funcionan correctamente en sus nuevos servidores y que existe una copia recuperable. Una vez validada la migración, libera los recursos que hayan quedado sin uso en la VPS principal.

Comprueba que, después del traslado, siguen funcionando la comunicación mediante Cauce, las terminales remotas, la consulta de cuotas, el versionado de contextos y las operaciones desde la interfaz.

Registra la ubicación final de cada agente y compara el consumo de recursos de la VPS antes y después de la migración.

## 6. Gestión de recursos, Docker y CLI de Cauce

Todas las entidades administrables deben tener operaciones completas de creación, consulta, edición y eliminación desde la interfaz. Esto incluye empresas, clientes, salas, ordenadores, agentes y los demás recursos pertinentes, respetando sus permisos y dependencias.

Cada agente debe poder crearse, editarse y eliminarse desde la web, incluyendo sus contextos, configuración, componentes y asignaciones. No basta con modificar un registro en la base de datos: la acción debe aplicarse al entorno real donde se ejecuta.

Las operaciones de infraestructura deben aprovechar el acceso remoto al ordenador correspondiente y el CLI instalado allí. Crear un agente debe poder instanciar su entorno Docker con lo necesario; eliminarlo debe gestionar correctamente sus procesos, contenedores y datos, según la opción elegida y las medidas de protección aplicables.

Simplifica el despliegue mediante Docker. La lógica debe ser la de un orquestador de espacios: elegir un ordenador, instanciar un entorno para un agente, administrarlo y eliminarlo cuando corresponda.

El CLI `cauce`, que ya permite abrir terminales de agentes, debe conservar todas sus capacidades actuales. Además, debe facilitar la creación y administración de espacios de Cauce en los que se puedan ejecutar agentes, evitando configuraciones manuales innecesarias.

Incluye la posibilidad de descargar el contenido persistente de los espacios para realizar copias de seguridad. Documenta cómo recuperarlo y comprueba que las copias contienen lo necesario, sin incluir información de otros agentes o empresas por accidente.

La interfaz debe mostrar los estados reales de estas operaciones: pendiente, en ejecución, completada o fallida. No debe informar que una acción terminó correctamente cuando la operación remota no se ha completado.

Gestiona correctamente los reintentos y las operaciones interrumpidas para evitar contenedores duplicados, recursos huérfanos o registros que no correspondan con la infraestructura real.

## 7. Sistema extensible de harnesses

Revisa y mejora el sistema de harnesses para que incorporar uno nuevo sea una operación clara y mantenible, no una modificación dispersa por todo el código.

Utiliza configuraciones JSON o YAML cuando resulte adecuado. Estas deben permitir definir los aspectos necesarios para instalar, configurar, autenticar, ejecutar, actualizar y consultar las cuotas de cada harness, según sus capacidades.

La extensibilidad debe ser real: las configuraciones deben ser interpretadas por el sistema y producir operaciones funcionales. No quiero un catálogo de proveedores que solo exista en la interfaz o en la documentación.

Valida las configuraciones y muestra errores comprensibles cuando falten campos, existan incompatibilidades o una operación no esté soportada. Las capacidades disponibles en la interfaz deben corresponder a lo que cada integración puede ejecutar realmente.

Documenta y prueba el procedimiento para incorporar un harness mediante este mecanismo, incluyendo la validación de su configuración y la ejecución de sus operaciones soportadas.

## 8. Reorganización de archivos y versionado de contextos con GitHub

### Estructura de archivos de cada espacio

Revisa el sistema de archivos actual de los espacios de Cauce y reorganízalo. Actualmente existe demasiado desorden: quiero una estructura estándar, comprensible y consistente entre agentes y ordenadores.

Separa claramente los contextos y directivas, los proyectos y archivos de trabajo, la configuración no sensible, los datos persistentes, los registros y los archivos temporales. Mantén las credenciales y los secretos fuera de los archivos versionables.

Define y documenta qué contiene cada directorio, qué componentes lo utilizan, qué información debe persistir y qué archivos pueden regenerarse o eliminarse.

La estructura debe ser utilizada realmente por el backend, el CLI, los contenedores, la interfaz y los mecanismos de copia de seguridad. No basta con crear carpetas nuevas si los componentes siguen escribiendo en ubicaciones antiguas o arbitrarias.

Antes de mover o eliminar archivos existentes, identifica su función y sus dependencias. Realiza una migración verificable, actualiza las rutas y los volúmenes necesarios y comprueba que ningún agente pierde sus contextos, proyectos o capacidad de ejecución. No borres archivos solo porque su propósito no sea evidente.

### Repositorio compartido de contextos

Implementa una integración real de **Git con GitHub para los contextos y directivas de cada agente**.

Utiliza un mismo repositorio privado compartido, con una carpeta independiente e identificable por agente. No crees un repositorio distinto para cada agente. Organiza las carpetas de manera que también quede clara su pertenencia a una empresa; por ejemplo:

```text
tenants/<tenant_id>/agents/<agent_id>/context/
```

La centralización en un repositorio no debe romper el aislamiento multitenant. Gestiona el acceso mediante Cauce y no entregues a usuarios o agentes credenciales globales ni copias completas del repositorio que les permitan consultar contextos de otras empresas sin autorización.

Utiliza identificadores estables para que cambiar el nombre de un agente, trasladarlo a otro ordenador o modificar su sala no rompa la asociación con su historial.

### Historial y sincronización

**Cada cambio persistido en los contextos o directivas debe quedar registrado temporalmente**, incluyendo el contenido modificado, la fecha, el agente y la autoría u origen de la modificación cuando se conozcan.

Integra el versionado con la edición desde la interfaz y con los demás mecanismos admitidos para modificar contextos, incluidos el CLI y los cambios realizados en los espacios de los agentes. No dejes fuera del historial una vía de modificación que el sistema permita utilizar.

Distingue entre guardar un cambio localmente, registrarlo en Git y sincronizarlo con GitHub. Si falla la sincronización, conserva el cambio, muestra que está pendiente y permite recuperarla sin perder información. No muestres «sincronizado» cuando el envío haya fallado.

Resuelve las escrituras concurrentes de varios agentes sobre el repositorio compartido. Los cambios de un agente no deben sobrescribir los de otro, y los conflictos no deben resolverse silenciosamente descartando contenido.

Desde la interfaz de cada agente debe ser posible consultar el historial, ver las diferencias entre versiones y restaurar una versión anterior. La restauración debe generar un nuevo registro, conservando la trazabilidad de lo ocurrido en lugar de borrar el historial.

Mantén sincronizados el contexto que se muestra en la web, el que está registrado en Git y el que utiliza realmente el agente. Define y prueba cómo se aplica una modificación al agente en ejecución; no permitas que la interfaz indique una directiva nueva mientras el agente sigue usando otra sin advertirlo.

No subas secretos, tokens, sesiones de autenticación, registros indiscriminados ni archivos temporales a GitHub. El versionado de contextos debe complementar las copias de seguridad del espacio, no sustituirlas.

## 9. Auditoría, diagnóstico y eliminación de código innecesario

Revisa los sistemas actuales de auditoría y diagnóstico a partir del uso real que ha tenido Cauce. Hay componentes que parecen añadir complejidad sin aportar utilidad suficiente.

Identifica qué mecanismos se utilizan, cuáles han ayudado a detectar problemas y cuáles están incompletos, duplicados o sin uso. Elimina lo que no aporte valor después de comprobar sus dependencias y conserva o mejora lo que sí resulte útil.

El objetivo es contar con un sistema de diagnóstico más pequeño y efectivo, capaz de seguir errores, fallos de ejecución y rupturas en las cadenas de comunicación entre agentes, servidores, terminales, CLI y backend.

Los registros deben permitir relacionar una operación con la empresa, el agente, el ordenador y el componente involucrados, sin exponer secretos. Debe ser posible reconstruir dónde se inició una acción, por qué componentes pasó y en qué punto falló.

Incluye las operaciones de infraestructura y la sincronización de contextos cuando sean relevantes para diagnosticar un problema.

No añadas nuevas capas de auditoría únicamente para aparentar cobertura. Prioriza información que permita investigar y resolver problemas reales.

## 10. UI/UX, pruebas y documentación

Todas las vistas deben quedar completas, coherentes y cuidadas. Los formularios deben validar sus entradas; las acciones deben ofrecer retroalimentación clara; y los estados vacíos, de carga y de error deben estar resueltos.

Prueba los flujos completos de creación, edición, consulta y eliminación. Verifica tanto el cambio en la interfaz y la base de datos como sus efectos sobre los contenedores, archivos, procesos y recursos remotos.

Incluye pruebas unitarias, de integración y de extremo a extremo donde correspondan. Las pruebas con mocks pueden complementar la validación, pero no sustituyen las comprobaciones reales de SSH, Docker, terminales, proveedores, GitHub y comunicación entre agentes.

Comprueba el aislamiento entre empresas, el registro de nuevos usuarios y empresas, la incorporación de ordenadores, las cuotas compartidas y la operación distribuida después de las migraciones. Prueba también los cambios de contexto, su historial, la sincronización y la restauración de versiones.

Verifica el comportamiento ante fallos de SSH, desconexiones, errores del CLI, interrupciones de operaciones, reinicios y conflictos de sincronización.

Utiliza recursos de prueba identificables para validar operaciones destructivas. No borres ni alteres irreversiblemente datos reales de Humanizar, Praxis o sus agentes para demostrar que un proceso de eliminación funciona. Limpia los recursos temporales al terminar.

La documentación debe cubrir todas las funciones implementadas: uso desde la interfaz, administración, CLI, arquitectura multitenant, registro de ordenadores, gestión de agentes, harnesses, credenciales, cuotas, oficina, estructura de archivos, integración con GitHub, migraciones, copias de seguridad, restauración, despliegue y diagnóstico.

Documenta el comportamiento real de la versión entregada, no funcionalidades previstas que todavía no existen.

## 11. Ejecución, despliegue y máxima paralelización

**Utiliza la máxima paralelización efectiva que permita el entorno mediante subagentes.** Divide el trabajo en frentes independientes, como multitenancy, infraestructura y migraciones, cuotas y harnesses, contextos y GitHub, interfaz y oficina, pruebas y documentación.

Coordina a los subagentes para evitar modificaciones incompatibles sobre los mismos archivos. Utiliza ramas o espacios de trabajo separados cuando corresponda, integra los resultados de forma controlada y vuelve a probar el conjunto después de cada integración relevante.

Mantén revisión independiente de los cambios importantes. La validación no debe depender exclusivamente de que el mismo agente que implementó una función afirme que funciona. Aprovecha los subagentes también para revisar seguridad, regresiones, casos límite y experiencia de usuario.

La paralelización debe acelerar la entrega sin saturar los servidores, agotar los recursos necesarios para los agentes operativos ni comprometer la integridad de los datos.

**Dispones de un entorno local: úsalo realmente para desarrollar, reproducir problemas, integrar cambios y ejecutar pruebas. Después despliega y prueba también en el entorno desplegado.**

No te detengas en «está listo para desplegar» ni evites desplegar por una cautela genérica. El despliegue forma parte de esta tarea y está autorizado dentro de los entornos de Cauce y los accesos disponibles, respetando su configuración de acceso y privacidad.

Trabaja mediante ciclos completos:

**Implementar → probar en local → desplegar → probar lo desplegado → corregir → volver a desplegar y verificar.**

Antes de cambios de infraestructura, migraciones o despliegues que puedan afectar datos, prepara las copias de seguridad y el procedimiento de reversión correspondientes. Actúa con decisión, pero no sustituyas la verificación por cambios destructivos a ciegas.

No solicites confirmación para cada paso rutinario ya incluido en esta tarea. Resuelve las decisiones técnicas con la información disponible. Si falta un acceso imprescindible o aparece un bloqueo real, documenta exactamente qué impide avanzar y continúa con los frentes independientes que sí puedas completar.

## 12. Criterios obligatorios para dar por terminada la tarea

**La V4 solo puede considerarse terminada cuando se cumplan y verifiquen los siguientes criterios:**

1. **Multiempresa operativa y aislada.** Humanizar y Praxis funcionan con sus recursos reales. Un usuario nuevo puede registrarse, crear su empresa y utilizarla. Las pruebas confirman que no puede acceder a datos ni ejecutar operaciones de otra empresa, tampoco manipulando solicitudes fuera de la interfaz.

2. **CRUD completo y real.** Se han probado creación, consulta, edición y eliminación de todas las entidades administrables, tanto desde la interfaz como en sus efectos persistentes y remotos. No quedan botones ficticios, operaciones incompletas ni recursos huérfanos tras las pruebas.

3. **Gestión distribuida funcional.** Se pueden registrar ordenadores e instanciar, administrar y eliminar espacios y agentes en ellos. Gaia, Hegel, Hades y Argos funcionan en servidores locales, conservan su información y se ha comprobado la liberación de recursos en la VPS principal. El CLI `cauce` y las terminales remotas mantienen sus capacidades.

4. **Cuotas reales desde la web.** Funcionan las cuotas por agente y la sección «Mis cuotas», incluyendo autenticación, consulta, actualización de CLI y administración de sus entornos. Se ha probado que varios agentes pueden compartir una cuenta sin errores ni saldos ficticiamente independientes. Las ventanas y los estados mostrados corresponden a los datos reales disponibles.

5. **Oficina y harnesses operativos.** La oficina responde a la creación, edición, asignación y eliminación de salas y agentes; su configuración persiste; y el detalle de cada agente muestra correctamente sus cuotas y estado visual. El mecanismo de configuración de harnesses se ha probado con operaciones reales y no depende de cambios dispersos para cada integración.

6. **Archivos ordenados y contextos versionados.** Los espacios utilizan la estructura estándar sin pérdida de datos ni rutas rotas. El repositorio compartido de GitHub contiene las carpetas de los agentes y registra sus cambios. Se han probado la edición desde las vías soportadas, el historial, las diferencias, la restauración, la aplicación efectiva al agente, las escrituras concurrentes y la recuperación después de un fallo de sincronización, sin exponer secretos ni contextos entre empresas.

7. **Copias, recuperación y diagnóstico comprobados.** Se puede descargar una copia del contenido de un espacio y restaurarla en un entorno de prueba. Los fallos relevantes dejan un rastro útil para encontrar su causa. La eliminación de componentes de auditoría innecesarios no ha roto funciones ni suprimido controles necesarios.

8. **Pruebas reales en local y en el despliegue.** Se han ejecutado las pruebas correspondientes sobre la versión final integrada y se han recorrido los flujos esenciales en el entorno desplegado. No basta con que compile, pase el linter, funcionen los mocks o responda un endpoint de salud. Los errores encontrados se corrigen y los flujos afectados se vuelven a probar.

9. **Despliegue final y documentación completos.** Los cambios están integrados y desplegados; la versión publicada corresponde al código verificado; la documentación describe todas las funciones reales y los procedimientos de operación y recuperación; y no quedan pendientes críticos ocultos detrás de un «se hará después».

Al finalizar, entrega un informe verificable con la versión o commit desplegado, los entornos comprobados, la ubicación final de los agentes migrados, el resultado de las pruebas y las evidencias relevantes. Distingue claramente entre lo implementado, lo probado en local y lo verificado en el despliegue.

**No declares una prueba aprobada si no la ejecutaste. No declares una integración funcional si solo la simulaste. No declares terminada la V4 si siguen fallando flujos esenciales.** Si queda algún bloqueo, informa qué falta, qué impacto tiene y qué evidencia existe, sin presentar esa parte como completada.