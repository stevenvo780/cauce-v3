# Auditoría de dientes — suite TS completa (353 ficheros, 100.228 líneas)

Método: análisis sintáctico propio (`/tmp/opencode/dientes4.mjs`) sobre los 353 `*.test.ts(x)` de `git ls-files`, con tokenizador que blanquea strings, template literals, comentarios y regex antes de contar llaves — sin él, las llaves dentro de los nombres de test (`min-height: 0`) y los `test.beforeEach`/`test.advance` de fixtures locales producen 309 falsos "cero asserts". Cuatro subagentes leyeron los mismos ficheros a mano en paralelo (parciales `_parcial-dientes-*.md`). **Los cuatro reportaron «0 sin dientes»; la medición mecánica lo confirma para las categorías duras y lo corrige en las blandas.** Cuenta `assert.equal`/`assertX(...)` de `node:test` además de `expect`, o adapter-sdk y store salen falsamente vacíos.

## Veredicto en una línea

Esta suite NO tiene el patrón clásico de tests sin dientes: **cero tests sin ningún assert, cero snapshot-only, cero `it.skip`/`describe.skip`/`xit`/`test.todo`, cero asserts entre literales, cero tests que solo hagan `toHaveBeenCalled()`**. Los agujeros reales son otros tres y están medidos abajo: 14 tests que el gate nunca ejecuta, 8 tests cuyo único matcher no distingue el acierto del fallo, y 233 tests que afirman sobre el TEXTO de un fichero fuente en lugar del comportamiento.

## Totales por zona

| zona | ficheros | tests | asserts | asserts/test | matcher-débil | skip ambiental | assert-sobre-texto |
|---|---:|---:|---:|---:|---:|---:|---:|
| consola | 114 | 1158 | 3129 | 2.7 | 3 | 0 | 74 |
| packages | 96 | 1146 | 4392 | 3.8 | 2 | 14 | 47 |
| services | 66 | 848 | 2426 | 2.9 | 2 | 0 | 28 |
| tests/** | 77 | 492 | 1752 | 3.6 | 1 | 0 | 84 |
| **TOTAL** | **353** | **3644** | **11699** | **3.2** | **8** | **14** | **233** |

Categorías del enunciado que salen a CERO, cada una medida y no supuesta:

| categoría | hallazgos | cómo se midió |
|---|---:|---|
| cero asserts | **0** | 7 candidatos, los 7 falsos positivos: `test.beforeEach(` en adapter-sdk y la variable local `const test = await fixture()` de gateway, cuyo `test.advance(...)` parece un `test(`. Verificado leyendo los 7. |
| assert entre constantes | **0** | regex sobre `expect(<literal>).toBe(<literal>)` en los 3.644 cuerpos. |
| prueba-al-mock detectable | **0** | patrón `mockResolvedValue(X)` … `expect(...).toEqual(X)` con el MISMO identificador: ninguna coincidencia. |
| solo `toHaveBeenCalled()` | **0** | ningún test cuyos matchers sean todos `toHaveBeenCalled`/`toHaveBeenCalledTimes`. |
| snapshot-only | **0** | no hay un solo `toMatchSnapshot` en el árbol. |
| skip/disabled duro | **0** | `it.skip`, `describe.skip`, `xit`, `test.todo`: cero. |

## Los 20 PEORES, con cita textual

### A. Los 14 que el gate NUNCA ejecuta (skip ambiental) — el agujero de mayor volumen

`packages/adapter-sdk/test/shared-session.test.ts` tiene 12 tests que se auto-saltan si no hay `tmux`, y `harnesses.test.ts` otros 2 por plataforma. Son los tests de la maquinaria de sesión compartida — el corazón del adapter.

```
1608:  { skip: spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0 },
1667:  { skip: spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0 },
1886:    skip: spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0
1973:  { skip: spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0 },
2046:  { skip: spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0 },
2842:  { skip: spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0 },
2889:  { skip: spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0 },
3022:  { skip: spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0 },
4635:  { skip: spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0 },
4799:  { skip: spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0 },
4870:  { skip: spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0 },
4935:  { skip: spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0 },
```

Y los dos de plataforma:
```
493:test("timeout terminates the complete POSIX process group", { skip: process.platform === "win32" }, async () => {
516:test("cancellation terminates the complete POSIX process group", { skip: process.platform === "win32" }, async () => {
```

No son tests malos: son tests buenos que quizá nadie corre. **Acción para el dueño: decidir si tmux es requisito del gate o si estos 12 son deuda declarada.** Aquí `tmux -V` responde, así que hoy SÍ corren en esta máquina; en un CI sin tmux, 12 de los tests más caros del repo pasan en verde sin ejecutarse.

### B. Los 6 con matcher que no distingue acierto de fallo

Un `toBeDefined()`/`toBeTruthy()` como ÚNICO assert aprueba cualquier valor no nulo — incluido el equivocado.

1. `services/gateway/src/terminal/hechos-del-registro.test.ts:264-269` — el peor del lote, porque es un CONTROL NEGATIVO cuyo assert no controla nada:
```ts
  it('CONTROL NEGATIVO: recién reportado NO está viejo, o esta pieza no serviría nunca', async () => {
    // Sin esto, una implementación que devolviera `undefined` siempre pasaría las cinco de arriba.
    const registry = new AgentRegistry();
    registry.observe(RELAY, [presencia()]);
    expect(await hechosDelRegistro(registry).factsFor('Steven', 'zeus')).toBeDefined();
  });
```
El comentario dice que sin este test «una implementación que devolviera `undefined` siempre pasaría las cinco de arriba» — y es cierto; pero `toBeDefined()` también aprueba una implementación que devuelva el objeto de OTRO agente. El assert correcto compara los hechos con `presencia()`.

2. `apps/console/src/features/config/campos-inertes.test.ts:26-30`:
```ts
  it('marca las tres columnas de emplazamiento de `agents` sin lector runtime', () => {
    for (const campo of ['harness_id', 'home_directory', 'state_directory']) {
      expect(motivoInerte('agents', campo), `falta el motivo de agents.${campo}`).toBeDefined();
    }
  });
```

3. `apps/console/src/styles.tipografia.test.ts:182-187`:
```ts
  it('los seis escalones están declarados en el `:root` de la hoja global', () => {
    for (const nombre of [...ESCALA, '--tipo-mono']) {
      expect(tokens.get(nombre), `${nombre} no está en el :root de styles.css`).toBeDefined();
      expect(enPixeles(tokens.get(nombre)!, tokens), `${nombre} no resuelve a píxeles`).toBeDefined();
    }
  });
```

4. `apps/console/src/features/terminal/api.test.ts:394-398` — `toBeInstanceOf` como único assert: no comprueba ni el `status` ni el mensaje que el propio nombre del test promete («callers can branch on status»):
```ts
it('exposes TerminalApiError so callers can branch on status without parsing strings', async () => {
  server.use(http.get('*/v3/console/terminal/targets', () => new HttpResponse(null, { status: 503 })));
  const error = await listTerminalTargets().catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(TerminalApiError);
});
```

5-6. Mismo patrón `rejects.toBeInstanceOf(...)` sin comprobar el código de error, en `packages/store/src/repository.quota-schema-version.test.ts:45-50` y `packages/store/test/audit-pagination-postgres.test.ts:128-136`:
```ts
  it('el error es una instancia real de StoreError (para que statusFor lo mapee a 422)', async () => {
    const repository = new CauceRepository(trapPool());
    await expect(
      repository.recordQuotaSample('Steven', 'quota-collector', sample({ schema_version: 3 }))
    ).rejects.toBeInstanceOf(StoreError);
  });
---
  it.each([
    { limit: 0 },
    { limit: 501 },
    { before: '01' },
    { before: '9223372036854775808' },
  ])('rejects malformed pagination defensively: %j', async (options) => {
    await expect(repository.listAudit('Steven', 'kant', options))
      .rejects.toBeInstanceOf(StoreError);
  });
```

### C. Los 233 tests que afirman sobre el TEXTO de un fichero, no sobre el comportamiento

Categoría más grande y la única realmente sistémica: 6,4% de la suite (233/3.644) lee un fichero del árbol con `readFileSync` y hace `toContain`/`toMatch` sobre su texto. **No es fraude — varios son los guardias más valiosos del repo** (p.ej. `tests/unit/perfil-espejo-sql.test.ts` verifica que cada tope de `AGENT_PROFILE_LIMITS` tenga su `CHECK` con SU número en la migración 026: eso ningún test de comportamiento lo ve). Pero comparten un modo de falla: **se rompen al renombrar y aprueban una regla que existe pero no se aplica.** Los 10 ficheros con mayor proporción texto/comportamiento:

| fichero | tests-texto / total |
|---|---:|
| `tests/unit/host-backup-monitor.test.ts` | 12/12 |
| `packages/store/test/terminal-recovery-postgres.test.ts` | 10/10 |
| `tests/unit/compose-files.test.ts` | 7/7 |
| `tests/unit/observability-alerting.test.ts` | 7/7 |
| `apps/console/src/features/live/perfil-css.test.ts` | 6/6 |
| `tests/unit/perfil-espejo-sql.test.ts` | 5/5 |
| `apps/console/src/features/live/ficheros-legibilidad.test.ts` | 4/4 |
| `apps/console/src/features/messages/composer-anclado.test.ts` | 12/15 |
| `apps/console/src/features/terminal/denegaciones.test.tsx` | 12/13 |
| `services/gateway/src/health-progress.test.ts` | 18/34 |

Los tres primeros y `observability-alerting` son los candidatos claros a convertir en test de comportamiento: hoy afirman que un `.sh`/`.yml` CONTIENE una cadena, sin ejecutarlo nunca.

### D. Los ficheros con la relación assert/test más pobre (1 assert por test)

Un solo assert por test no es un defecto por sí mismo, pero marca dónde la cobertura es más fina de lo que el nombre del test promete:

| fichero | tests | asserts | asserts/test |
|---|---:|---:|---:|
| `apps/console/src/vocabulario.test.tsx` | 4 | 4 | 1,0 |
| `tests/gateway-hardening/perfil-en-el-saludo.test.ts` | 6 | 6 | 1,0 |
| `tests/unit/agent-profile-mutacion.test.ts` | 4 | 4 | 1,0 |
| `apps/console/src/features/live/medicion-de-capa.test.ts` | 15 | 16 | 1,07 |
| `services/telegram-bridge/test/envelope.test.ts` | 11 | 12 | 1,09 |
| `apps/console/src/features/terminal/nav-availability.test.tsx` | 10 | 11 | 1,10 |

## Hallazgo colateral: `test:unit` no cubre la mitad de la suite

`package.json` define `test:unit` como adapter-sdk + mcp-fleet-monitor + console + `tests/unit` + `packages/protocol/test`. **Los 66 ficheros de `services/**`, los 50 de `packages/store/test` y las suites `*-hardening`, `integration`, `e2e` y `terminal-pty` NO entran en el gate por commit** (tienen sus propios scripts `test:services`, `test:store-hardening`, etc., que requieren PostgreSQL o Docker). Son 1.140 de los 3.644 tests. El gate en verde no significa que esos 1.140 estén en verde.

## Tabla completa por fichero

Columnas: tests declarados · con dientes · matcher-débil · skip ambiental · asserts totales · tests que afirman sobre texto fuente.

| fichero | tests | con-dientes | débil | skip-amb | asserts | texto |
|---|---:|---:|---:|---:|---:|---:|
| `apps/console/src/App.invariantes.test.tsx` | 13 | 13 | 0 | 0 | 22 | 0 |
| `apps/console/src/App.test.tsx` | 20 | 20 | 0 | 0 | 62 | 0 |
| `apps/console/src/api/audit-client.test.ts` | 2 | 2 | 0 | 0 | 5 | 0 |
| `apps/console/src/api/client.test.ts` | 12 | 12 | 0 | 0 | 30 | 0 |
| `apps/console/src/api/client.timeout.test.ts` | 6 | 6 | 0 | 0 | 16 | 0 |
| `apps/console/src/api/use-resource.fallo-visible.test.tsx` | 5 | 5 | 0 | 0 | 21 | 0 |
| `apps/console/src/api/use-resource.test.tsx` | 2 | 2 | 0 | 0 | 14 | 0 |
| `apps/console/src/components/Tooltip.test.tsx` | 5 | 5 | 0 | 0 | 9 | 0 |
| `apps/console/src/components/view-tabs-legibilidad.test.ts` | 5 | 5 | 0 | 0 | 10 | 2 |
| `apps/console/src/contraste-cascada.test.ts` | 3 | 3 | 0 | 0 | 8 | 1 |
| `apps/console/src/features/accounts/AccountsPage.test.tsx` | 13 | 13 | 0 | 0 | 39 | 0 |
| `apps/console/src/features/accounts/AssignmentMatrix.test.tsx` | 13 | 13 | 0 | 0 | 31 | 0 |
| `apps/console/src/features/accounts/ConsumptionSection.test.tsx` | 10 | 10 | 0 | 0 | 54 | 0 |
| `apps/console/src/features/accounts/licenses-calculation.test.ts` | 5 | 5 | 0 | 0 | 12 | 0 |
| `apps/console/src/features/accounts/licenses.test.ts` | 17 | 17 | 0 | 0 | 38 | 0 |
| `apps/console/src/features/accounts/quotas.test.ts` | 16 | 16 | 0 | 0 | 24 | 0 |
| `apps/console/src/features/accounts/registry.test.ts` | 20 | 20 | 0 | 0 | 54 | 0 |
| `apps/console/src/features/audit/AuditPanel.test.tsx` | 4 | 4 | 0 | 0 | 19 | 0 |
| `apps/console/src/features/audit/audit-summary.test.ts` | 6 | 6 | 0 | 0 | 9 | 0 |
| `apps/console/src/features/auth/AuthGate.test.tsx` | 7 | 7 | 0 | 0 | 21 | 0 |
| `apps/console/src/features/config/ConfigPage.actions.test.tsx` | 18 | 18 | 0 | 0 | 69 | 0 |
| `apps/console/src/features/config/ConfigPage.inertes.test.tsx` | 10 | 10 | 0 | 0 | 18 | 0 |
| `apps/console/src/features/config/ConfigPage.tables.test.tsx` | 15 | 15 | 0 | 0 | 71 | 0 |
| `apps/console/src/features/config/ConfigPage.test.tsx` | 21 | 21 | 0 | 0 | 79 | 0 |
| `apps/console/src/features/config/Interruptores.test.tsx` | 14 | 14 | 0 | 0 | 49 | 0 |
| `apps/console/src/features/config/SpaceWizard.test.tsx` | 10 | 10 | 0 | 0 | 40 | 0 |
| `apps/console/src/features/config/alta-rapida.test.ts` | 5 | 5 | 0 | 0 | 10 | 0 |
| `apps/console/src/features/config/areas.test.ts` | 8 | 8 | 0 | 0 | 22 | 0 |
| `apps/console/src/features/config/arneses.test.ts` | 6 | 6 | 0 | 0 | 13 | 0 |
| `apps/console/src/features/config/campos-inertes.test.ts` | 13 | 12 | 1 | 0 | 29 | 0 |
| `apps/console/src/features/config/collection-table.test.ts` | 10 | 10 | 0 | 0 | 26 | 0 |
| `apps/console/src/features/config/collections.test.ts` | 5 | 5 | 0 | 0 | 10 | 0 |
| `apps/console/src/features/config/config-css-toggles.test.ts` | 13 | 13 | 0 | 0 | 26 | 2 |
| `apps/console/src/features/config/config-css.test.ts` | 19 | 19 | 0 | 0 | 44 | 4 |
| `apps/console/src/features/config/config-receipt.test.ts` | 3 | 3 | 0 | 0 | 10 | 0 |
| `apps/console/src/features/config/fecha-relativa.test.ts` | 3 | 3 | 0 | 0 | 13 | 0 |
| `apps/console/src/features/config/interruptores.test.ts` | 10 | 10 | 0 | 0 | 26 | 0 |
| `apps/console/src/features/config/roles.test.ts` | 4 | 4 | 0 | 0 | 15 | 0 |
| `apps/console/src/features/fleet/FleetAgentDetailPage.test.tsx` | 5 | 5 | 0 | 0 | 11 | 0 |
| `apps/console/src/features/landing/LandingPage.permisos.test.tsx` | 4 | 4 | 0 | 0 | 8 | 0 |
| `apps/console/src/features/landing/LandingPage.test.tsx` | 7 | 7 | 0 | 0 | 16 | 0 |
| `apps/console/src/features/landing/landing.test.ts` | 14 | 14 | 0 | 0 | 37 | 0 |
| `apps/console/src/features/live/ChainPanel.test.tsx` | 6 | 6 | 0 | 0 | 12 | 0 |
| `apps/console/src/features/live/DirectivaModal.test.tsx` | 10 | 10 | 0 | 0 | 30 | 0 |
| `apps/console/src/features/live/DirectivaTab.test.tsx` | 12 | 12 | 0 | 0 | 49 | 0 |
| `apps/console/src/features/live/FicherosTab.test.tsx` | 16 | 16 | 0 | 0 | 54 | 0 |
| `apps/console/src/features/live/FleetActivityTable.test.tsx` | 6 | 6 | 0 | 0 | 24 | 0 |
| `apps/console/src/features/live/HistorialRol.test.tsx` | 17 | 17 | 0 | 0 | 46 | 0 |
| `apps/console/src/features/live/LiveFleetPage.filters.test.tsx` | 15 | 15 | 0 | 0 | 41 | 0 |
| `apps/console/src/features/live/LiveFleetPage.sin-salida.test.tsx` | 5 | 5 | 0 | 0 | 17 | 0 |
| `apps/console/src/features/live/LiveFleetPage.test.tsx` | 23 | 23 | 0 | 0 | 60 | 0 |
| `apps/console/src/features/live/PerfilTab.test.tsx` | 11 | 11 | 0 | 0 | 28 | 0 |
| `apps/console/src/features/live/RoleBriefTab.test.tsx` | 3 | 3 | 0 | 0 | 10 | 0 |
| `apps/console/src/features/live/activity.test.ts` | 22 | 22 | 0 | 0 | 53 | 0 |
| `apps/console/src/features/live/agent-state-derivation.test.ts` | 28 | 28 | 0 | 0 | 52 | 0 |
| `apps/console/src/features/live/agent-state.test.ts` | 31 | 31 | 0 | 0 | 78 | 0 |
| `apps/console/src/features/live/deriva.test.ts` | 10 | 10 | 0 | 0 | 16 | 0 |
| `apps/console/src/features/live/directiva.test.ts` | 20 | 20 | 0 | 0 | 36 | 0 |
| `apps/console/src/features/live/estado-de-la-fila.test.tsx` | 4 | 4 | 0 | 0 | 9 | 0 |
| `apps/console/src/features/live/ficheros-legibilidad.test.ts` | 4 | 4 | 0 | 0 | 6 | 4 |
| `apps/console/src/features/live/ficheros.test.ts` | 17 | 17 | 0 | 0 | 28 | 0 |
| `apps/console/src/features/live/historial-rol.test.ts` | 16 | 16 | 0 | 0 | 24 | 0 |
| `apps/console/src/features/live/medicion-de-capa.test.ts` | 15 | 15 | 0 | 0 | 16 | 0 |
| `apps/console/src/features/live/perfil-css.test.ts` | 6 | 6 | 0 | 0 | 11 | 6 |
| `apps/console/src/features/live/perfil.test.ts` | 22 | 22 | 0 | 0 | 42 | 0 |
| `apps/console/src/features/live/role-brief-runtime.test.ts` | 4 | 4 | 0 | 0 | 13 | 0 |
| `apps/console/src/features/live/tira-de-pestanas.test.ts` | 4 | 4 | 0 | 0 | 5 | 2 |
| `apps/console/src/features/live/veredicto-vocabulario.test.ts` | 4 | 4 | 0 | 0 | 11 | 0 |
| `apps/console/src/features/live/vocabulario-de-estados.test.ts` | 6 | 6 | 0 | 0 | 9 | 0 |
| `apps/console/src/features/messages/MessageTimeline.test.tsx` | 1 | 1 | 0 | 0 | 4 | 0 |
| `apps/console/src/features/messages/MessagesPage.test.tsx` | 21 | 21 | 0 | 0 | 76 | 0 |
| `apps/console/src/features/messages/composer-anclado.test.ts` | 15 | 15 | 0 | 0 | 27 | 12 |
| `apps/console/src/features/messages/desplazamiento.test.ts` | 7 | 7 | 0 | 0 | 8 | 0 |
| `apps/console/src/features/messages/durable-publish.test.ts` | 11 | 11 | 0 | 0 | 35 | 0 |
| `apps/console/src/features/messages/hilo-legible.test.tsx` | 9 | 9 | 0 | 0 | 24 | 0 |
| `apps/console/src/features/messages/messages-css.test.ts` | 2 | 2 | 0 | 0 | 3 | 0 |
| `apps/console/src/features/messages/publish-receipt.test.ts` | 6 | 6 | 0 | 0 | 31 | 0 |
| `apps/console/src/features/messages/queue-health.test.ts` | 12 | 12 | 0 | 0 | 26 | 0 |
| `apps/console/src/features/messages/roster.test.ts` | 9 | 9 | 0 | 0 | 25 | 0 |
| `apps/console/src/features/observability/ObservabilityPage.test.tsx` | 11 | 11 | 0 | 0 | 45 | 0 |
| `apps/console/src/features/queues/DeliveryTable.test.tsx` | 8 | 8 | 0 | 0 | 28 | 0 |
| `apps/console/src/features/queues/OperationalDlqPanel.test.tsx` | 13 | 13 | 0 | 0 | 51 | 0 |
| `apps/console/src/features/queues/QueuesPage.test.tsx` | 6 | 6 | 0 | 0 | 20 | 0 |
| `apps/console/src/features/queues/colas-accionables.test.tsx` | 10 | 10 | 0 | 0 | 26 | 0 |
| `apps/console/src/features/queues/colas-puras.test.ts` | 14 | 14 | 0 | 0 | 22 | 3 |
| `apps/console/src/features/queues/delivery-receipts.test.ts` | 2 | 2 | 0 | 0 | 15 | 0 |
| `apps/console/src/features/queues/foco-de-entrega.test.ts` | 6 | 6 | 0 | 0 | 13 | 0 |
| `apps/console/src/features/terminal/AckInspector.test.tsx` | 5 | 5 | 0 | 0 | 11 | 0 |
| `apps/console/src/features/terminal/TerminalPage.test.tsx` | 20 | 20 | 0 | 0 | 104 | 0 |
| `apps/console/src/features/terminal/api.test.ts` | 27 | 26 | 1 | 0 | 42 | 0 |
| `apps/console/src/features/terminal/cuerpo-del-mensaje.test.ts` | 6 | 6 | 0 | 0 | 14 | 1 |
| `apps/console/src/features/terminal/denegaciones.test.tsx` | 13 | 13 | 0 | 0 | 39 | 12 |
| `apps/console/src/features/terminal/densidad-observacion.test.tsx` | 4 | 4 | 0 | 0 | 10 | 0 |
| `apps/console/src/features/terminal/estilos-en-linea.test.ts` | 3 | 3 | 0 | 0 | 5 | 0 |
| `apps/console/src/features/terminal/fleet.test.ts` | 12 | 12 | 0 | 0 | 46 | 0 |
| `apps/console/src/features/terminal/live-tui.test.tsx` | 8 | 8 | 0 | 0 | 39 | 0 |
| `apps/console/src/features/terminal/nav-availability.test.tsx` | 10 | 10 | 0 | 0 | 11 | 0 |
| `apps/console/src/features/terminal/plazas.test.tsx` | 17 | 17 | 0 | 0 | 65 | 0 |
| `apps/console/src/features/terminal/plugin.test.ts` | 7 | 7 | 0 | 0 | 15 | 0 |
| `apps/console/src/features/terminal/pty-session.test.ts` | 24 | 24 | 0 | 0 | 95 | 0 |
| `apps/console/src/features/terminal/redimensionado.test.ts` | 4 | 4 | 0 | 0 | 7 | 0 |
| `apps/console/src/features/terminal/relay-status.test.tsx` | 21 | 21 | 0 | 0 | 46 | 0 |
| `apps/console/src/features/terminal/session.test.ts` | 6 | 6 | 0 | 0 | 22 | 0 |
| `apps/console/src/features/terminal/xterm-csp.test.ts` | 7 | 7 | 0 | 0 | 24 | 6 |
| `apps/console/src/features/topology/hypergraph-layout.test.ts` | 16 | 16 | 0 | 0 | 35 | 0 |
| `apps/console/src/lib.test.ts` | 1 | 1 | 0 | 0 | 7 | 0 |
| `apps/console/src/menu-movil.test.ts` | 5 | 5 | 0 | 0 | 8 | 3 |
| `apps/console/src/mocks/handlers.tenant.test.ts` | 2 | 2 | 0 | 0 | 5 | 0 |
| `apps/console/src/mocks/terminal-demo.test.ts` | 1 | 1 | 0 | 0 | 4 | 0 |
| `apps/console/src/styles.legibilidad-themes.test.ts` | 6 | 6 | 0 | 0 | 10 | 3 |
| `apps/console/src/styles.legibilidad.test.ts` | 10 | 10 | 0 | 0 | 18 | 6 |
| `apps/console/src/styles.tipografia-montada.test.tsx` | 4 | 4 | 0 | 0 | 10 | 3 |
| `apps/console/src/styles.tipografia.test.ts` | 14 | 13 | 1 | 0 | 34 | 4 |
| `apps/console/src/vocabulario.test.tsx` | 4 | 4 | 0 | 0 | 4 | 0 |
| `packages/adapter-sdk/test/account-credentials.test.ts` | 12 | 12 | 0 | 0 | 25 | 0 |
| `packages/adapter-sdk/test/artifact-inliner.test.ts` | 19 | 19 | 0 | 0 | 66 | 0 |
| `packages/adapter-sdk/test/bloque-gestionado.test.ts` | 14 | 14 | 0 | 0 | 33 | 0 |
| `packages/adapter-sdk/test/bridges.test.ts` | 10 | 10 | 0 | 0 | 29 | 0 |
| `packages/adapter-sdk/test/client.test.ts` | 25 | 25 | 0 | 0 | 89 | 0 |
| `packages/adapter-sdk/test/config.test.ts` | 4 | 4 | 0 | 0 | 16 | 0 |
| `packages/adapter-sdk/test/contexto-fijo-no-se-repite.test.ts` | 8 | 8 | 0 | 0 | 18 | 0 |
| `packages/adapter-sdk/test/dialects.test.ts` | 7 | 7 | 0 | 0 | 27 | 2 |
| `packages/adapter-sdk/test/durable-store.test.ts` | 20 | 20 | 0 | 0 | 111 | 5 |
| `packages/adapter-sdk/test/engine-session-queue.test.ts` | 4 | 4 | 0 | 0 | 18 | 0 |
| `packages/adapter-sdk/test/engine.test.ts` | 72 | 72 | 0 | 0 | 327 | 4 |
| `packages/adapter-sdk/test/fanin-synthesizer.test.ts` | 10 | 10 | 0 | 0 | 39 | 0 |
| `packages/adapter-sdk/test/fence.test.ts` | 9 | 9 | 0 | 0 | 16 | 0 |
| `packages/adapter-sdk/test/gate-probe.test.ts` | 2 | 2 | 0 | 0 | 15 | 0 |
| `packages/adapter-sdk/test/harness-turn-failure.test.ts` | 14 | 14 | 0 | 0 | 39 | 0 |
| `packages/adapter-sdk/test/harnesses.test.ts` | 16 | 14 | 0 | 2 | 54 | 5 |
| `packages/adapter-sdk/test/identity-preamble.test.ts` | 5 | 5 | 0 | 0 | 23 | 0 |
| `packages/adapter-sdk/test/manifests.test.ts` | 3 | 3 | 0 | 0 | 12 | 1 |
| `packages/adapter-sdk/test/observability.test.ts` | 4 | 4 | 0 | 0 | 12 | 0 |
| `packages/adapter-sdk/test/openclaw-terminal-pointer.test.ts` | 7 | 7 | 0 | 0 | 21 | 2 |
| `packages/adapter-sdk/test/openclaw.test.ts` | 7 | 7 | 0 | 0 | 20 | 0 |
| `packages/adapter-sdk/test/output-parser-contract.test.ts` | 38 | 38 | 0 | 0 | 85 | 0 |
| `packages/adapter-sdk/test/output-parser-lost-delegations.test.ts` | 7 | 7 | 0 | 0 | 17 | 0 |
| `packages/adapter-sdk/test/output-parser-sobre-roto.test.ts` | 30 | 30 | 0 | 0 | 53 | 0 |
| `packages/adapter-sdk/test/perfil-a-contexto.test.ts` | 28 | 28 | 0 | 0 | 63 | 0 |
| `packages/adapter-sdk/test/pingpong-descarte.test.ts` | 6 | 6 | 0 | 0 | 22 | 0 |
| `packages/adapter-sdk/test/preflight-retry.test.ts` | 14 | 14 | 0 | 0 | 35 | 2 |
| `packages/adapter-sdk/test/presupuesto-del-sobre.test.ts` | 4 | 4 | 0 | 0 | 5 | 0 |
| `packages/adapter-sdk/test/process-runner-orphan-pipes.test.ts` | 4 | 4 | 0 | 0 | 11 | 0 |
| `packages/adapter-sdk/test/process-runner.test.ts` | 5 | 5 | 0 | 0 | 11 | 0 |
| `packages/adapter-sdk/test/protocol-prompt.test.ts` | 16 | 16 | 0 | 0 | 78 | 0 |
| `packages/adapter-sdk/test/runtime-capabilities.test.ts` | 6 | 6 | 0 | 0 | 21 | 0 |
| `packages/adapter-sdk/test/sello-desde-el-adaptador.test.ts` | 8 | 8 | 0 | 0 | 25 | 0 |
| `packages/adapter-sdk/test/session-origin.test.ts` | 4 | 4 | 0 | 0 | 14 | 0 |
| `packages/adapter-sdk/test/shared-session-turn-merge.test.ts` | 10 | 10 | 0 | 0 | 40 | 0 |
| `packages/adapter-sdk/test/shared-session.test.ts` | 115 | 103 | 0 | 12 | 779 | 0 |
| `packages/adapter-sdk/test/siembra-del-contexto.test.ts` | 8 | 8 | 0 | 0 | 18 | 0 |
| `packages/adapter-sdk/test/siembra-del-perfil.test.ts` | 21 | 21 | 0 | 0 | 68 | 0 |
| `packages/adapter-sdk/test/websocket-transport.test.ts` | 7 | 7 | 0 | 0 | 55 | 0 |
| `packages/mcp-fleet-monitor/src/fleet-read-model.test.ts` | 9 | 9 | 0 | 0 | 16 | 0 |
| `packages/protocol/test/ficheros-del-arnes.test.ts` | 20 | 20 | 0 | 0 | 62 | 0 |
| `packages/protocol/test/ficheros-que-no-mienten.test.ts` | 18 | 18 | 0 | 0 | 44 | 0 |
| `packages/protocol/test/priority.test.ts` | 7 | 7 | 0 | 0 | 15 | 0 |
| `packages/protocol/test/schemas.test.ts` | 24 | 24 | 0 | 0 | 64 | 0 |
| `packages/store/src/fleet-activity.test.ts` | 9 | 9 | 0 | 0 | 20 | 0 |
| `packages/store/src/repository.quota-schema-version.test.ts` | 3 | 2 | 1 | 0 | 6 | 0 |
| `packages/store/test/abortable-transaction-postgres.test.ts` | 2 | 2 | 0 | 0 | 7 | 0 |
| `packages/store/test/agent-chain-visibility-postgres.test.ts` | 20 | 20 | 0 | 0 | 56 | 0 |
| `packages/store/test/agent-output-postgres.test.ts` | 38 | 38 | 0 | 0 | 182 | 0 |
| `packages/store/test/agent-profile-migration-postgres.test.ts` | 7 | 7 | 0 | 0 | 21 | 1 |
| `packages/store/test/agent-profile-mutacion.test.ts` | 4 | 4 | 0 | 0 | 11 | 0 |
| `packages/store/test/agent-profile-postgres.test.ts` | 42 | 42 | 0 | 0 | 86 | 0 |
| `packages/store/test/agent-profile-presence.test.ts` | 2 | 2 | 0 | 0 | 7 | 0 |
| `packages/store/test/agent-profile-runtime-adoption-migration-postgres.test.ts` | 4 | 4 | 0 | 0 | 13 | 2 |
| `packages/store/test/agent-profile-runtime-adoption-postgres.test.ts` | 5 | 5 | 0 | 0 | 23 | 0 |
| `packages/store/test/agent-target-access.test.ts` | 4 | 4 | 0 | 0 | 10 | 0 |
| `packages/store/test/ambiguous-without-execution-postgres.test.ts` | 4 | 4 | 0 | 0 | 25 | 0 |
| `packages/store/test/audit-pagination-postgres.test.ts` | 2 | 1 | 1 | 0 | 7 | 0 |
| `packages/store/test/audit-summary.test.ts` | 6 | 6 | 0 | 0 | 10 | 0 |
| `packages/store/test/canonical-agent-role-postgres.test.ts` | 7 | 7 | 0 | 0 | 22 | 1 |
| `packages/store/test/catalogo-no-se-filtra.test.ts` | 5 | 5 | 0 | 0 | 11 | 0 |
| `packages/store/test/chain-silence-sweep-postgres.test.ts` | 17 | 17 | 0 | 0 | 83 | 0 |
| `packages/store/test/configuration-reader.test.ts` | 2 | 2 | 0 | 0 | 11 | 0 |
| `packages/store/test/connection-session-fencing-migration-postgres.test.ts` | 3 | 3 | 0 | 0 | 9 | 1 |
| `packages/store/test/connection-session-fencing-postgres.test.ts` | 3 | 3 | 0 | 0 | 21 | 0 |
| `packages/store/test/console-publish-intent-migration-postgres.test.ts` | 7 | 7 | 0 | 0 | 26 | 2 |
| `packages/store/test/console-publish-intent-postgres.test.ts` | 24 | 24 | 0 | 0 | 118 | 0 |
| `packages/store/test/delegation-discipline-postgres.test.ts` | 16 | 16 | 0 | 0 | 80 | 0 |
| `packages/store/test/delegation-guard.test.ts` | 13 | 13 | 0 | 0 | 25 | 0 |
| `packages/store/test/delivery-admission-postgres.test.ts` | 16 | 16 | 0 | 0 | 41 | 0 |
| `packages/store/test/delivery-concurrency-postgres.test.ts` | 14 | 14 | 0 | 0 | 35 | 0 |
| `packages/store/test/dlq-causal-reconciliation-migration-postgres.test.ts` | 6 | 6 | 0 | 0 | 24 | 1 |
| `packages/store/test/dlq-causal-reconciliation-postgres.test.ts` | 20 | 20 | 0 | 0 | 149 | 0 |
| `packages/store/test/egress-notification-postgres.test.ts` | 32 | 32 | 0 | 0 | 96 | 0 |
| `packages/store/test/failure-notice-coalescing-postgres.test.ts` | 12 | 12 | 0 | 0 | 47 | 0 |
| `packages/store/test/fleet-reconciliation-postgres.test.ts` | 6 | 6 | 0 | 0 | 47 | 0 |
| `packages/store/test/late-terminal-ack-postgres.test.ts` | 18 | 18 | 0 | 0 | 73 | 0 |
| `packages/store/test/lease-cap-postgres.test.ts` | 8 | 8 | 0 | 0 | 30 | 0 |
| `packages/store/test/legacy-console-outbox-reconciliation-postgres.test.ts` | 2 | 2 | 0 | 0 | 8 | 0 |
| `packages/store/test/materialization-crosstenantroom-postgres.test.ts` | 2 | 2 | 0 | 0 | 18 | 0 |
| `packages/store/test/migration-integrity-postgres.test.ts` | 2 | 2 | 0 | 0 | 19 | 2 |
| `packages/store/test/muestra-no-es-total.test.ts` | 3 | 3 | 0 | 0 | 8 | 0 |
| `packages/store/test/observability-retention-postgres.test.ts` | 8 | 8 | 0 | 0 | 27 | 0 |
| `packages/store/test/priority-band-postgres.test.ts` | 7 | 7 | 0 | 0 | 13 | 0 |
| `packages/store/test/publish-receipt-postgres.test.ts` | 3 | 3 | 0 | 0 | 13 | 0 |
| `packages/store/test/queue-heartbeat-postgres.test.ts` | 3 | 3 | 0 | 0 | 15 | 0 |
| `packages/store/test/replay-postgres.test.ts` | 5 | 5 | 0 | 0 | 57 | 0 |
| `packages/store/test/retry-policy-postgres.test.ts` | 10 | 10 | 0 | 0 | 33 | 0 |
| `packages/store/test/sql-locking-clauses.test.ts` | 2 | 2 | 0 | 0 | 2 | 2 |
| `packages/store/test/terminal-browser-owner-fencing-migration-postgres.test.ts` | 4 | 4 | 0 | 0 | 17 | 1 |
| `packages/store/test/terminal-recovery-postgres.test.ts` | 10 | 10 | 0 | 0 | 46 | 10 |
| `packages/store/test/terminal-relay-instance-fencing-migration-postgres.test.ts` | 5 | 5 | 0 | 0 | 18 | 1 |
| `packages/store/test/terminal-session-claim-fencing-migration-postgres.test.ts` | 5 | 5 | 0 | 0 | 23 | 2 |
| `packages/store/test/timeout-retry-backoff.test.ts` | 5 | 5 | 0 | 0 | 11 | 0 |
| `packages/store/test/topology-registry-postgres.test.ts` | 1 | 1 | 0 | 0 | 6 | 0 |
| `packages/store/test/visited-path-fallback-postgres.test.ts` | 7 | 7 | 0 | 0 | 15 | 0 |
| `services/dispatcher/test/config.test.ts` | 14 | 14 | 0 | 0 | 27 | 0 |
| `services/dispatcher/test/handlers.test.ts` | 2 | 2 | 0 | 0 | 4 | 0 |
| `services/dispatcher/test/liveness.test.ts` | 4 | 4 | 0 | 0 | 16 | 0 |
| `services/gateway/src/agent-directive-degrada.test.ts` | 5 | 5 | 0 | 0 | 17 | 0 |
| `services/gateway/src/config.test.ts` | 7 | 7 | 0 | 0 | 9 | 0 |
| `services/gateway/src/console-audit.test.ts` | 3 | 3 | 0 | 0 | 9 | 0 |
| `services/gateway/src/console-dlq.test.ts` | 9 | 9 | 0 | 0 | 27 | 0 |
| `services/gateway/src/console-message-body.test.ts` | 4 | 4 | 0 | 0 | 9 | 0 |
| `services/gateway/src/console-publish-intent.test.ts` | 7 | 7 | 0 | 0 | 39 | 0 |
| `services/gateway/src/console-publish-telemetry.test.ts` | 2 | 2 | 0 | 0 | 7 | 0 |
| `services/gateway/src/console/agent-directive.routes.test.ts` | 16 | 16 | 0 | 0 | 63 | 0 |
| `services/gateway/src/console/agent-documents.read.test.ts` | 27 | 27 | 0 | 0 | 46 | 0 |
| `services/gateway/src/console/agent-documents.routes.test.ts` | 22 | 22 | 0 | 0 | 75 | 0 |
| `services/gateway/src/console/agent-documents.test.ts` | 28 | 28 | 0 | 0 | 74 | 0 |
| `services/gateway/src/console/agent-profile-runtime.test.ts` | 10 | 10 | 0 | 0 | 26 | 0 |
| `services/gateway/src/console/agent-profile.routes.test.ts` | 38 | 38 | 0 | 0 | 86 | 0 |
| `services/gateway/src/console/relay-governance-client.test.ts` | 28 | 28 | 0 | 0 | 51 | 8 |
| `services/gateway/src/console/sonda-compartida.test.ts` | 8 | 8 | 0 | 0 | 17 | 0 |
| `services/gateway/src/facades.dlq.test.ts` | 8 | 8 | 0 | 0 | 15 | 0 |
| `services/gateway/src/health-progress.test.ts` | 34 | 34 | 0 | 0 | 136 | 18 |
| `services/gateway/src/health-schema037.pg.test.ts` | 1 | 1 | 0 | 0 | 14 | 0 |
| `services/gateway/src/mtls-health.test.ts` | 1 | 1 | 0 | 0 | 7 | 1 |
| `services/gateway/src/oidc-bff.test.ts` | 3 | 3 | 0 | 0 | 24 | 0 |
| `services/gateway/src/password-auth.test.ts` | 16 | 15 | 1 | 0 | 66 | 0 |
| `services/gateway/src/password.test.ts` | 5 | 5 | 0 | 0 | 18 | 0 |
| `services/gateway/src/publish-priority-policy.test.ts` | 4 | 4 | 0 | 0 | 8 | 0 |
| `services/gateway/src/publish-priority.test.ts` | 7 | 7 | 0 | 0 | 17 | 0 |
| `services/gateway/src/routes/legado-candidato.test.ts` | 3 | 3 | 0 | 0 | 7 | 0 |
| `services/gateway/src/terminal.authority.test.ts` | 19 | 19 | 0 | 0 | 61 | 0 |
| `services/gateway/src/terminal.plugin.test.ts` | 58 | 58 | 0 | 0 | 258 | 0 |
| `services/gateway/src/terminal.relay-identity.test.ts` | 1 | 1 | 0 | 0 | 7 | 0 |
| `services/gateway/src/terminal.tickets.test.ts` | 13 | 13 | 0 | 0 | 26 | 0 |
| `services/gateway/src/terminal/hechos-del-registro.test.ts` | 23 | 22 | 1 | 0 | 57 | 0 |
| `services/telegram-bridge/test/activity.test.ts` | 10 | 10 | 0 | 0 | 30 | 0 |
| `services/telegram-bridge/test/addressing.test.ts` | 44 | 44 | 0 | 0 | 65 | 0 |
| `services/telegram-bridge/test/artifacts.test.ts` | 15 | 15 | 0 | 0 | 42 | 0 |
| `services/telegram-bridge/test/attachments.test.ts` | 5 | 5 | 0 | 0 | 18 | 0 |
| `services/telegram-bridge/test/bridge-egress.test.ts` | 24 | 24 | 0 | 0 | 69 | 0 |
| `services/telegram-bridge/test/bridge-ingress.test.ts` | 17 | 17 | 0 | 0 | 63 | 0 |
| `services/telegram-bridge/test/bridge-lifecycle.test.ts` | 11 | 11 | 0 | 0 | 51 | 0 |
| `services/telegram-bridge/test/bridge.test.ts` | 12 | 12 | 0 | 0 | 34 | 0 |
| `services/telegram-bridge/test/config.test.ts` | 16 | 16 | 0 | 0 | 26 | 0 |
| `services/telegram-bridge/test/envelope.test.ts` | 11 | 11 | 0 | 0 | 12 | 0 |
| `services/telegram-bridge/test/fragments.test.ts` | 7 | 7 | 0 | 0 | 37 | 0 |
| `services/telegram-bridge/test/ingress-postgres.test.ts` | 1 | 1 | 0 | 0 | 5 | 0 |
| `services/telegram-bridge/test/ingress.test.ts` | 4 | 4 | 0 | 0 | 9 | 0 |
| `services/telegram-bridge/test/markdown.test.ts` | 14 | 14 | 0 | 0 | 29 | 0 |
| `services/telegram-bridge/test/postgres.test.ts` | 2 | 2 | 0 | 0 | 21 | 0 |
| `services/telegram-bridge/test/progress.test.ts` | 5 | 5 | 0 | 0 | 17 | 0 |
| `services/telegram-bridge/test/redaction.test.ts` | 18 | 18 | 0 | 0 | 36 | 0 |
| `services/telegram-bridge/test/untrusted.test.ts` | 17 | 17 | 0 | 0 | 43 | 0 |
| `services/telegram-bridge/test/voice.test.ts` | 15 | 15 | 0 | 0 | 34 | 0 |
| `services/terminal-relay/src/agent-leg.test.ts` | 9 | 9 | 0 | 0 | 25 | 0 |
| `services/terminal-relay/src/framing.test.ts` | 10 | 10 | 0 | 0 | 29 | 0 |
| `services/terminal-relay/src/governance-relay-mutations.test.ts` | 8 | 8 | 0 | 0 | 22 | 0 |
| `services/terminal-relay/src/governance-relay.test.ts` | 21 | 21 | 0 | 0 | 43 | 0 |
| `services/terminal-relay/src/health.test.ts` | 3 | 3 | 0 | 0 | 20 | 1 |
| `services/terminal-relay/src/read-governance-directory.test.ts` | 20 | 20 | 0 | 0 | 39 | 0 |
| `services/terminal-relay/src/read-governance.test.ts` | 15 | 15 | 0 | 0 | 36 | 0 |
| `services/terminal-relay/src/relay-circuit.test.ts` | 20 | 20 | 0 | 0 | 66 | 0 |
| `services/terminal-relay/src/relay.test.ts` | 13 | 13 | 0 | 0 | 49 | 0 |
| `services/terminal-relay/src/session-spool.test.ts` | 3 | 3 | 0 | 0 | 7 | 0 |
| `services/terminal-relay/src/sessions-recovery.test.ts` | 10 | 10 | 0 | 0 | 33 | 0 |
| `services/terminal-relay/src/sessions.test.ts` | 25 | 25 | 0 | 0 | 63 | 0 |
| `services/terminal-relay/src/write-governance-batch.test.ts` | 4 | 4 | 0 | 0 | 11 | 0 |
| `services/terminal-relay/src/write-governance.test.ts` | 9 | 9 | 0 | 0 | 19 | 0 |
| `tests/e2e/console-login.test.ts` | 7 | 7 | 0 | 0 | 21 | 0 |
| `tests/e2e/real-qa.test.ts` | 3 | 3 | 0 | 0 | 4 | 0 |
| `tests/gateway-hardening/account-selection-route.test.ts` | 4 | 4 | 0 | 0 | 8 | 0 |
| `tests/gateway-hardening/ack-result-frame-gating.test.ts` | 3 | 3 | 0 | 0 | 12 | 0 |
| `tests/gateway-hardening/agent-read-routes.test.ts` | 4 | 4 | 0 | 0 | 20 | 0 |
| `tests/gateway-hardening/auth-providers.test.ts` | 4 | 4 | 0 | 0 | 9 | 0 |
| `tests/gateway-hardening/console-api-contract.test.ts` | 3 | 3 | 0 | 0 | 7 | 1 |
| `tests/gateway-hardening/delivery-admission.test.ts` | 15 | 15 | 0 | 0 | 62 | 0 |
| `tests/gateway-hardening/delivery-drain-capacity.test.ts` | 6 | 6 | 0 | 0 | 11 | 0 |
| `tests/gateway-hardening/gateway-security.test.ts` | 25 | 25 | 0 | 0 | 99 | 0 |
| `tests/gateway-hardening/identity-rotation.test.ts` | 4 | 4 | 0 | 0 | 15 | 3 |
| `tests/gateway-hardening/perfil-en-el-saludo.test.ts` | 6 | 6 | 0 | 0 | 6 | 2 |
| `tests/gateway-hardening/publish-receipt-restart-postgres.test.ts` | 1 | 1 | 0 | 0 | 6 | 0 |
| `tests/gateway-hardening/quota-and-activity-routes.test.ts` | 10 | 10 | 0 | 0 | 22 | 0 |
| `tests/gateway-hardening/rutas-de-perfil-montadas.test.ts` | 7 | 7 | 0 | 0 | 19 | 0 |
| `tests/gateway-hardening/terminal-ack-replay-postgres.test.ts` | 1 | 1 | 0 | 0 | 8 | 0 |
| `tests/gateway-hardening/wake-outbox-postgres.test.ts` | 2 | 2 | 0 | 0 | 10 | 0 |
| `tests/gateway-hardening/wake-outbox-routing.test.ts` | 8 | 8 | 0 | 0 | 40 | 0 |
| `tests/gateway-hardening/websocket-correlation.test.ts` | 6 | 6 | 0 | 0 | 40 | 0 |
| `tests/integration/busybox-console-healthcheck.test.ts` | 1 | 0 | 1 | 0 | 4 | 0 |
| `tests/integration/mcp-fleet-monitor-tools.test.ts` | 6 | 6 | 0 | 0 | 17 | 4 |
| `tests/integration/otel-collector-config.test.ts` | 2 | 2 | 0 | 0 | 8 | 2 |
| `tests/integration/vertical.test.ts` | 18 | 18 | 0 | 0 | 101 | 0 |
| `tests/store-hardening/account-selector-postgres.test.ts` | 16 | 16 | 0 | 0 | 51 | 0 |
| `tests/store-hardening/adversarial-postgres.test.ts` | 18 | 18 | 0 | 0 | 105 | 0 |
| `tests/store-hardening/agent-registry-postgres.test.ts` | 19 | 19 | 0 | 0 | 57 | 0 |
| `tests/store-hardening/agent-role-brief-postgres.test.ts` | 7 | 7 | 0 | 0 | 21 | 0 |
| `tests/store-hardening/configuration-postgres.test.ts` | 9 | 9 | 0 | 0 | 53 | 7 |
| `tests/store-hardening/gate-collector-postgres.test.ts` | 4 | 4 | 0 | 0 | 12 | 1 |
| `tests/store-hardening/oidc-session-postgres.test.ts` | 3 | 3 | 0 | 0 | 10 | 0 |
| `tests/store-hardening/quota-ingest-conflict-postgres.test.ts` | 3 | 3 | 0 | 0 | 10 | 0 |
| `tests/store-hardening/terminal-admission-postgres.test.ts` | 16 | 16 | 0 | 0 | 74 | 0 |
| `tests/terminal-pty/presence-contract.test.ts` | 4 | 4 | 0 | 0 | 9 | 0 |
| `tests/terminal-pty/relay-contract-agent.test.ts` | 11 | 11 | 0 | 0 | 34 | 0 |
| `tests/terminal-pty/relay-contract-lifecycle.test.ts` | 11 | 11 | 0 | 0 | 28 | 0 |
| `tests/terminal-pty/relay-contract.test.ts` | 11 | 11 | 0 | 0 | 43 | 0 |
| `tests/terminal-pty/vectors.test.ts` | 13 | 13 | 0 | 0 | 62 | 2 |
| `tests/unit/agent-profile-mutacion.test.ts` | 4 | 4 | 0 | 0 | 4 | 0 |
| `tests/unit/agent-profile.test.ts` | 21 | 21 | 0 | 0 | 43 | 0 |
| `tests/unit/artifact-egress.test.ts` | 4 | 4 | 0 | 0 | 14 | 0 |
| `tests/unit/auth.test.ts` | 2 | 2 | 0 | 0 | 3 | 0 |
| `tests/unit/base-de-pruebas-guarda.test.ts` | 5 | 5 | 0 | 0 | 7 | 0 |
| `tests/unit/canary-gate.test.ts` | 3 | 3 | 0 | 0 | 9 | 0 |
| `tests/unit/compose-files.test.ts` | 7 | 7 | 0 | 0 | 37 | 7 |
| `tests/unit/compose-healthcheck.test.ts` | 1 | 1 | 0 | 0 | 5 | 1 |
| `tests/unit/composicion-del-perfil.test.ts` | 6 | 6 | 0 | 0 | 12 | 0 |
| `tests/unit/console-browser-storage-policy.test.ts` | 2 | 2 | 0 | 0 | 4 | 0 |
| `tests/unit/dockerfile-runtime-policy.test.ts` | 1 | 1 | 0 | 0 | 8 | 1 |
| `tests/unit/gate-probe-authority.test.ts` | 2 | 2 | 0 | 0 | 6 | 0 |
| `tests/unit/gate-roundtrip-probe.test.ts` | 3 | 3 | 0 | 0 | 19 | 3 |
| `tests/unit/harness-observability.test.ts` | 9 | 9 | 0 | 0 | 27 | 0 |
| `tests/unit/host-backup-monitor.test.ts` | 12 | 12 | 0 | 0 | 39 | 12 |
| `tests/unit/inactive-override-manifest.test.ts` | 3 | 3 | 0 | 0 | 15 | 3 |
| `tests/unit/liveness-probe.test.ts` | 7 | 7 | 0 | 0 | 25 | 0 |
| `tests/unit/message-timeout.test.ts` | 3 | 3 | 0 | 0 | 12 | 0 |
| `tests/unit/migrate-cli-production.test.ts` | 5 | 5 | 0 | 0 | 15 | 0 |
| `tests/unit/migration-gate.test.ts` | 4 | 4 | 0 | 0 | 12 | 0 |
| `tests/unit/observability-alerting.test.ts` | 7 | 7 | 0 | 0 | 40 | 7 |
| `tests/unit/outbox-metrics.test.ts` | 6 | 6 | 0 | 0 | 19 | 0 |
| `tests/unit/paquetes-de-este-arbol.test.ts` | 2 | 2 | 0 | 0 | 3 | 0 |
| `tests/unit/perfil-espejo-sql.test.ts` | 5 | 5 | 0 | 0 | 11 | 5 |
| `tests/unit/physical-fleet-gate.test.ts` | 3 | 3 | 0 | 0 | 6 | 0 |
| `tests/unit/postgres-tls-policy.test.ts` | 1 | 1 | 0 | 0 | 10 | 0 |
| `tests/unit/privacy-identities.test.ts` | 2 | 2 | 0 | 0 | 8 | 2 |
| `tests/unit/protocol-runtime.test.ts` | 3 | 3 | 0 | 0 | 6 | 0 |
| `tests/unit/protocol.test.ts` | 16 | 16 | 0 | 0 | 36 | 0 |
| `tests/unit/provision-terminal-client.test.ts` | 3 | 3 | 0 | 0 | 14 | 3 |
| `tests/unit/readiness-probe.test.ts` | 6 | 6 | 0 | 0 | 28 | 0 |
| `tests/unit/relay-telegram-observability.test.ts` | 2 | 2 | 0 | 0 | 5 | 2 |
| `tests/unit/release-state-metrics.test.ts` | 7 | 7 | 0 | 0 | 17 | 0 |
| `tests/unit/runtime-package-smoke.test.ts` | 6 | 6 | 0 | 0 | 16 | 2 |
| `tests/unit/scheduler.test.ts` | 2 | 2 | 0 | 0 | 2 | 0 |
| `tests/unit/source-digest-closure.test.ts` | 7 | 7 | 0 | 0 | 42 | 6 |
| `tests/unit/stack-health-arguments.test.ts` | 1 | 1 | 0 | 0 | 2 | 0 |
| `tests/unit/terminal-relay-operability.test.ts` | 3 | 3 | 0 | 0 | 24 | 3 |
| `tests/unit/testcontainers-evidence.test.ts` | 2 | 2 | 0 | 0 | 6 | 1 |
| `tests/unit/topes-de-delegacion-editables.test.ts` | 13 | 13 | 0 | 0 | 23 | 4 |
| **TOTAL (353)** | **3644** | **3622** | **8** | **14** | **11699** | **233** |
## Parciales de los 4 subagentes (lectura a mano, conservados como contraste)

`_parcial-dientes-packages.md` · `_parcial-dientes-console.md` · `_parcial-dientes-services.md` · `_parcial-dientes-tests.md`. Los cuatro concluyeron «0 sin dientes»; su clasificación por fichero coincide con la mecánica, y su valor está en el "por qué" de cada fichero, no en los totales.
