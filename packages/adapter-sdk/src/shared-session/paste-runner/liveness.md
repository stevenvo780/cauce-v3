# Observación del panel y cuarentena

`PasteSessionLivenessRunner` interpreta capturas del panel con los mismos detectores
que protegen la caja de entrada antes de pegar un pedido. Una captura ilegible no
acredita actividad ni disponibilidad.

`paneStillGenerating` reconoce la indicación visual de generación. Permite seguir
esperando una correlación aunque una reflexión o una herramienta prolongada no
escriban en el transcript. Ese indicio no reinicia la ventana sin progreso del
registro: un panel congelado puede seguir mostrando su animación.

`paneIsIdle` exige ausencia de generación y una caja de entrada vacía. Un diálogo,
un panel en blanco o un pegado pendiente cuentan como ocupación para evitar que
otro pedido se concatene con el contenido existente.

Un panel aparentemente ocioso no acredita que una herramienta o un turno hayan
terminado. Por eso no libera una generación en cuarentena. La misma generación
solo se reutiliza cuando `reconcileTerminalPending` verifica un sobre terminal
correlacionado y guarda su resultado de forma durable antes de borrar el marcador.
Si no existe esa evidencia, la cuarentena se conserva hasta cambiar la generación
exacta del panel y su proceso.
