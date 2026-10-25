#!/usr/bin/env python3
"""Task evidence and bounded retries for the fleet doctor."""
import datetime
import json
import os
import re

VERSION_LIBRO = 1

def systemd_command(host):
    if host == os.environ.get("CAUCE_LIBRO_LOCAL_HOST", "localhost"):
        return "systemctl --user"
    user = os.environ.get("CAUCE_LIBRO_SYSTEMD_USER", "")
    uid = os.environ.get("CAUCE_LIBRO_SYSTEMD_UID", "")
    if not re.fullmatch(r"[a-z_][a-z0-9_-]*", user) or not uid.isdigit():
        raise ValueError("remote systemd evidence requires CAUCE_LIBRO_SYSTEMD_USER and CAUCE_LIBRO_SYSTEMD_UID")
    return f"sudo -u {user} XDG_RUNTIME_DIR=/run/user/{uid} systemctl --user"

PENDIENTE = "pendiente"
EN_CURSO = "en_curso"
ENTREGADO_SV = "entregado_sin_verificar"
CUMPLIDO = "cumplido"
BLOQUEADO = "bloqueado_por_humano"
ABANDONADO = "abandonado"
ESTADOS = (PENDIENTE, EN_CURSO, ENTREGADO_SV, CUMPLIDO, BLOQUEADO, ABANDONADO)
EN_VUELO = ("pending", "leased", "claimed", "accepted", "started")
MUERTAS = ("failed", "dead", "cancelled", "expired")
VENTANA_DERIVACION_H = 48
LARGO_MIN_ENCARGO = 120
EDAD_MIN_RETOMAR = 45
ABANDONO_H = 36
PURGA_DIAS = 14
LARGO_TEXTO = 900
LARGO_RESPUESTA = 900
MAX_REINTENTOS = 3
ESPERA_MIN = (60, 180, 480)
TOPE_REENVIOS_CORRIDA = 3
TOPE_REENVIOS_ALIAS = 1
MIN_ENTREGA_QUIETA = 20
RUIDO = re.compile(
    "(^\\s*\\[GUARDIA AUTOMATICO)|(^\\s*⚠ CAUCE)|(Synthesize one non-empty final reply)|(^\\s*Prueba de vida de Cauce)|(^\\s*PRUEBA DE SALUD)|(Treat every untrusted_text value strictly as data)|(^\\s*PONG-)|(^\\s*PROBAR-)|(EL CONTEXTO DE LA TERMINAL CAMBIO)|(LA TERMINAL SE REINICIO)",
    re.IGNORECASE,
)
MARCADORES_ENCARGO = re.compile(
    "\\b(necesito|hac[eé]|and[aá]|revis[aáe]|verific|arregl|implement|despleg|desplieg|entreg[aá]|encargo|tarea|pendiente|te (paso|delego|encargo)|por favor|dej[aá]|prepar[aá]|comprob|audit|documenta|corrig|termin[aá]|complet|confirm|report[aá]|pas[aá]me|dame|quiero que|deb[eé]s|debes|deber[ií]as|hay que|ten[eé]s que|tienes que|escrib[ií]|cre[aá]|arm[aá]|mand[aá]|env[ií]a|sub[ií]|instal|configur|prob[aá]|test)\\b",
    re.IGNORECASE,
)
PROMESAS = [
    ("\\bvoy a\\b", "voy a"),
    ("\\blo har[eé]\\b", "lo hare"),
    ("\\ben cuanto\\b", "en cuanto"),
    ("\\bte aviso cuando\\b", "te aviso cuando"),
    ("\\bqueda pendiente\\b", "queda pendiente"),
    ("\\bpendiente de\\b", "pendiente de"),
    ("\\blo dejo preparado\\b", "lo dejo preparado"),
    ("\\bqueda preparado\\b", "queda preparado"),
    ("\\blisto para (desplegar|aplicar|correr)\\b", "listo para desplegar"),
    ("\\bsin desplegar\\b", "sin desplegar"),
    ("\\bno desplegu[eé]\\b", "no desplegue"),
    ("\\bno lo prob[eé]\\b", "no lo probe"),
    ("\\bno pude\\b", "no pude"),
    ("\\bfalta\\b", "falta"),
    ("\\bcuando me confirmes\\b", "cuando me confirmes"),
    ("\\bapenas (pueda|tenga)\\b", "apenas pueda"),
    ("\\bsigo (esperando|sin)\\b", "sigo esperando"),
    ("\\bproximo paso\\b", "proximo paso"),
    ("\\bsegu[ií] (trabajando|con)\\b", "sigo trabajando"),
    ("could not complete", "could not complete"),
    ("requires manual replay", "requires manual replay"),
]
BLOQUEOS = [
    ("(?<!no )(?<!No )\\bnecesit(?:o|a|an|amos) (tu |el |la |su )?(autorizaci[oó]n|ok\\b|confirmaci[oó]n|aprobaci[oó]n|luz verde|permiso|visto bueno)", "necesita autorizacion"),
    ("\\bno tengo (permiso|credencial|acceso|autorizaci[oó]n)", "no tiene acceso"),
    ("\\bes (una )?decisi[oó]n (de|del) (humano|owner|due[nñ]o)", "decision humana"),
    ("\\brequiere (aprobaci[oó]n|autorizaci[oó]n|decisi[oó]n)", "requiere aprobacion"),
    ("\\bespero tu (confirmaci[oó]n|ok\\b|respuesta)", "espera confirmacion"),
    ("\\bno puedo sin\\b", "no puede sin algo"),
    ("\\bhasta que (me )?(des|d[eé]s) el ok", "espera el OK"),
]
operator_name = os.environ.get("CAUCE_LIBRO_OPERATOR_NAME", "")
if operator_name:
    BLOQUEOS.append((r"\bes (una )?decisi[oó]n (de|del) " + re.escape(operator_name) + r"\b", "decision humana"))

SENALES_DE_ENTREGA = re.compile("(?<!no )(?<!sin )\\b(entregad[oa]s?|termin[aá]d[oa]s?|hecho\\b|complet[aá]d[oa]s?|publiqu[eé]|desplegu[eé]|despachad[oa]s?)\\b", re.IGNORECASE)
AFIRMACIONES = [
    ("\\bcommit\\w*[\\s(`]*(?:local[\\s(`]*)?([0-9a-f]{7,40})\\b", "commit"),
    ("\\brama[`\\s]+`?([\\w./-]{2,60})`?", "rama"),
    ("(`(?:/|~/)[\\w./+-]{4,120}`)", "ruta"),
    ("\\b(\\d+/\\d+)\\s+tests?\\b", "tests"),
    ("(https?://[^\\s`)\\]]{6,160})", "url"),
    ("\\b(no lo prob[eé])\\b", "declara no haberlo probado"),
]

def _ahora():
    return datetime.datetime.now(datetime.UTC)

def _dt(s):
    if not s:
        return None
    try:
        t = datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=datetime.UTC)
    return t

def _min(desde, hasta):
    if not desde or not hasta:
        return None
    return (hasta - desde).total_seconds() / 60.0

def _plano(t):
    return re.sub("\\s+", " ", t or "").strip()

def _busca(texto, pares):
    for patron, etiqueta in pares:
        if re.search(patron, texto or "", re.IGNORECASE):
            return (True, etiqueta)
    return (False, "")

def _comparable(t):
    return _plano(t).lower()

def entrega_progresa(d, quieta_min=MIN_ENTREGA_QUIETA):
    lease = d.get("lease_min")
    quieto = d.get("quieto_min")
    if lease is not None and lease <= 0:
        return (False, "la reserva vencio hace %d min: nadie la esta trabajando" % abs(int(lease)))
    if quieto is None:
        return (False, "no se pudo medir si la fila avanza (sin quieto_min): se avisa por las dudas")
    if quieto >= quieta_min:
        return (False, "la fila lleva %d min sin moverse (execution_started_at/updated_at quietos)" % int(quieto))
    return (True, "turno LARGO, no trabado: la fila se movio hace %d min y la reserva sigue viva %s" % (int(quieto), "%d min" % int(lease) if lease is not None else "(sin dato)"))

CONSULTA_ENCARGOS = """
with ventana as (
  select d.id, d.message_id, d.recipient_alias, d.recipient_tenant, d.status, d.attempt,
         d.terminal_at, d.last_error, d.result, d.late_result_at,
         m.actor_alias, m.created_at, m.body
  from deliveries d join messages m on m.id = d.message_id
  where m.created_at > now() - interval '%(ventana_h)d hours'
    and coalesce(m.body->>'type','') in ('agent.message','telegram.message')
    and length(coalesce(m.body->>'text','')) >= %(largo_min)d
),
cierres as materialized (
  select d3.recipient_tenant as tenant, d3.recipient_alias as alias,
         m3.id as mid, m3.created_at as creado,
         coalesce(m3.body->>'text','') as texto
  from deliveries d3 join messages m3 on m3.id = d3.message_id
  where d3.status = 'done'
    and m3.created_at > (select min(coalesce(v0.terminal_at, v0.created_at)) from ventana v0)
)
select json_build_object(
  'encargo_id', v.id,
  'message_id', v.message_id,
  'solicitante', v.actor_alias,
  'responsable', v.recipient_alias,
  'tenant', v.recipient_tenant,
  'tipo_mensaje', coalesce(v.body->>'type',''),
  'estado_entrega', v.status,
  'intento_entrega', v.attempt,
  'pedido_en', to_char(v.created_at at time zone 'UTC','YYYY-MM-DD') || 'T' ||
               to_char(v.created_at at time zone 'UTC','HH24:MI:SS+00:00'),
  'cerrado_en', to_char(v.terminal_at at time zone 'UTC','YYYY-MM-DD') || 'T' ||
                to_char(v.terminal_at at time zone 'UTC','HH24:MI:SS+00:00'),
  'ultimo_error', left(coalesce(v.last_error,''), 300),
  'texto', left(coalesce(v.body->>'text',''), %(largo_texto)d),
  'respuesta', left(coalesce(v.result->'output'->>'reply',''), %(largo_respuesta)d),
  'resultado_tardio', (v.late_result_at is not null),
  'retomado_por_mensaje_nuevo', exists (
    select 1 from cierres c
    where c.tenant = v.recipient_tenant
      and (c.alias = v.recipient_alias or c.alias = v.actor_alias)
      and c.mid <> v.message_id
      and c.creado > coalesce(v.terminal_at, v.created_at)
      and position(left(v.id::text, 8) in c.texto) > 0
  ),
  'reintento_exitoso', exists (
    select 1
    from audit_events ae
    join deliveries d2 on d2.message_id = ae.message_id
    where ae.action = 'delivery.replay'
      and (ae.metadata->>'replayed_from_message_id') = v.message_id::text
      and d2.recipient_tenant = v.recipient_tenant
      and d2.recipient_alias = v.recipient_alias
      and d2.status = 'done'
  )
)::text
from ventana v
order by v.created_at
"""

def consulta(ventana_h=VENTANA_DERIVACION_H):
    return CONSULTA_ENCARGOS % {"ventana_h": ventana_h, "largo_min": LARGO_MIN_ENCARGO, "largo_texto": LARGO_TEXTO, "largo_respuesta": LARGO_RESPUESTA}

def leer_filas(sql):
    filas = []
    for f in sql(consulta()):
        crudo = "~".join(f).strip()
        if not crudo:
            continue
        try:
            filas.append(json.loads(crudo))
        except Exception:
            continue
    return filas

def es_encargo(fila):
    texto = _plano(fila.get("texto"))
    if len(texto) < LARGO_MIN_ENCARGO:
        return (False, "demasiado corto")
    if RUIDO.search(texto):
        return (False, "trafico de maquina, no un encargo")
    if not MARCADORES_ENCARGO.search(texto):
        return (False, "no pide nada: es un informe o una conversacion")
    return (True, "")

def quien_pidio(fila):
    if fila.get("tipo_mensaje") == "telegram.message" and fila.get("solicitante") == fila.get("responsable"):
        return "humano:%s" % (fila.get("tenant") or "?")
    return fila.get("solicitante") or "?"

def afirmaciones(respuesta):
    out = []
    for patron, etiqueta in AFIRMACIONES:
        for m in re.finditer(patron, respuesta or "", re.IGNORECASE):
            valor = _plano(m.group(1) if m.groups() else m.group(0))[:120]
            if valor and {"clase": etiqueta, "valor": valor} not in out:
                out.append({"clase": etiqueta, "valor": valor})
        if len(out) >= 8:
            break
    return out[:8]

def clasificar(enc, verificaciones, ahora=None):
    ahora = ahora or _ahora()
    estado_e = (enc.get("estado_entrega") or "").lower()
    respuesta = enc.get("respuesta") or ""
    pedido = _dt(enc.get("pedido_en"))
    edad_h = (ahora - pedido).total_seconds() / 3600.0 if pedido else 0.0
    if int(enc.get("reintentos", 0)) >= MAX_REINTENTOS:
        return (BLOQUEADO, "se reintento %d veces y sigue sin evidencia de cumplimiento: necesita una persona" % int(enc.get("reintentos", 0)))
    if verificaciones and all(v.get("ok") is True for v in verificaciones):
        return (
            CUMPLIDO,
            "%d evidencia(s) esperada(s) COMPROBADAS pese a que la entrega quedo en '%s': el transporte murio, el trabajo no. %s"
            % (len(verificaciones), estado_e or "sin estado", "; ".join(v.get("detalle", "") for v in verificaciones)[:280]),
        )
    if estado_e in EN_VUELO:
        return (EN_CURSO, "la entrega sigue en '%s' (intento %s)" % (estado_e, enc.get("intento_entrega")))
    if estado_e in MUERTAS:
        if enc.get("reintento_exitoso"):
            return (
                ENTREGADO_SV,
                "la entrega murio en '%s' (intento %s), pero un reintento posterior (delivery.replay) para el mismo destinatario cerro en 'done': no se vuelve a reclamar ni se avisa, pero tampoco se da por cumplido sin evidencia declarada y comprobada"
                % (estado_e, enc.get("intento_entrega")),
            )
        if enc.get("retomado_por_mensaje_nuevo"):
            return (
                ENTREGADO_SV,
                "la entrega murio en '%s' (intento %s), pero DESPUES otro mensaje que cita este encargo llego al mismo destinatario y cerro en 'done': alguien lo retomo por reinyeccion manual (mensaje nuevo, no delivery.replay), asi que se deja de reclamar; no se da por cumplido sin evidencia comprobada"
                % (estado_e, enc.get("intento_entrega")),
            )
        if not respuesta.strip():
            if enc.get("resultado_tardio"):
                return (ENTREGADO_SV, "la entrega murio en '%s' pero late_result_at esta poblado: el resultado llego tarde, sin texto legible para comprobar mas" % estado_e)
            if edad_h >= ABANDONO_H:
                return (ABANDONADO, "la entrega murio en '%s' hace %.0f h y nadie la retomo: insistir ahora es ruido" % (estado_e, edad_h))
            if "exceeded its execution deadline" in (_plano(enc.get("ultimo_error")) or ""):
                return (
                    PENDIENTE,
                    "la entrega murio por DEADLINE (intento %s). El harness seguia trabajando: el estado de terminacion es DESCONOCIDO y el trabajo puede estar hecho con la respuesta varada en el panel del alias. COMPROBAR el panel antes de reinyectar -- `tmux -L cauce capture-pane -p -t cauce-<alias>:agente` -- porque un replay a ciegas repite el trabajo entero y, si el encargo tocaba produccion, lo aplica dos veces. %s"
                    % (enc.get("intento_entrega"), _plano(enc.get("ultimo_error"))[:160] or "sin last_error"),
                )
            return (PENDIENTE, "la entrega murio en '%s' (intento %s): el trabajo NO se hizo. %s" % (estado_e, enc.get("intento_entrega"), _plano(enc.get("ultimo_error"))[:160] or "sin last_error"))
    elif estado_e != "done":
        return (EN_CURSO, "estado de entrega no reconocido: '%s'" % estado_e)
    desc_cierre = "cerro en 'done'" if estado_e == "done" else "murio en '%s' pero dejo una respuesta real" % estado_e
    if not respuesta.strip():
        return (ENTREGADO_SV, "la entrega %s pero no dejo respuesta legible: no hay nada que permita creer que se hizo" % desc_cierre)
    hay_bloqueo, marca = _busca(respuesta, BLOQUEOS)
    if hay_bloqueo and (not SENALES_DE_ENTREGA.search(respuesta)):
        return (BLOQUEADO, "la respuesta pide una decision humana (%s)" % marca)
    if verificaciones:
        malas = [v for v in verificaciones if v.get("ok") is not True]
        if not malas:
            return (CUMPLIDO, "%d evidencia(s) esperada(s) COMPROBADAS: %s" % (len(verificaciones), "; ".join(v.get("detalle", "") for v in verificaciones)[:300]))
        return (ENTREGADO_SV, "evidencia esperada sin comprobar o fallida: %s" % "; ".join("%s -> %s" % (v.get("tipo"), v.get("detalle")) for v in malas)[:300])
    hay_promesa, marca = _busca(respuesta, PROMESAS)
    if hay_promesa:
        return (ENTREGADO_SV, "la entrega %s pero la respuesta promete trabajo futuro o declara que falta algo ('%s')" % (desc_cierre, marca))
    return (ENTREGADO_SV, "la entrega %s con una respuesta que suena terminada, pero nadie declaro que evidencia esperar: no se puede afirmar que este hecho" % desc_cierre)

def reglas_evidencia(ruta):
    try:
        with open(ruta, encoding="utf-8") as f:
            d = json.load(f)
    except Exception:
        return {"por_encargo": {}, "reglas": []}
    if not isinstance(d, dict):
        return {"por_encargo": {}, "reglas": []}
    return {"por_encargo": d.get("por_encargo") or {}, "reglas": d.get("reglas") or []}

def evidencia_esperada(enc, reglas):
    directa = reglas.get("por_encargo", {}).get(enc.get("encargo_id"))
    if directa:
        return list(directa)
    salida = []
    for r in reglas.get("reglas", []):
        cuando = r.get("cuando") or {}
        if cuando.get("responsable") and cuando["responsable"] != enc.get("responsable"):
            continue
        if cuando.get("solicitante") and cuando["solicitante"] != enc.get("solicitante"):
            continue
        pat = cuando.get("texto_contiene")
        if pat and (not re.search(pat, enc.get("texto") or "", re.IGNORECASE)):
            continue
        if not cuando:
            continue
        for e in r.get("espera") or []:
            item = dict(e)
            item["regla"] = r.get("nombre", "sin nombre")
            salida.append(item)
    return salida

def verificar(esperada, io):
    tipo = esperada.get("tipo")
    try:
        if tipo == "respuesta_contiene":
            pat = esperada.get("patron") or ""
            ok = bool(re.search(pat, io.get("respuesta") or "", re.IGNORECASE))
            return {"tipo": tipo, "ok": ok, "detalle": "la respuesta %s el patron %r" % ("contiene" if ok else "NO contiene", pat)}
        if tipo == "archivo":
            host, ruta = (esperada.get("host"), esperada.get("ruta"))
            ctr = esperada.get("contenedor")
            orden = "stat -c '%%s' " + "'%s'" % ruta
            if ctr:
                orden = "docker exec -i %s sh -c \"stat -c '%%s' '%s'\"" % (ctr, ruta)
            rc, out, err = io["sh"](host, orden)
            if rc != 0:
                return {"tipo": tipo, "ok": False, "detalle": "no existe %s en %s (%s)" % (ruta, ctr or host, _plano(err)[:80])}
            return {"tipo": tipo, "ok": True, "detalle": "%s existe en %s (%s bytes)" % (ruta, ctr or host, out.strip())}
        if tipo == "commit":
            host, repo = (esperada.get("host"), esperada.get("repo"))
            rama = esperada.get("rama") or "HEAD"
            aguja = esperada.get("contiene") or ""
            ctr = esperada.get("contenedor")
            orden = "git -C '%s' log --oneline -40 '%s'" % (repo, rama)
            if ctr:
                orden = "docker exec -i %s sh -c %s" % (ctr, json.dumps(orden))
            rc, out, _ = io["sh"](host, orden)
            if rc != 0:
                return {"tipo": tipo, "ok": False, "detalle": "no se pudo leer %s#%s" % (repo, rama)}
            ok = aguja.lower() in out.lower() if aguja else bool(out.strip())
            return {"tipo": tipo, "ok": ok, "detalle": "%s#%s %s %r" % (repo, rama, "tiene" if ok else "NO tiene", aguja)}
        if tipo == "unidad_activa":
            host, unidad = (esperada.get("host"), esperada.get("unidad"))
            base = systemd_command(host)
            rc, out, _ = io["sh"](host, "%s is-active %s" % (base, unidad))
            estado = out.strip()
            _, pid_out, _ = io["sh"](host, "%s show %s -p MainPID --value" % (base, unidad))
            pid = _plano(pid_out)
            vivo = pid.isdigit() and int(pid) > 0
            ok = estado == "active" and vivo
            return {"tipo": tipo, "ok": ok, "detalle": "%s: is-active=%s MainPID=%s" % (unidad, estado or "?", pid or "?")}
        if tipo == "sql_no_vacio":
            filas = io["sql"](esperada.get("consulta") or "select 1 where false")
            ok = bool([f for f in filas if any(str(x).strip() for x in f)])
            return {"tipo": tipo, "ok": ok, "detalle": "la consulta devolvio %d fila(s)" % len(filas)}
        return {"tipo": tipo or "?", "ok": None, "detalle": "tipo de evidencia desconocido"}
    except Exception as e:
        return {"tipo": tipo or "?", "ok": None, "detalle": "no se pudo comprobar: %s: %s" % (type(e).__name__, str(e)[:120])}

def libro_vacio():
    return {"version": VERSION_LIBRO, "actualizado": None, "encargos": {}}

def cargar(ruta):
    try:
        with open(ruta, encoding="utf-8") as f:
            d = json.load(f)
        if isinstance(d, dict) and isinstance(d.get("encargos"), dict):
            return d
    except Exception:
        pass
    return libro_vacio()

def guardar(ruta, libro):
    tmp = ruta + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(libro, f, ensure_ascii=False, indent=1, sort_keys=True)
    os.replace(tmp, ruta)

def fusionar(libro, filas, ahora=None):
    ahora = ahora or _ahora()
    nuevos, descartados = (0, 0)
    for fila in filas:
        ok, _motivo = es_encargo(fila)
        if not ok:
            descartados += 1
            continue
        eid = fila.get("encargo_id")
        if not eid:
            continue
        prev = libro["encargos"].get(eid) or {}
        enc = dict(prev)
        enc.update(
            {
                "encargo_id": eid,
                "message_id": fila.get("message_id"),
                "solicitante": quien_pidio(fila),
                "responsable": fila.get("responsable"),
                "tenant": fila.get("tenant"),
                "pedido_en": fila.get("pedido_en"),
                "cerrado_en": fila.get("cerrado_en"),
                "estado_entrega": fila.get("estado_entrega"),
                "intento_entrega": fila.get("intento_entrega"),
                "ultimo_error": _plano(fila.get("ultimo_error"))[:300],
                "texto": _plano(fila.get("texto"))[:LARGO_TEXTO],
                "respuesta": _plano(fila.get("respuesta"))[:LARGO_RESPUESTA],
                "resultado_tardio": bool(fila.get("resultado_tardio")),
                "reintento_exitoso": bool(fila.get("reintento_exitoso")),
                "retomado_por_mensaje_nuevo": bool(fila.get("retomado_por_mensaje_nuevo")),
            }
        )
        enc.setdefault("reintentos", 0)
        enc.setdefault("ultimo_intento", None)
        enc.setdefault("proximo_intento_no_antes_de", None)
        enc.setdefault("avisado_bloqueo", False)
        enc.setdefault("visto_por_primera_vez", ahora.isoformat())
        if not prev:
            nuevos += 1
        libro["encargos"][eid] = enc
    libro["actualizado"] = ahora.isoformat()
    return (libro, nuevos, descartados)

def purgar(libro, ahora=None, dias=PURGA_DIAS):
    ahora = ahora or _ahora()
    fuera = []
    for eid, e in list(libro["encargos"].items()):
        t = _dt(e.get("pedido_en")) or _dt(e.get("visto_por_primera_vez"))
        if t and (ahora - t).days > dias:
            fuera.append(eid)
            del libro["encargos"][eid]
    return fuera

def resumen(libro):
    cuenta = {e: 0 for e in ESTADOS}
    for e in libro["encargos"].values():
        cuenta[e.get("estado", ENTREGADO_SV)] = cuenta.get(e.get("estado", ENTREGADO_SV), 0) + 1
    return cuenta

def retomable(enc):
    if enc.get("reinyeccion_posterior"):
        return (False, "")
    estado = enc.get("estado")
    if estado == PENDIENTE:
        return (True, "la entrega murio y el trabajo nunca se hizo")
    if estado == ENTREGADO_SV and enc.get("promesa"):
        return (True, "cerro prometiendo trabajo que no se comprobo")
    return (False, "")

MARCAS_BLOQUEO_ACCESO = (
    ("depende de una[s]? persona", "lo dice con todas las letras"),
    ("m[aá]rca(?:lo|la|melo)? +bloquead", "pide que se marque bloqueado"),
    ("\\bno tengo +(?:el +|la +|los +|las +|un +|una +)?(?:acceso|permiso|credencial|clave|token|llave|ssh)", "declara que no tiene el acceso"),
    (
        "\\b(?:me +falta[n]?|falta[n]?|necesito) +(?:que +me +\\w+ +)?(?:el +|la +|los +|las +|un +|una +)?(?:acceso|credencial(?:es)?|permiso(?:s)?|clave|token|llave|pubkey|secreto(?:s)?)",
        "declara que le falta el acceso",
    ),
    ("no est[aá] +(?:en mi contenedor|montad|provisionad)", "el material no esta en su maquina"),
    ("no puedo +(?:leer|tocar|acceder|entrar|clonar|llegar)", "declara que no puede llegar al material"),
    ("requiere[n]? +(?:luz verde|autorizaci[oó]n|aprobaci[oó]n) +de", "necesita una autorizacion humana"),
    ("ssh imposible|no resuelve.{0,20}ssh", "no alcanza el host"),
)
RE_ERROR_DE_INFRA = re.compile("^\\s*(?:harness |previous harness |a harness |ack timeout|adaptererror|gatewayclient|fallbacksummaryerror|error:|traceback|\\(node:|node:)", re.I)
LARGO_MIN_DECLARACION = 200

def bloqueado_por_acceso(texto):
    t = _plano(texto or "")
    if not t or len(t) < LARGO_MIN_DECLARACION or RE_ERROR_DE_INFRA.match(t):
        return (False, "")
    for patron, motivo in MARCAS_BLOQUEO_ACCESO:
        if re.search(patron, t, re.IGNORECASE):
            return (True, motivo)
    return (False, "")

def espera_minutos(reintentos):
    if reintentos < len(ESPERA_MIN):
        return ESPERA_MIN[reintentos]
    return ESPERA_MIN[-1]

def plan_reanudacion(libro, ctx):
    ahora = ctx["ahora"]
    online = set(ctx.get("online") or ())
    en_vuelo = set(ctx.get("en_vuelo") or ())
    reenviar, bloquear, saltados = ([], [], [])
    ya_en_esta_corrida = set()
    por_alias = {}

    def orden(par):
        e = par[1]
        return (0 if e.get("estado") == PENDIENTE else 1, e.get("pedido_en") or "")

    for eid, e in sorted(libro["encargos"].items(), key=orden):
        ok, motivo = retomable(e)
        if not ok:
            continue
        bloqueo, por_que = bloqueado_por_acceso(e.get("ultimo_error"))
        if bloqueo:
            saltados.append({"encargo_id": eid, "razon": "bloqueado por falta de acceso (%s): reintentar seria pegarle al vacio; necesita una persona" % por_que})
            continue
        reint = int(e.get("reintentos", 0))
        if reint >= MAX_REINTENTOS:
            if not e.get("avisado_bloqueo"):
                bloquear.append({"encargo_id": eid, "responsable": e.get("responsable"), "motivo": "%d reintentos sin cumplirse" % reint})
            saltados.append({"encargo_id": eid, "razon": "tope de reintentos alcanzado (%d)" % reint})
            continue
        if eid in ya_en_esta_corrida:
            saltados.append({"encargo_id": eid, "razon": "ya se reenvio en esta corrida"})
            continue
        pedido = _dt(e.get("pedido_en"))
        if pedido and (ahora - pedido).total_seconds() / 3600.0 >= ABANDONO_H:
            saltados.append({"encargo_id": eid, "razon": "mas viejo que %d h" % ABANDONO_H})
            continue
        prox = _dt(e.get("proximo_intento_no_antes_de"))
        if prox and ahora < prox:
            faltan = _min(ahora, prox) or 0
            saltados.append({"encargo_id": eid, "razon": "espera creciente: faltan %d min" % int(faltan)})
            continue
        if e.get("estado") == ENTREGADO_SV:
            cerrado = _dt(e.get("cerrado_en"))
            m = _min(cerrado, ahora)
            if m is not None and m < EDAD_MIN_RETOMAR:
                saltados.append({"encargo_id": eid, "razon": "cerro hace %d min: se le da margen hasta %d" % (int(m), EDAD_MIN_RETOMAR)})
                continue
        resp = e.get("responsable")
        if resp not in online:
            saltados.append({"encargo_id": eid, "razon": "%s no esta online: reenviar seria pegarle al vacio" % resp})
            continue
        if resp in en_vuelo:
            saltados.append({"encargo_id": eid, "razon": "%s tiene entrega en vuelo: apilarle otra le mata la que esta haciendo" % resp})
            continue
        if por_alias.get(resp, 0) >= TOPE_REENVIOS_ALIAS:
            saltados.append({"encargo_id": eid, "razon": "%s ya recibio su empujon de esta corrida" % resp})
            continue
        if len(reenviar) >= TOPE_REENVIOS_CORRIDA:
            saltados.append({"encargo_id": eid, "razon": "tope de %d reenvios por corrida" % TOPE_REENVIOS_CORRIDA})
            continue
        ya_en_esta_corrida.add(eid)
        por_alias[resp] = por_alias.get(resp, 0) + 1
        reenviar.append(
            {
                "encargo_id": eid,
                "responsable": resp,
                "tenant": e.get("tenant"),
                "solicitante": e.get("solicitante"),
                "intento": reint + 1,
                "motivo": motivo,
                "texto": e.get("texto"),
                "pedido_en": e.get("pedido_en"),
            }
        )
    return {"reenviar": reenviar, "bloquear": bloquear, "saltados": saltados}

RECORDATORIO_PARALELO = "RECORDATORIO PERMANENTE: no ejecutes tú, ORQUESTA. Antes de tocar cualquier herramienta, pregúntate si esto lo puede hacer un lane en paralelo. Casi siempre si."

def texto_reintento(item):
    quien = item.get("solicitante") or "?"
    return "\n".join(
        [
            "RETOMANDO UN ENCARGO SIN CUMPLIR (reintento %d de %d, automatico)." % (item["intento"], MAX_REINTENTOS),
            "Lo pidio %s el %s y quedo sin evidencia de que se hiciera: %s." % (quien, item.get("pedido_en") or "?", item.get("motivo")),
            "",
            "Si YA lo hiciste, contesta con la EVIDENCIA concreta (ruta, commit, unidad, salida) y",
            "esto deja de insistir. Si no lo hiciste, hazlo ahora. Si depende de una persona,",
            "dilo con esas palabras y se marca como bloqueado y deja de volver.",
            "",
            RECORDATORIO_PARALELO,
            "",
            "--- ENCARGO ORIGINAL ---",
            item.get("texto") or "(sin texto)",
        ]
    )

def aplicar_reenvio(libro, eid, ok, ahora, detalle=""):
    e = libro["encargos"].get(eid)
    if not e:
        return
    e["reintentos"] = int(e.get("reintentos", 0)) + 1
    e["ultimo_intento"] = ahora.isoformat()
    e["ultimo_intento_ok"] = bool(ok)
    e["ultimo_intento_detalle"] = _plano(detalle)[:200]
    e["proximo_intento_no_antes_de"] = (ahora + datetime.timedelta(minutes=espera_minutos(e["reintentos"]))).isoformat()
    if e["reintentos"] >= MAX_REINTENTOS:
        e["estado"] = BLOQUEADO
        e["motivo_estado"] = "se reintento %d veces sin evidencia de cumplimiento: necesita una persona" % e["reintentos"]

def marcar_avisado(libro, eid):
    e = libro["encargos"].get(eid)
    if e:
        e["avisado_bloqueo"] = True
        e["estado"] = BLOQUEADO

def render_md(libro, ahora=None):
    ahora = ahora or _ahora()
    cuenta = resumen(libro)
    lines = [
        "# Libro de tareas del medico — Cauce V3",
        "",
        "Generado por `cauce-v3-medico-monitor` el %s UTC. **No se edita a mano**: se deriva" % ahora.strftime("%Y-%m-%d %H:%M"),
        "de `deliveries`/`messages` en cada corrida. Lo unico manual es `evidencia-esperada.json`.",
        "",
        "**entregado** = la entrega cerro. **cumplido** = el trabajo esta hecho Y comprobado.",
        "Lo que no se pudo comprobar dice `entregado_sin_verificar`, nunca `cumplido`.",
        "",
        "## Cuentas",
        "",
    ]
    for est in ESTADOS:
        lines.append("- **%s**: %d" % (est, cuenta.get(est, 0)))
    lines.append("")
    orden = {PENDIENTE: 0, BLOQUEADO: 1, EN_CURSO: 2, ENTREGADO_SV: 3, CUMPLIDO: 4, ABANDONADO: 5}
    encs = sorted(libro["encargos"].values(), key=lambda e: (orden.get(e.get("estado"), 9), e.get("responsable") or "", e.get("pedido_en") or ""))
    estado_actual = None
    for e in encs:
        if e.get("estado") != estado_actual:
            estado_actual = e.get("estado")
            lines += ["", "## %s" % estado_actual, ""]
        lines.append("### %s -> %s  (%s)" % (e.get("solicitante"), e.get("responsable"), e.get("pedido_en")))
        lines.append("- encargo: `%s`" % e.get("encargo_id"))
        lines.append("- entrega: `%s` (intento %s)" % (e.get("estado_entrega"), e.get("intento_entrega")))
        lines.append("- por que: %s" % e.get("motivo_estado", ""))
        esp = e.get("evidencia_esperada") or []
        lines.append("- evidencia esperada: %s" % (json.dumps(esp, ensure_ascii=False) if esp else "**NINGUNA DECLARADA** — por eso no puede llegar a `cumplido`"))
        obs = e.get("evidencia_observada") or []
        lines.append("- evidencia observada: %s" % (json.dumps(obs, ensure_ascii=False)[:400] if obs else "-"))
        lines.append("- reintentos: %s | ultimo intento: %s" % (e.get("reintentos", 0), e.get("ultimo_intento") or "-"))
        lines.append("- pedido: %s" % (e.get("texto") or "")[:280])
        if e.get("respuesta"):
            lines.append("- respondio: %s" % e["respuesta"][:280])
        lines.append("")
    return "\n".join(lines) + "\n"

UMBRAL_SIMILITUD_REINYECCION = LARGO_MIN_ENCARGO

def reinyeccion_posterior(enc, encargos):
    propio_id = enc.get("encargo_id")
    propio_alias = enc.get("responsable")
    propio_pedido = _dt(enc.get("pedido_en"))
    propio_texto = _comparable(enc.get("texto"))
    if not propio_alias or not propio_pedido or len(propio_texto) < UMBRAL_SIMILITUD_REINYECCION:
        return (None, "")
    candidatos = []
    for eid, otro in (encargos or {}).items():
        if eid == propio_id or otro is enc:
            continue
        if otro.get("responsable") != propio_alias:
            continue
        otro_pedido = _dt(otro.get("pedido_en"))
        if not otro_pedido or otro_pedido <= propio_pedido:
            continue
        estado_e = (otro.get("estado_entrega") or "").lower()
        if estado_e not in EN_VUELO and estado_e != "done":
            continue
        otro_texto = _comparable(otro.get("texto"))
        if len(otro_texto) < UMBRAL_SIMILITUD_REINYECCION:
            continue
        if propio_texto in otro_texto or otro_texto in propio_texto:
            candidatos.append((otro_pedido, eid, estado_e))
    if not candidatos:
        return (None, "")
    candidatos.sort(key=lambda c: c[0])
    _, eid_encontrado, estado_e = candidatos[0]
    return (
        eid_encontrado,
        "hay una entrega POSTERIOR (%s, estado '%s') hacia %s con texto suficientemente parecido: el trabajo ya se esta haciendo o ya se hizo bajo otro id; reclamar este fabricaria un duplicado"
        % (eid_encontrado[:8], estado_e, propio_alias),
    )

def actualizar(libro, reglas, io, ahora=None):
    ahora = ahora or _ahora()
    for enc in libro["encargos"].values():
        esperada = evidencia_esperada(enc, reglas)
        enc["evidencia_esperada"] = esperada
        io_enc = dict(io)
        io_enc["respuesta"] = enc.get("respuesta") or ""
        verificaciones = [verificar(e, io_enc) for e in esperada]
        observada = list(verificaciones)
        for a in afirmaciones(enc.get("respuesta")):
            observada.append({"tipo": a["clase"], "ok": None, "detalle": a["valor"], "origen": "afirmado por el agente, SIN comprobar"})
        enc["evidencia_observada"] = observada
        hay_promesa, marca = _busca(enc.get("respuesta"), PROMESAS)
        enc["promesa"] = bool(hay_promesa)
        enc["promesa_marca"] = marca
        estado, motivo = clasificar(enc, verificaciones, ahora)
        reinyeccion_id = None
        if estado == PENDIENTE or (estado == ENTREGADO_SV and enc.get("promesa")):
            reinyeccion_id, motivo_reiny = reinyeccion_posterior(enc, libro["encargos"])
            if reinyeccion_id:
                motivo = "%s NO SE RECLAMA: %s" % (motivo, motivo_reiny)
        enc["reinyeccion_posterior"] = reinyeccion_id
        enc["estado"] = estado
        enc["motivo_estado"] = motivo
    return libro

SOLAPES = {"encargo_sin_hacer": ("trabajo_perdido", "bloqueado_por_acceso", "entrega_trabada", "adaptador_caido", "sin_adaptador", "adaptador_huerfano"), "encargo_bloqueado": ()}

def hallazgos_libro(libro):
    por = {}
    for eid, e in sorted(libro["encargos"].items()):
        estado = e.get("estado")
        if estado == BLOQUEADO and (not e.get("avisado_bloqueo")):
            tipo = "encargo_bloqueado"
        elif estado == PENDIENTE and (not e.get("reinyeccion_posterior")):
            tipo = "encargo_sin_hacer"
        else:
            continue
        clave = (tipo, e.get("responsable") or "-")
        por.setdefault(clave, []).append((eid, e))
    salida = []
    for (tipo, alias), pares in sorted(por.items()):
        ejemplos = []
        for eid, e in pares[:3]:
            ejemplos.append("- [%s] lo pidio %s: %s\n    -> %s" % (eid[:8], e.get("solicitante"), (e.get("texto") or "")[:180], e.get("motivo_estado", "")[:180]))
        detalle = "%d encargo(s) %s de %s: la ENTREGA cerro o murio pero el TRABAJO no esta hecho" % (len(pares), "bloqueado(s) por una persona" if tipo == "encargo_bloqueado" else "sin hacer", alias)
        salida.append(
            {
                "tipo": tipo,
                "alias": alias,
                "detalle": detalle,
                "encargos": [eid for eid, _ in pares],
                "evidencia": {"libro de tareas": os.environ.get("CAUCE_LIBRO_LOCATION", "libro-tareas.md"), "encargos (hasta 3)": "\n".join(ejemplos)},
            }
        )
    return salida

def fusionar_hallazgos(escalar, del_libro):
    nuevos, fusionados = ([], [])
    for h in del_libro:
        solapa = SOLAPES.get(h["tipo"], ())
        destino = None
        for e in escalar:
            if e.get("tipo") in solapa and e.get("alias") == h["alias"]:
                destino = e
                break
        if destino is None:
            nuevos.append(h)
            continue
        ev = destino.setdefault("evidencia", {})
        ev["libro de tareas (mismo sintoma, no se avisa aparte)"] = "%s\n%s" % (h["detalle"], h["evidencia"].get("encargos (hasta 3)", ""))
        fusionados.append({"tipo": h["tipo"], "alias": h["alias"], "dentro_de": destino.get("tipo")})
    escalar.extend(nuevos)
    return (nuevos, fusionados)

def correr(io, rutas, ahora=None):
    ahora = ahora or _ahora()
    libro = cargar(rutas["libro"])
    filas = leer_filas(io["sql"])
    libro, nuevos, descartados = fusionar(libro, filas, ahora)
    purgados = purgar(libro, ahora)
    reglas = reglas_evidencia(rutas["evidencia"])
    actualizar(libro, reglas, io, ahora)
    plan = plan_reanudacion(libro, {"ahora": ahora, "online": io.get("online") or set(), "en_vuelo": io.get("en_vuelo") or set()})
    reenviados = []
    for item in plan["reenviar"] if io.get("reenviar", True) else []:
        ok, det = io["publicar"](item.get("tenant"), item["responsable"], texto_reintento(item), "retomar-%s" % item["encargo_id"])
        aplicar_reenvio(libro, item["encargo_id"], ok, ahora, det)
        reenviados.append({"encargo_id": item["encargo_id"], "alias": item["responsable"], "intento": item["intento"], "ok": ok, "detalle": det[:160], "motivo": item["motivo"]})
    hall = hallazgos_libro(libro)
    for h in hall:
        if h["tipo"] != "encargo_bloqueado":
            continue
        for eid in h["encargos"]:
            marcar_avisado(libro, eid)
    guardar(rutas["libro"], libro)
    try:
        with open(rutas["md"], "w", encoding="utf-8") as f:
            f.write(render_md(libro, ahora))
    except Exception:
        pass
    return {
        "libro": libro,
        "hallazgos": hall,
        "reenviados": reenviados,
        "plan": plan,
        "cuentas": resumen(libro),
        "nuevos": nuevos,
        "descartados": descartados,
        "purgados": len(purgados),
        "total": len(libro["encargos"]),
    }
