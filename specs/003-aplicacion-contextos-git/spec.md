# Aplicación explícita de versiones Git

## Alcance

Aplicar una instantánea inmutable de los siete campos canónicos a un perfil
existente mediante el PUT de perfil y su saga nativa actuales. Ninguna escritura
al abrir, consultar o refrescar. Sin creación de repositorios, transporte Git,
credenciales, migraciones, configuración viva, skills, memoria ni manuales.
La procedencia de la instantánea debe coincidir con una fila del diario existente;
contenido nuevo sin esa procedencia permanece limitado a inspección.

## Contrato

Una vista previa requiere control del tenant/alias y operador atribuido antes de
cualquier lectura. La raíz e instancia proceden exclusivamente del servidor.
Se verifican OID, campos, rutas y secretos con el inspector existente. Se comparan
el perfil vigente y la instantánea y se prepara, sin aplicar, la proyección nativa.
La confirmación vincula instancia, tenant, alias, operador, motivo humano, commit,
árbol, huella del perfil, identidad de diario de origen y vigente, revisión y
huellas de generación/documentos nativos. No transporta rutas elegidas por cliente.

Confirmar llama al mismo PUT de perfil. El servidor vuelve a medir y exige igualdad
con la vista previa. Antes del CAS se registra intención atribuida. Dentro de la
misma transacción de reemplazo se bloquean agente/perfil, se verifica el ID más
reciente del diario y se guarda procedencia sin cuerpos en la auditoría existente.
La revisión numérica sola no permite cruzar una eliminación/recreación. Repetir
la misma aplicación conserva el recibo y no repite el lote nativo. Si el recibo
caducó por retención, el CAS sigue impidiendo repetir el cambio antiguo.

Un recibo durable no acredita escritura nativa ni adopción. Un resultado incierto
exige releer; no se reintenta automáticamente. Los estados de adopción existentes
se conservan y sólo evidencia del adaptador permite acreditar aplicación efectiva.
Restaurar una BD exige que el dueño revalide su vinculación de instancia antes de
habilitar aplicación: este incremento no declara continuidad entre almacenes.

## Aceptación

- Autorización y atribución antes de disco/BD/sonda; nueva autorización al confirmar
- Sin escrituras en inspección/vista previa; confirmación expresa y motivo humano
- Rechazo por cambio de revisión, diario, instancia, commit, perfil o generación
- Rechazo de secretos, rutas extra, errores de montaje y soporte no acreditado
- Doble envío sin segunda revisión ni escritura; reinicio no pierde recibo durable
- Fallos antes/después del CAS y ACK parciales nunca fabrican adopción
- Cerrar/cambiar agente, commit o motivo invalida la confirmación pendiente
- Pruebas aisladas/sintéticas; despliegue y aplicación real quedan al dueño
