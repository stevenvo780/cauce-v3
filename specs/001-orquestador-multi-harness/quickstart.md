# Quickstart: validar el orquestador de punta a punta

**Spec**: [spec.md](spec.md). Todo corre en el propio host, nada toca
producción (red interna, postgres en tmpfs, único puerto `127.0.0.1:18080`).

## 0. Precondiciones

```bash
git -C /datos/workspaces/personal/cauce-v3 branch --show-current  # dev
docker images | grep cauce-v3-test  # runtime + qa construidas
```

## 1. Gate de código (SC-002)

```bash
pnpm typecheck && pnpm lint && pnpm test:unit
```

## 2. Pila de pruebas (SC-001, SC-006)

```bash
docker compose -f ops/compose.test.yaml build
docker compose -f ops/compose.test.yaml up -d
docker compose -f ops/compose.test.yaml ps        # 4 saludables
docker compose -f ops/compose.test.yaml logs e2e  # arnés --live verde
curl -s http://127.0.0.1:18080/health/ready       # ready
docker compose -f ops/compose.test.yaml down      # limpiar al terminar
```

Cada escenario esencial (US1) se ejerce así: publicar → reclamar con lease →
ACK en escalera → comprobar `done` en BD. El adaptador del arnés documenta el
paso exacto por escenario en `ops/harness/`.

## 3. Parámetros (SC-003, US2)

```bash
# auditar tabla de parámetros: unidad + fuente + valor o pregunta abierta
rg -n 'TOPES_|PRESUPUESTOS_DE_CONTEXTO|ACK_DEADLINE|POLL_MS|_LIMIT|_PRESUPUESTO' \
  packages/protocol/src services/gateway/src packages/store/src | head -50
```

Criterio: cero parámetros fantasma; lo no medido va a FR-011..FR-015 con dueño.

## 4. Poda y deriva (SC-004, SC-005)

```bash
node scripts/calidad.mjs              # trinquete: conteos sólo bajan
git diff --stat main..dev | tail -3   # deriva pendiente de ordenar
tail -5 deploy/HISTORIAL.md           # última fila registrada
```

## 5. Flota (US3)

```bash
ops/scripts/validate.sh  # byte a byte desde ops/flota.json
```
