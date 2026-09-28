# ruff: noqa: F821
"""Repairs, verdicts and dispatch of cauce-v3-medico-monitor, sourced into its namespace.

Sourced by the entrypoint with exec() in module globals (like bash `source`),
so every name here resolves exactly as before the split. Not imported directly.
"""


def es_supervisor_no_puente(cmdline):
    """True if a cmdline that otherwise matches RE_PUENTE/RE_PUENTE_NATIVO is actually the
    adapter's OWN host-side wrapper -- a `docker exec` client, or anything else carrying its
    `cauce-container-runtime.py run --alias` signature -- and NOT the turn bridge itself.

    A wrapper's cmdline can legitimately embed a bridge path as one of its OWN arguments
    (it is what tells `docker exec` which program to run inside the container); that alone
    is not proof it IS the bridge. This is what RE_PUENTE's unanchored `.search()` cannot
    tell apart on its own.
    """
    return bool(RE_CLIENTE_DOCKER_EXEC.search(cmdline) or RE_ADAPTADOR.search(cmdline))


def matar_por_pid(host, pid, args_esperados, contenedor=None, alias=None):
    """Kill ONE process by PID, reconfirming its identity just before. Never by name.

    Refuses ANY host PID that is the adapter's own wrapper (see `es_supervisor_no_puente`):
    that is the whole adapter connection, never the stuck turn. When the alias's container
    is known, the search and the kill both move INSIDE it (`docker exec <c> ...`), by a PID
    read from the container's own process table -- never the host's -- and scoped to `alias`.
    """
    rc, out, _ = sh(host, f"tr '\\0' ' ' < /proc/{pid}/cmdline 2>/dev/null", timeout=30)
    if rc != 0 or not out.strip():
        return False, "el proceso ya no existe"
    if not RE_PUENTE.search(out) and not RE_PUENTE_NATIVO.search(out):
        # Identity change: the PID was reused. Do not touch.
        return False, "el PID cambio de identidad, no se toca"
    if es_supervisor_no_puente(out):
        if contenedor and alias:
            return matar_puente_dentro_del_contenedor(host, contenedor, alias)
        return False, (f"el pid {pid} es el supervisor/cliente docker exec del adaptador, no la "
                       "puente: no se toca en el host")
    sh(host, f"kill -TERM {pid}", timeout=30)
    sh(host, "sleep 10", timeout=40)
    rc, _, _ = sh(host, f"test -d /proc/{pid}", timeout=30)
    if rc == 0:
        sh(host, f"kill -KILL {pid}", timeout=30)
        sh(host, "sleep 5", timeout=30)
        rc, _, _ = sh(host, f"test -d /proc/{pid}", timeout=30)
    return (rc != 0), ("el proceso desaparecio" if rc != 0 else "SIGUE VIVO tras SIGKILL")


def matar_puente_dentro_del_contenedor(host, contenedor, alias):
    """Same repair, but resolved and applied entirely INSIDE the container: the process
    table is read via `docker exec <c> ps`, never the host's, so a host-side wrapper can
    never be a candidate; the kill is `docker exec <c> kill`, by that container-internal
    PID, never a host PID. A container can host more than one alias's bridge (e.g.
    ws-humanizar hosts both atlas and kratos), so the path match alone is not enough --
    RE_PUENTE's own `alias` group must equal the caller's `alias` too."""
    rc, out, _ = sh(host, f"docker exec {contenedor} ps -eo pid,args --no-headers 2>/dev/null",
                    timeout=30)
    if rc != 0 or not out.strip():
        return False, f"no pude listar procesos dentro del contenedor {contenedor}"
    objetivo = None
    for linea in out.split("\n"):
        partes = linea.strip().split(None, 1)
        if len(partes) != 2 or not partes[0].isdigit():
            continue
        cpid, cargs = partes
        if es_supervisor_no_puente(cargs):
            continue
        m = RE_PUENTE.search(cargs)
        if m and m.group("alias") == alias:
            objetivo = int(cpid)
            break
    if objetivo is None:
        return False, f"no encontre la puente del alias {alias} DENTRO del contenedor {contenedor}"
    sh(host, f"docker exec {contenedor} kill -TERM {objetivo}", timeout=30)
    sh(host, "sleep 10", timeout=40)
    rc, _, _ = sh(host, f"docker exec {contenedor} test -d /proc/{objetivo}", timeout=30)
    if rc == 0:
        sh(host, f"docker exec {contenedor} kill -KILL {objetivo}", timeout=30)
        sh(host, "sleep 5", timeout=30)
        rc, _, _ = sh(host, f"docker exec {contenedor} test -d /proc/{objetivo}", timeout=30)
    return (rc != 0), (f"el proceso desaparecio dentro del contenedor (pid interno {objetivo})"
                       if rc != 0 else "SIGUE VIVO dentro del contenedor tras SIGKILL")


def reiniciar_puente_telegram():
    rc, _, err = sh("agora", f"docker restart {PUENTE_TELEGRAM}", timeout=180)
    return rc == 0, (err.strip()[:150] if rc != 0 else "docker restart devolvio 0")


def restart_veto_for_inflight(deliveries):
    return {"resultado": "omitido", "perdido": deliveries,
            "razon": f"{len(deliveries)} entrega(s) EN VUELO: reiniciar ahora las mata con attempt=1 y "
                     "nadie las reintenta (la re-inyeccion automatica no existe todavia)"}


def ciclo_rescate(alias, adaptador, apuntes):
    """Restart only when both snapshots show no in-flight work.

    This conservative veto is not an atomic drain, so callers keep automatic restart disabled.
    """
    if not adaptador:
        return {"resultado": "omitido", "razon": "no se ve el adaptador vivo"}
    if alias in ALIAS_PIERDEN_CONTEXTO:
        # Not a theoretical precaution: the panel starts with `exec claude` bare and the
        # agent comes back without knowing what it was doing. REPORT it for a human.
        return {"resultado": "omitido",
                "razon": f"{alias} todavia PIERDE TODO SU CONTEXTO al reiniciarse (panel con `exec` "
                         "pelado, sin reanudar sesion): reiniciarlo es amnesia, no reparacion. "
                         "Se reporta; lo arregla el SDK, no el guardia."}
    # Restarting with work in flight kills it at attempt=1 and it does NOT retry. While
    # re-injection isn't implemented, this is destroying work, not rescuing it.
    en_vuelo = captura_en_vuelo(alias)
    if en_vuelo:
        return restart_veto_for_inflight(en_vuelo)
    if adaptador.get("bundle") != RELEASE_CON_FIX78 or adaptador.get("digest") != DIGEST_CON_FIX78:
        return {"resultado": "omitido",
                "razon": f"release sin el fix de exit 78 ({adaptador.get('bundle') or '?'}): reiniciarlo puede dejarlo "
                         "en failed sin arrancar"}
    n = clientes_tmux(alias, adaptador)
    if n:
        return {"resultado": "omitido",
                "razon": f"{n} cliente(s) de tmux atados: reiniciar le tumba la TUI a su dueno"}

    perdido = captura_en_vuelo(alias)          # paso 1
    if perdido:
        return restart_veto_for_inflight(perdido)
    apuntes.append({"tipo": "captura_previa", "alias": alias, "entregas": perdido})

    unidad = f"cauce-v3-container-{alias}.service"
    base = ("XDG_RUNTIME_DIR=/run/user/1000 systemctl --user" if adaptador["host"] == "kratos"
            else "sudo -u stev XDG_RUNTIME_DIR=/run/user/1000 systemctl --user")
    rc, out, err = sh(adaptador["host"], f"{base} restart {unidad} 2>&1", timeout=180)
    salida_arranque = (out + err)[-2000:]      # paso 4: se guarda ENTERA, no se filtra
    sh(adaptador["host"], "sleep 15", timeout=40)
    _, estado, _ = sh(adaptador["host"], f"{base} is-active {unidad}", timeout=40)
    estado = estado.strip()
    if estado != "active":                     # paso 3
        return {"resultado": "fallo", "estado": estado, "perdido": perdido,
                "salida": salida_arranque,
                "razon": f"quedo en '{estado}': NO se re-inyecta nada contra un alias muerto"}

    sin_panel = "SIN sesion compartida" in salida_arranque
    return {"resultado": "reiniciado", "estado": estado, "perdido": perdido,
            "sin_sesion_compartida": sin_panel, "salida": salida_arranque,
            "reinyeccion": "NO IMPLEMENTADA EN AUTOMATICO: ver informe"}


def avisar(texto):
    """Send the notice to the owner's chat. Runs on the storage host: the token never
    leaves it. Same path as the night-watch already uses, proven."""
    rc, out, err = sh("agora", "python3 -", entrada=PLANTILLA_AVISO.replace(
        "json.load(sys.stdin)", f"json.loads({json.dumps({'texto': texto})!r})"), timeout=60)
    return rc == 0 and "enviado" in out, err.strip()[:150]


def robo_cpu_agora():
    """% of CPU the hypervisor steals from agora, or None if it couldn't be measured.

    A probe that explodes with rc=124 can be a BROKEN probe... or a machine the hypervisor
    won't give CPU to. OPPOSITE failures: the first is fixed by touching the doctor; the
    second is NOT fixed from inside, and telling someone to "fix the probe" sends them to
    repair an instrument that's healthy. Distinguishing them costs one second.

    The signature of a provider cap is flatness at a high value for a long time; a noisy
    neighbour would give a saw.
    """
    prog = (
        "import time\n"
        "def leer():\n"
        "    v=[int(x) for x in open('/proc/stat').readline().split()[1:]]\n"
        "    return sum(v), v[7]\n"
        "a=leer()\n"
        "time.sleep(1)\n"
        "b=leer()\n"
        "dt=b[0]-a[0]\n"
        "ds=b[1]-a[1]\n"
        "print(round(100.0*ds/dt,1) if dt>0 else -1)\n"
    )
    try:
        rc, out, _err = sh("agora", "python3 -", entrada=prog, timeout=25)
    except Exception:  # noqa: BLE001
        return None
    if rc != 0 or not out.strip():
        return None
    try:
        v = float(out.strip().splitlines()[-1])
    except Exception:  # noqa: BLE001
        return None
    return v if v >= 0 else None


def es_sonda_rota(tipo):
    return str(tipo or "").startswith("sonda_")


def gravedad(tipo):
    if es_sonda_rota(tipo):
        return GRAVEDAD_SONDA_ROTA
    return GRAVEDAD.get(tipo, 10)


def bloqueo_de_acceso(texto):
    """(bool, reason) if the AGENT declared it lacks an access. The rule lives in the task
    book; if it didn't load, no answer is invented (and `sonda_libro` is already screaming
    at severity 92)."""
    if libro_tareas is None:
        return False, ""
    try:
        return libro_tareas.bloqueado_por_acceso(texto)
    except Exception:  # noqa: BLE001
        return False, ""


def canal_roto_ahora(ultima_muerte_ts, ultima_entrega_ok_ts):
    """(bool) if the channel is actually broken NOW (pure function, testable).

    A channel whose LAST event was a SUCCESSFUL delivery is not broken, even if there were
    deaths in the 24h window. It is only broken if the most recent death is AFTER the most
    recent successful delivery.
    """
    # `sql()` reads with COPY ... FORMAT csv: a Postgres NULL doesn't arrive as None, it
    # arrives as an EMPTY STRING. Without this normalization the comparison below would
    # rely on a happy accident; we normalize on purpose.
    ultima_muerte_ts = (ultima_muerte_ts or "").strip() or None
    ultima_entrega_ok_ts = (ultima_entrega_ok_ts or "").strip() or None
    if ultima_muerte_ts is None:
        return False
    if ultima_entrega_ok_ts is None:
        return True
    return ultima_muerte_ts > ultima_entrega_ok_ts


def avisos_propios_muertos(filas):
    """(list of `escalar` findings) from rows ALREADY read from the database:
    [alias, count, latest_death_UTC, latest_last_error, latest_ok_UTC].
    PURE function on purpose: separating it from `main()` is what lets it be tested
    without raising the other ten probes of a whole run (same pattern as
    `gravedad()`/`bloqueo_de_acceso()`)."""
    salida = []
    for alias, n, cuando, ultimo, cuando_ok in filas:
        # Discriminator: the channel is only broken if the death is more recent than the OK
        if not canal_roto_ahora(cuando, cuando_ok):
            # Channel recovered after the death, or there was never a death: don't escalate
            continue
        salida.append({
            "tipo": "aviso_propio_muerto", "alias": alias,
            "detalle": (f"{n} entrega(s) del PROPIO guardia hacia {alias} murieron en las ultimas "
                        f"24 h sin llegar (la ultima, {cuando} UTC): el canal por el que el medico "
                        "avisa de los fallos se rompio, y nadie se entero"),
            "evidencia": {
                "como se identifica": "body->>'guardia' = 'cauce-medico-monitor' (no depende "
                                       "de body->>'type', que aqui sale NULO)",
                "ultimo last_error (crudo)": (ultimo or "")[:400],
                "ultima_entrega_OK": cuando_ok or "(nunca)",
                "consulta": "select d.* from deliveries d join messages m on m.id=d.message_id "
                            "where m.body->>'guardia'='cauce-medico-monitor' and d.recipient_"
                            "alias='{}' and d.status in ('failed','dead') order by "
                            "d.created_at desc".format(alias.replace("'", "''")),
            }})
    return salida


def nadie_bloqueado_por(etiqueta):
    """(True, reason) if the panel of ALL consumers was measured and none shows blocking.

    (False, reason) otherwise: no census, stale census, unreadable panel, or any actually
    blocked. NOT pure — reads panels over SSH/docker — so it is only called when the
    finding was about to escalate anyway.

    The probe's percentage does NOT decide; the alias's panel does. The probe at 0% with
    deliveries still closing on that same account is a measured case.
    """
    filas = CENSO_CUENTA.get(etiqueta)
    if not filas:
        return False, "no hay censo para esta cuenta: no puedo saber a quien afecta"
    if censo_rancio():
        return False, (f"el censo es del {CENSO_FECHA}, mas de {DIAS_CENSO_CADUCA} dias: no afirmo "
                       "un negativo con datos viejos")
    medidos = []
    for alias_c, _ctr, _arnes in filas:
        panel, por_que_no = panel_del_alias(alias_c)
        if not panel:
            return False, f"no pude leer el panel de {alias_c} ({por_que_no}): sin eso no se si esta bloqueado"
        causa_c = causa_en_el_panel(panel)
        if causa_c:
            return False, f"{alias_c} SI esta bloqueado -- {causa_c[:140]}"
        medidos.append(alias_c)
    return True, f"medi el panel de {', '.join(medidos)} y ninguno muestra causa de bloqueo"


def censo_rancio():
    """True if the census is more than DIAS_CENSO_CADUCA days stale. PURE except for the clock."""
    try:
        fecha = datetime.datetime.strptime(CENSO_FECHA[:16], "%Y-%m-%d %H:%M").replace(
            tzinfo=datetime.timezone.utc)
    except (ValueError, TypeError):
        return True  # si no se puede fechar, se trata como rancio: nunca al reves
    dias = (datetime.datetime.now(datetime.timezone.utc) - fecha).total_seconds() / 86400.0
    return dias > DIAS_CENSO_CADUCA


def censo_de(etiqueta):
    """Devuelve (quien_la_usa, quien_no_tiene_escalera) ya formateados para la evidencia."""
    filas = CENSO_CUENTA.get(etiqueta)
    if not filas:
        return ("censo sin entrada para esta cuenta: levantalo a mano", "desconocido")
    usa = ", ".join(f"{f[0]} ({f[1]}, arnes {f[2]})" for f in filas)
    mudos = [f[0] for f in filas if f[2] == "claude"]
    if mudos:
        sin = (f"{', '.join(mudos)} -- arnes `claude`, SIN escalera de modelos: si la cuenta "
               "rechaza se quedan mudos, no caen a otro proveedor")
    elif censo_rancio():
        # Don't affirm a negative from a stale census; an outdated map has misattributed
        # which alias uses which account.
        sin = (f"NO VERIFICADO: segun el censo del {CENSO_FECHA} ninguno se quedaria mudo, pero ese censo "
               f"tiene mas de {DIAS_CENSO_CADUCA} dias y ya se equivoco una vez. Rehacelo antes de fiarte: "
               "`docker exec <ctr> sh -lc 'claude auth status'` en cada contenedor")
    else:
        sin = ("ninguno: todos tienen escalera (openclaw) o no usan la cuenta Claude (codex)")
    return (usa, sin)


def es_fallo_de_instrumento(texto):
    """True if the `ok:false` from an account probe carries the SHAPE of an INSTRUMENT failure
    (the browser/CDP doing the probing), not of the account. See RE_ERROR_DE_INSTRUMENTO_SONDA."""
    return bool(RE_ERROR_DE_INSTRUMENTO_SONDA.search(str(texto or "")))


def sonda_cuenta_racha(racha_prev, etiqueta, ok):
    """CONSECUTIVE runs of `ok:false` for `etiqueta`. `ok:True` CUTS the streak (healed):
    without that, a 10-run-old isolated failure plus yesterday's would add up as if
    consecutive, which is not what "persistent" means."""
    if ok:
        return 0
    return int((racha_prev or {}).get(etiqueta, 0)) + 1


def hallazgo_cuenta_rota(etiqueta, plan, cuenta, racha_prev, capturado):
    """Build (new_streak, entry_or_None) for an `ok:false` record in `claude-accounts.json`.

    `entry_or_None` is None while the streak hasn't reached UMBRAL_RACHA_CUENTA_ROTA: ONE bad
    sample does not escalate. When it does, the `detalle` explicitly says whether the pattern
    matches an INSTRUMENT failure or whether we genuinely don't know — "account exhausted"
    is never asserted on this evidence alone; the percentage branch decides that.
    """
    racha = sonda_cuenta_racha(racha_prev, etiqueta, False)
    if racha < UMBRAL_RACHA_CUENTA_ROTA:
        return racha, None
    registro = json.dumps(cuenta)
    if es_fallo_de_instrumento(registro):
        motivo = ("el INSTRUMENTO de sondeo (navegador/fetch) fallo -la firma es la de una "
                  "pestana que perdio su pagina, NO necesariamente que la cuenta este caida "
                  "o agotada")
    else:
        motivo = "no responde el sondeo (motivo sin forma conocida de fallo de instrumento)"
    detalle = f"la cuenta {etiqueta} ({plan}) {motivo}, persistente en {racha} corridas seguidas"
    return racha, {"tipo": "cuenta_ia", "alias": etiqueta, "detalle": detalle,
                   "evidencia": {"fichero": CUENTAS_LIVE, "capturedAt": capturado,
                                 "racha corridas seguidas": racha, "registro": registro}}


def pares_de_evidencia(ev):
    """La evidencia es un campo ACCESORIO del hallazgo: su FORMA no puede tumbar al guardia.

    2026-08-12: el motivo `respuesta_perdida` -- justo el que caza las respuestas que mueren en
    silencio -- traia una LISTA donde este renderizador hacia `.items()`. Reventaba con
    AttributeError DESPUES de imprimir los hallazgos y ANTES de despacharlos, asi que el guardia
    veia los 11 problemas y no avisaba de ninguno. Cuatro corridas seguidas; a la tercera el
    disyuntor lo dejo mudo del todo. Un guardia que se calla por la forma de un campo decorativo
    es peor que no tenerlo. Ahora se acepta cualquier forma razonable y lo raro se rinde como texto.
    """
    if not ev:
        return []
    if isinstance(ev, dict):
        return [(str(k), v) for k, v in ev.items()]
    if isinstance(ev, (list, tuple)):
        pares = []
        for i, item in enumerate(ev):
            if isinstance(item, dict) and "que" in item:
                pares.append((str(item.get("que")), item.get("valor", "")))
            elif isinstance(item, dict):
                pares.extend((str(k), v) for k, v in item.items())
            else:
                pares.append((f"evidencia[{i}]", item))
        return pares
    return [("evidencia", ev)]


def una_linea(texto, limite=4000):
    """Flatten any text to ONE logical line.

    Collapses newlines, tabs and whitespace runs to a single space, and truncates if needed.
    It is the only place `detalle` passes through before entering the log or the body hashed
    for the `idempotency_key`: a subprocess output — or any foreign free text that has
    reached here, by SQL or anything else — must never inject a newline that the renderer
    reads as an orphan finding, without prefix and without alias.
    """
    if texto is None:
        return ""
    plano = _RE_ESPACIOS_DE_CONTROL.sub(" ", str(texto)).strip()
    if limite and len(plano) > limite:
        plano = plano[:limite].rstrip() + "…[truncado]"
    return plano


def memoria_hallazgos(visto_antes, visto_ahora, t0):
    """Keep what was NOT seen in THIS run instead of forgetting it.

    `visto_ahora` is built from scratch with the current run's findings. If saved as-is, a
    finding that disappears for a while and comes back enters as `nuevo`: count resets to 1
    and it's dispatched again, skipping REAVISO_HORAS. That is what looks like "the same
    alert twice". Memory is therefore CARRIED; only forgotten when unseen for OLVIDO_HORAS
    (otherwise the state file grows forever).
    """
    fusion = dict(visto_ahora)
    for clave, v in (visto_antes if isinstance(visto_antes, dict) else {}).items():
        if clave in fusion:
            continue
        ref = v.get("ultimo_visto") or v.get("ultimo_despacho") or v.get("primera_vez")
        try:
            viejo = (t0 - datetime.datetime.fromisoformat(ref)).total_seconds() \
                >= OLVIDO_HORAS * 3600
        except Exception:  # noqa: BLE001
            viejo = True   # sin fecha utilizable no se puede sostener la memoria: se suelta
        if not viejo:
            fusion[clave] = v
    return fusion


def _texto_estable(texto):
    """El mismo aviso con los contadores que bajan solos neutralizados. PURA.

    Solo se usa para la HUELLA de deduplicacion; el texto que se envia no se toca. Si esto
    dejara de reconocer un patron, el peor caso es el de siempre -un aviso repetido-, nunca
    un aviso perdido: es el lado barato de equivocarse.
    """
    for patron, reemplazo in _VOLATIL:
        texto = patron.sub(reemplazo, texto)
    return texto


def publicar(tenant, alias, cuerpo, clave, extra=None):
    """Publica UNA entrega Cauce. Es la unica canieria de salida del guardia.

    La usan las DOS cosas que el guardia manda, y no hay ninguna mas:
      - el aviso al medico (zeus), que es el auto-despertar; y
      - la reanudacion de un encargo sin cumplir, que va al alias responsable.
    Las dos son `POST /v3/messages` con el mismo certificado y el mismo marcado. No hay un
    segundo canal, ni Telegram, ni notify: el unico Telegram que queda es la rama de "zeus
    caido", que ya existia y no se toca.
    """
    marca = "[GUARDIA AUTOMATICO - cauce-medico-monitor - NO es kant]"
    texto = marca + "\n" + cuerpo
    # The fingerprint is computed on the NORMALIZED text, not on the raw. The body carries
    # self-decreasing counters ("in 1222 min", `resetInSeconds`, `capturedAt`), so the key
    # changed on every run and dedup never fired: a stable condition (an account at 0% for
    # 19 h) generated one delivery per run. Percentages ARE kept on purpose: going from 5%
    # to 0% is a material change and must alert again. What is silenced is "the same thing,
    # N minutes later".
    huella = hashlib.sha256(_texto_estable(texto).encode("utf-8")).hexdigest()[:16]
    body = {"text": texto, "guardia": "cauce-medico-monitor", "es_automatico": True,
            "identidad_prestada": "console-client->Steven/kant"}
    body.update(extra or {})
    payload = {
        "room_id": "grp.steven",
        "recipients": [{"tenant_id": tenant, "alias": alias}],
        "body": body,
        "idempotency_key": f"medico-{re.sub(r'[^a-zA-Z0-9_.-]', '_', clave)[:32]}-{huella}",
    }
    prog = DESPACHO.replace("json.loads(sys.stdin.read())", f"json.loads({json.dumps(payload)!r})")
    rc, out, err = sh("agora", "python3 -", entrada=prog, timeout=90)
    lineas = [line for line in out.strip().split("\n") if line.strip()]
    estado = lineas[0] if lineas else "?"
    return (rc == 0 and estado == "202"), (out.strip() + " " + err.strip())[:400]


def despachar_a_zeus(cuerpo, clave):
    """Drop the work in zeus's queue as a regular Cauce delivery.

    Cauce is event-driven: zeus does not exist between deliveries, so publishing one is the
    ONLY way to wake it.

    The `idempotency_key` comes from the BODY HASH, not alias or time. Verified against the
    gateway: same key + same body → `duplicate: true` (clean dedup); but same key +
    DIFFERENT body → **409 conflict** and the delivery is lost silently. With the key-by-
    content, both fall out for free: an identical finding doesn't re-wake zeus, and one
    that changed does enter as a new delivery.
    """
    # IDENTITY: the `console-client` cert maps to one console user, so the delivery arrives
    # with sender_alias=kant and the doctor LOOKS like kant. That contaminates a peer's
    # attribution: the target could not distinguish an automatic notice from a real
    # kant request, and replies would bounce to them. The right fix is a dedicated
    # principal (cert + mtls_identities.json entry + membership), but that touches the
    # console client's identity and is decided separately. For now it is marked
    # unambiguously: a visible
    # first line and a stable body field that is detected without reading prose
    # (MessageBody is an open record, only restricting timeout_ms and attachments_v1).
    return publicar("Steven", "zeus", cuerpo, clave)


def git_commit(mensaje):
    """LOCAL commit of the log. The repo intentionally has no remote: an automatic, midnight,
    unreviewed push is exactly the kind of thing one must be able to undo."""
    if not os.path.isdir(os.path.join(ESTADO_DIR, ".git")):
        sh("kratos", f"git -C {ESTADO_DIR} init -q", timeout=40)
        with open(os.path.join(ESTADO_DIR, ".gitignore"), "w") as f:
            # Never version anything that could drag a secret.
            f.write("lock\n*.token\n*.key\n*.crt\n.env\n")
    sh("kratos", f"git -C {ESTADO_DIR} add -A", timeout=40)
    rc, _, _ = sh("kratos", f"git -C {ESTADO_DIR} diff --cached --quiet", timeout=40)
    if rc == 0:
        return False
    seguro = mensaje.replace("'", "").replace("\n", " ")[:400]
    rc, _, _ = sh("kratos", f"git -C {ESTADO_DIR} -c user.name=cauce-medico "
                            f"-c user.email=medico@cauce.local commit -q -m '{seguro}'", timeout=60)
    return rc == 0
