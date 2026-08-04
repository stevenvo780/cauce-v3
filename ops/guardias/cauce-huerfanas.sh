#!/usr/bin/env bash
# cauce-huerfanas — qué le pidió una PERSONA a un agente y se perdió sin respuesta.
#
# POR QUÉ EXISTE
# El fallo más caro de este sistema no es que algo se rompa: es que se rompa en silencio. Una
# entrega que muere (`dead`/`failed`) deja al humano esperando una respuesta que no va a llegar, y
# hoy no hay ningún sitio donde eso aparezca. Pablo estuvo NUEVE DÍAS sin una respuesta legible
# porque sus entregas morían por la forma de un campo accesorio, y nadie lo vio hasta que se contó
# a mano en la base.
#
# Esto lista exactamente eso: entregas terminadas mal que llevaban un mensaje con `origin`, es
# decir, escrito por una persona y no por otro agente. Es la lista de "lo que falta contestar".
#
# Uso:  cauce-huerfanas [dias]        (por defecto 7)
#
# Las conversaciones conocidas se traducen a nombre para que no haya que buscar el id a mano.
# Un id desconocido es alguien REAL: averigualo antes de descartarlo.
set -uo pipefail
DIAS=${1:-7}

case "$DIAS" in ''|*[!0-9]*) echo "uso: cauce-huerfanas [dias]" >&2; exit 2;; esac

ssh -o BatchMode=yes agora-storage \
  "docker exec -i cauce-v3-prod-postgres-1 psql -U cauce -d cauce -f -" <<SQL
\pset border 2
\pset format aligned
SELECT
  d.created_at::timestamp(0)                                   AS cuando,
  d.recipient_alias                                            AS agente,
  d.status                                                     AS estado,
  CASE m.origin->>'conversation_id'
    WHEN '6979524541'    THEN 'Steven'
    WHEN '8530844312'    THEN 'Pablo'
    WHEN '7084929277'    THEN 'Jhon'
    WHEN '-1003969325671' THEN 'grupo Miguel'
    ELSE coalesce(m.origin->>'conversation_id','?')
  END                                                          AS quien,
  -- El cuerpo se enmascara ANTES de recortarlo. La gente pega credenciales en el chat: la primera
  -- corrida de esto imprimió una contraseña de Neon en claro en la terminal del operador. Un
  -- listado de diagnóstico no puede ser una vía nueva por la que un secreto sale a un log.
  left(regexp_replace(
         regexp_replace(
           regexp_replace(m.body->>'text', '(://[^:/@\s]+:)[^@\s]+@', '\1***@', 'g'),
           '(?i)(api[_-]?key|token|secret|password|passwd|bearer|npg_|sk-|ghp_)[=:\s"'']*[A-Za-z0-9_\-\.]{6,}',
           '\1***', 'g'),
         '\s+', ' ', 'g'), 90)                                  AS pedido,
  left(coalesce(d.last_error, '-'), 60)                        AS por_que
FROM deliveries d
JOIN messages m ON m.id = d.message_id
WHERE d.status IN ('dead','failed')
  AND d.created_at > now() - interval '$DIAS days'
  AND m.origin->>'conversation_id' IS NOT NULL
ORDER BY d.created_at DESC;
SQL
