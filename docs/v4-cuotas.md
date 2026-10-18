# Cuotas reales y «Mis cuotas»

## Estado de las cuotas

- Las cuentas canónicas pertenecen a una empresa y pueden compartirse entre varios agentes. Un registro repetido se resuelve a la cuenta existente.
- Las lecturas conservan hora observada y recibida. Los estados `unknown`, `error`, `stale` y `ok` no se confunden con saldo agotado.
- La consulta se ejecuta en el ordenador y entorno autorizados. El executor reutiliza sus comandos cerrados `--quota` y `--quota-auth-verify`; no abre un shell general ni crea un daemon paralelo.
- La autenticación requiere consentimiento y una operación con TTL, cuenta, proveedor, perfil, ordenador y entorno ligados. `awaiting_auth` es un estado pendiente, no una identidad verificada.
- La renovación de sesión usa `--refresh-own-session` solo dentro de un entorno de cuotas con sesión propia. Los lectores de otros entornos no renuevan sesiones compartidas.
- La lista de proveedores de un host depende de sus capacidades firmadas vigentes. Las identidades enroladas revocadas o vencidas no usan el fallback estático. `gemini` se excluye de la creación de entornos de cuotas en `quota-environments.ts`.
- La autenticación final debe comprobar una identidad aceptada por el proveedor; una etiqueta o correo local no basta. Las cuentas compartidas muestran el consumo como compartido.

## Iniciar sesión en una cuenta

El único camino desde la web es **Mis cuotas → tarjeta de la cuenta → «Iniciar sesión»**. Ese clic es el consentimiento: crea el entorno de la cuenta si falta (en el único ordenador compatible, o en el que se elija al lado del botón), pide la operación `authenticate` y abre en un diálogo la terminal del CLI del proveedor dentro de ese contenedor. Se completa el login ahí (abrir el enlace, pegar el código) y se pulsa «Verificar conexión»; cancelar o cerrar el diálogo detiene el proceso de login y la operación queda fallida sin identidad. Sin un ordenador con ejecutor de cuotas que declare `authenticate` para el proveedor, el botón queda deshabilitado con el motivo.

| Proveedor | Comando de login (descriptor) | Estado |
|---|---|---|
| Claude | `claude auth login` (enlace OAuth y «Paste code here») | soportado |
| Codex | `codex login --device-auth` (enlace y código de dispositivo) | soportado |
| Grok | `grok login --device-auth` (enlace y código de dispositivo) | soportado |
| Muse | `muse login` (código de dispositivo de Meta) | sin soporte en entornos de cuotas: la imagen no instala Muse, no hay lector de cuotas y `quota_environments.provider` no admite `muse` |
| Antigravity (`agy`) | sin subcomando de login: `agy` abre el asistente de primer uso (tema, términos, inicio de sesión de Google) | sin soporte: no hay paquete fijable para la imagen ni lector de cuotas |

La autenticación de un agente (Muse incluido) sigue en la ficha del agente, como paso de su operación de flota.

## Imagen de cuotas

`ops/cuotas/Dockerfile` fija la imagen base y las versiones de los CLI. La política del host exige el digest de la imagen:

```bash
docker build -t cauce-cuotas-local ops/cuotas
docker image inspect cauce-cuotas-local --format '{{.Id}}'
```

Actualizar una versión requiere reconstruir la imagen y cambiar `policy.quota_environments.image`. Los entornos existentes conservan su imagen hasta recrearse; `update_cli` actualiza el paquete definido por el descriptor en el perfil del entorno. La comprobación local es `docker image inspect <etiqueta> --format '{{.Id}}'` igual al digest declarado en esa política. La imagen no instala Gemini: el build falla si aparece el binario o el paquete, y el repositorio de entornos rechaza el proveedor `gemini`.

## Binding de la credencial del agente

La consulta del agente lee la identidad dentro de su contenedor y no la imprime: solo viaja el hash. `bindAgentQuotaSample` ata ese hash a la cuenta de la empresa. Si la cuenta ya existe y no es un alta sintética `unverified:`, o si `primary_account_id` del agente es esa cuenta, el binding queda habilitado y la ficha deja de mostrar «sin cuenta». Si el agente ya tiene `primary_account_id` y la identidad medida es otra, la operación rechaza el resultado y no crea una cuenta nueva. Una identidad sin cuenta previa sigue pudiendo abrir una cuenta sintética deshabilitada para las pruebas; eso no siembra producción. La siembra real la ejecuta el orquestador con la misma operación de consulta, sin inventar bindings.

## Contraste del mismo instante y auditoría de secretos

`ops/cli/fleet_executor_agent_quota.py` compara, para Claude, Codex y Grok, las ventanas de la web con la salida JSON de `coutas` del mismo instante: mismas claves, el porcentaje dentro de ±1 (restante, o 100 menos el usado) y el mismo reinicio. `contrast_same_instant(web, coutas)` exige los tres proveedores. `audit_quota_logs` cuenta coincidencias de `access_token`, `refresh_token`, `sk-ant-`, `eyJ` y `user_code` en logs de gateway, logs de host y `audit_events`. `redact_secrets` las sustituye; el control positivo es que el secreto sembrado se detecta antes y no queda ninguna coincidencia después. La corrida contra producción la hace el orquestador con los logs vivos; aquí el procedimiento se prueba con fixtures.

## Evidencia

Las pruebas locales, los recibos negativos y sus límites están en la [matriz de verificación](v4-matriz-local.md). No acreditan autenticación actual de proveedores ni publicación del ciclo de entorno en producción.
