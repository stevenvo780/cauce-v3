# Plan de implementación del buzón cliente

1. Codex implementa resolución durable y publicación en store, sin migraciones ni cambios de credenciales.
2. Codex extiende protocolo e inventario bajo capability; implementa lectura autenticada y cursor en gateway/MCP.
3. Claude Sonnet adapta sólo adapter-sdk: capacidades, proyección, parser y emisión. Mantiene broadcast dirigido a agentes.
4. Gemini adapta sólo console: etiqueta del destinatario y «Guardado en buzón» sin atribuir ejecución.
5. Codex añade pruebas PostgreSQL de efectos, aislamiento, revocación, idempotencia y límites. Cada escritor ejecuta pruebas focales.
6. Claude revisa diffs ajenos. Codex corrige y obtiene revisión nueva si cambia el alcance relevante.
7. Codex publica commits por rutas propias, máximo 20 ficheros, con evidencia explícita.
8. Ejecuta typecheck, lint, unit, gate completo y gates de release sobre el SHA exacto; conserva logs sellados en un directorio nuevo.
9. Integra y despliega según la autorización de Steven, verificando preflight fresco, rollback y canary de SDK sin entregas activas.
10. Prueba ambos sentidos en producción y registra evidencia e historial; comunica el límite de activación automática de ChatGPT.
