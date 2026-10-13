# Matriz CRUD verificable de Cauce V4

La fuente de datos de la matriz es [`v4-matriz-crud.json`](v4-matriz-crud.json). El validador comprueba las operaciones CRUD declaradas frente a las rutas registradas, los controles de la consola y las pruebas citadas:

```sh
pnpm exec vitest run tests/unit/crud-matrix.test.ts
```

## Oficina

| Entidad | Operación | Recorrido de navegador |
|---|---|---|
| Salas | Crear y leer | Crea dos salas desde la UI y las refleja en el plano editable y el campus. |
| Salas | Actualizar | Renombra una sala, asigna un agente y lo mueve a otra sala. |
| Salas | Eliminar | Explica el bloqueo de una sala ocupada y elimina la sala después de reasignar su agente. |
| Membresías | Crear | Asigna el agente a una sala desde la UI. |
| Membresías | Leer | Verifica la asignación tras re-login y desde otra persona de la misma empresa. |
| Membresías | Actualizar | Mueve el agente entre salas desde la UI. |
| Membresías | Eliminar | Verifica que la baja de la sala ocupada no deje un agente huérfano. |

La prueba completa de la oficina está en `tests/e2e/v4-office-real-browser.test.ts`. La matriz y este resumen describen cobertura; su inclusión no acredita por sí sola que la prueba haya pasado.
