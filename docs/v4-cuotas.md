# Cuotas reales y «Mis cuotas»

## Estado de las cuotas

- Las cuentas canónicas pertenecen a una empresa y pueden compartirse entre varios agentes. Un registro repetido se resuelve a la cuenta existente.
- Las lecturas conservan hora observada y recibida. Los estados `unknown`, `error`, `stale` y `ok` no se confunden con saldo agotado.
- La consulta se ejecuta en el ordenador y entorno autorizados. El executor reutiliza sus comandos cerrados `--quota` y `--quota-auth-verify`; no abre un shell general ni crea un daemon paralelo.
- La autenticación requiere consentimiento y una operación con TTL, cuenta, proveedor, perfil, ordenador y entorno ligados. `awaiting_auth` es un estado pendiente, no una identidad verificada.
- La renovación de sesión usa `--refresh-own-session` solo dentro de un entorno de cuotas con sesión propia. Los lectores de otros entornos no renuevan sesiones compartidas.
- La lista de proveedores de un host depende de sus capacidades firmadas vigentes. Las identidades enroladas revocadas o vencidas no usan el fallback estático. `gemini` se excluye de la creación de entornos de cuotas en `quota-environments.ts`.
- La autenticación final debe comprobar una identidad aceptada por el proveedor; una etiqueta o correo local no basta. Las cuentas compartidas muestran el consumo como compartido.

## Imagen de cuotas

`ops/cuotas/Dockerfile` fija la imagen base y las versiones de los CLI. La política del host exige el digest de la imagen:

```bash
docker build -t cauce-cuotas-local ops/cuotas
docker image inspect cauce-cuotas-local --format '{{.Id}}'
```

Actualizar una versión requiere reconstruir la imagen y cambiar `policy.quota_environments.image`. Los entornos existentes conservan su imagen hasta recrearse; `update_cli` actualiza el paquete definido por el descriptor en el perfil del entorno.

## Evidencia

Las pruebas locales, los recibos negativos y sus límites están en la [matriz de verificación](v4-matriz-local.md). No acreditan autenticación actual de proveedores ni publicación del ciclo de entorno en producción.
