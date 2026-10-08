# ruff: noqa: F821
"""Probes and readers of cauce-v3-medico-monitor, sourced into its namespace.

Sourced by the entrypoint with exec() in module globals (like bash `source`),
so every name here resolves exactly as before the split. Not imported directly.
"""


def ahora():
    return datetime.datetime.now(datetime.timezone.utc)


def sh(host, comando, entrada=None, timeout=90):
    """Ejecuta en kratos (local), en el VPS o en agora-storage. Devuelve (rc, out, err)."""
    if host == "kratos":
        cmd = ["bash", "-lc", comando]
    else:
        destino = VPS if host == "vps" else AGORA
        cmd = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", destino, comando]
    try:
        # stdin explicit: without it, an `ssh` child eats the doctor's own stdin (and with
        # it, the rest of the script when invoked via heredoc).
        if entrada is None:
            r = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True,
                               text=True, timeout=timeout)
        else:
            r = subprocess.run(cmd, input=entrada, capture_output=True, text=True,
                               timeout=timeout)
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return 124, "", f"timeout tras {timeout}s"
    except Exception as e:  # noqa: BLE001
        return 1, "", f"{type(e).__name__}: {e}"


def sql(consulta, columnas=None):
    """Query the database. The query goes via stdin (no shell quoting).

    Returns rows; each row is a list of strings with EXACTLY the columns asked for, no matter
    what the data inside contains. Free text (e.g. `last_error`) cannot change the number of
    columns because we use `COPY ... FORMAT csv` and parse with the `csv` module: newlines,
    commas, tildes, quotes inside a value are data, never structure.

    `columnas` is an optional contract: if the base returns a different width, we fail with a
    message naming the actual width instead of a generic unpack error far away.
    """
    cuerpo = consulta.strip().rstrip(";").strip()
    if not cuerpo:
        raise RuntimeError("consulta vacia")
    orden = f"COPY ({cuerpo}) TO STDOUT WITH (FORMAT csv, FORCE_QUOTE *);"
    rc, out, err = sh("agora", PG, entrada=orden)
    if rc != 0:
        raise RuntimeError(f"psql rc={rc}: {err.strip()[:200]}")
    filas = [f for f in csv.reader(io.StringIO(out, newline="")) if f]
    if columnas is not None:
        malas = [f for f in filas if len(f) != columnas]
        if malas:
            raise RuntimeError(
                f"la consulta declaro {columnas} columna(s) y la base devolvio {len(malas)} fila(s) con otro "
                f"ancho (la primera trae {len(malas[0])}): revisa la CONSULTA, no el texto de los datos")
    return filas


def panel_del_alias(alias):
    """Last lines of the alias's tmux panel. READ-ONLY. None if it can't be read.

    The container is resolved from the `--container-id` of the live process, NOT from
    `agents.container_name`: the latter has been observed to disagree with reality.
    """
    porque = None
    for host in ("vps", "kratos"):
        rc, out, _ = sh(host, f"ps -eo args | grep 'run --alias {alias} ' | grep -v grep | "
                              "grep -oE '\\-\\-container-id [a-f0-9]+' | head -1 | awk '{print $2}'", timeout=45)
        cid = (out or "").strip()
        if rc != 0 or not cid:
            porque = f"no encontre el proceso de {alias} ni en el VPS ni en kratos: sin panel que leer"
            continue
        rc, out, err = sh(host,
                          f"docker exec {cid} sh -lc \"tmux -L cauce capture-pane -p -t cauce-{alias}\" "
                          "2>&1 | grep -v '^[[:space:]]*$' | tail -30", timeout=60)
        txt = (out or err or "").strip()
        if "tmux: not found" in txt:
            return None, (f"el contenedor de {alias} NO TIENE tmux: no hay panel, y por eso su sesion no "
                          "puede ser compartida. Eso es una averia en si, no una falta de dato")
        if rc != 0 or not txt:
            porque = f"no pude capturar el panel de {alias} en {host} (rc={rc})"
            continue
        return txt, None
    return None, porque or f"no pude leer el panel de {alias} en ningun host"


def causa_en_el_panel(texto):
    """Translate the panel to a NAMED cause, or None if nothing is recognized. PURE."""
    if not texto:
        return None
    t = texto.lower()
    if "weekly limit" in t or "hit your limit" in t or "usage-credits" in t:
        return ("BLOQUEADO POR LIMITE **O** POR CREDENCIAL RANCIA: el panel dice que llego al tope, "
                "pero ese mismo texto lo produce un token vencido. DESEMPATE BARATO Y PRIMERO: "
                "`/login` sobre la MISMA cuenta. Si vuelve a trabajar era el token; si sigue mudo "
                "era el saldo. NO muevas al alias de cuenta antes de probar eso -es lo caro y lo "
                "que rompe cosas-. Y el porcentaje de la sonda NO decide: el 2026-08-19 la cuenta "
                "marcaba weekly 0% y el alias cerraba entregas normalmente")
    if "usage limit" in t or "purchase more credits" in t:
        return ("PROVEEDOR SIN CREDITO: dice 'usage limit'. No es trabajo perdido y ningun "
                "reintento ni reinicio lo arregla; hace falta credito (dinero, humano)")
    if "not logged in" in t or "please run /login" in t:
        return ("SIN CREDENCIAL: el CLI contesta 'Not logged in'. Medido en argos el 2026-08-22: "
                "su `~/.claude/.credentials.json` era un fichero de CERO bytes propiedad de root "
                "desde el 15-ago -una rotacion a medias-, y los dos peldanos anthropic de su "
                "cadena llevaban una semana muertos sin que nadie lo notara. Comprobalo con "
                "`sha256sum`: e3b0c44298fc... es el hash del fichero VACIO. No se reinyecta: se "
                "repone la credencial y se prueba por efecto con `claude -p ok`")
    if "all models failed" in t or "fallbacksummaryerror" in t:
        return ("CADENA DE MODELOS AGOTADA: fallaron TODOS los peldanos, no solo el primero. "
                "El texto del bus nombra unicamente al primero y TRUNCA POR EL MEDIO justo donde "
                "van los otros -medido: '… [398 caracteres omitidos] …' se come las razones 2 a 5-. "
                "Reinyectar no arregla nada. Hay que auditar la cadena PELDANO A PELDANO en el "
                "`openclaw.json` del alias y probar cada proveedor por separado")
    if "press enter" in t or "esc to go back" in t or "1." in t and "2." in t and "switch to" in t:
        return ("MODAL ABIERTO: la TUI esta esperando una tecla. Se come turnos ENTEROS, incluso ya "
                "terminados. Se contesta en el panel; mirar que opcion NO degrada el modelo")
    # Revocation goes BEFORE the generic credential check, with its own text. The previous
    # function returned None on these phrases (none of the three it looked for matched),
    # so the finding came out as `trabajo_perdido` and ordered a re-injection that cannot run.
    if "revoked" in t or "sign in again" in t or "could not be refreshed" in t:
        return ("CREDENCIAL REVOCADA: la cadena de este alias fue invalidada, casi siempre porque "
                "OTRO alias inicio sesion en la MISMA cuenta (Codex admite una sola credencial "
                "viva por cuenta). No es trabajo perdido y ningun reintento lo arregla. ADJUDICA "
                "ASI: compara `account_id` y el mtime de `~/.codex/auth.json` entre todos los "
                "alias de arnes codex -leyendo el fichero, NUNCA invocando el CLI de codex, que "
                "revoca la cadena viva-; el mtime mas nuevo sobre la misma cuenta es quien revoco "
                "al resto. OJO: relogear a la victima revoca al otro y muda el problema. Dos "
                "alias sobre una cuenta es suma cero: se arregla con otra CUENTA, no con otro "
                "login")
    if "login" in t or "authenticate" in t or "not authenticated" in t:
        return "CREDENCIAL: el panel pide autenticacion"
    return None


def detalle_congelado(alias, vuelve, total, cuando):
    """Text of the `congelado_tras_recuperar_credito` finding. PURE.

    The panel is SCROLLBACK, not current state: the limit banner stays there because nobody
    wrote anything after, not because the limit is still in effect. A restart is what frees
    the TUI; quota is not the actual blocker.
    """
    return (f"{alias} se quedo CONGELADO en el cartel de limite: su proveedor dijo que volvia el "
            f"{vuelve.strftime('%Y-%m-%d %H:%M')} UTC, esa hora YA PASO y el alias no reintenta solo "
            "-la TUI se queda en el cartel para siempre-. NO hace falta dinero: hace falta REINICIARLO "
            f"(`cauce {alias} off && cauce {alias} on`). Comproba antes que la cuota volvio de verdad; "
            "si tras el reinicio, y con saldo, sigue fallando, ENTONCES si es dinero. "
            f"({total} falla(s) en 24 h, la ultima {cuando} UTC)")


def cuanto_falta(segundos):
    """Human-readable countdown. PURE.

    Sub-hour values render as "X min" so that 17 minutes do not display as "0 h" (which
    would invite the false-positive that the countdown exists to prevent).
    """
    minutos = int(segundos // 60)
    if minutos < 60:
        return f"faltan {max(minutos, 0)} min"
    if minutos < 60 * 24:
        return f"faltan {minutos // 60}h{minutos % 60:02d}m"
    return f"faltan {minutos / 60.0:.0f} h"


def _reset_solo_hora(texto, ahora=None):
    """`try again at 3:46 AM` (no date) -> today's UTC datetime, or None. PURE.

    Only accepted if that hour has not passed today; if it has, the message is stale and
    guessing "tomorrow" would hide up to 24 h of real downtime. Returns None and the caller
    escalates — the cheap side of being wrong.
    """
    m = re.search(r"try again at\s+(\d{1,2}):(\d{2})\s*(AM|PM)", texto or "", re.IGNORECASE)
    if not m:
        return None
    hora = int(m.group(1))
    minuto = int(m.group(2))
    if m.group(3).upper() == "PM" and hora != 12:
        hora += 12
    elif m.group(3).upper() == "AM" and hora == 12:
        hora = 0
    ahora = ahora or datetime.datetime.now(datetime.timezone.utc)
    try:
        cuando = ahora.replace(hour=hora, minute=minuto, second=0, microsecond=0)
    except ValueError:
        return None
    return cuando if cuando > ahora else None


def reset_del_panel(texto):
    """`try again at Aug 20th, 2026 3:46 AM` -> UTC datetime, or None. PURE.

    The provider publishes in the panel WHEN it returns. Until that moment, the finding is
    a dated note, not an alarm. If it can't be parsed, returns None and the caller
    ESCALATES — never guessing a deadline.

    The timezone is NOT in the text; UTC is assumed. If the real TZ were UTC-5 the doctor
    would wake up a few hours early, which is the cheap side of being wrong.
    """
    if not texto:
        return None
    m = re.search(r"try again at\s+([A-Za-z]{3})[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?,\s*"
                  r"(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM))?", texto, re.IGNORECASE)
    if not m:
        return _reset_solo_hora(texto)
    mes = _MESES.get(m.group(1).lower())
    if not mes:
        return None
    try:
        hora = int(m.group(4) or 0)
        minuto = int(m.group(5) or 0)
        ampm = (m.group(6) or "").upper()
        if ampm == "PM" and hora != 12:
            hora += 12
        elif ampm == "AM" and hora == 12:
            hora = 0
        return datetime.datetime(int(m.group(3)), mes, int(m.group(2)), hora, minuto,
                                 tzinfo=datetime.timezone.utc)
    except (TypeError, ValueError):
        return None


def inventario():
    """The aliases that exist, per the database. Source of truth for WHO exists."""
    filas = sql("select tenant_id, alias, coalesce(container_name,'') from agents "
                "where enabled order by alias;", columnas=3)
    return {a: {"tenant": t, "contenedor_db": c} for t, a, c in filas}


def procesos(host):
    """All processes on the host, already split. Container processes are visible in the
    host's `ps`, so a single sweep per host catches everything."""
    rc, out, _ = sh(host, "ps -eo pid,etimes,pcpu,rss,args --no-headers")
    if rc != 0:
        return []
    filas = []
    for linea in out.split("\n"):
        partes = linea.strip().split(None, 4)
        if len(partes) < 5:
            continue
        try:
            filas.append({"host": host, "pid": int(partes[0]), "etimes": int(partes[1]),
                          "pcpu": float(partes[2]), "rss": int(partes[3]), "args": partes[4]})
        except ValueError:
            continue
    return filas


def unidades(host):
    """State of the adapter units (per-user units of the controlling user on both hosts)."""
    if host == "kratos":
        # Without XDG_RUNTIME_DIR, `systemctl --user` finds no bus and returns ZERO units,
        # with no error: the doctor would read "all well".
        base = "XDG_RUNTIME_DIR=/run/user/1000 systemctl --user"
    else:
        base = "sudo -u stev XDG_RUNTIME_DIR=/run/user/1000 systemctl --user"
    rc, out, _ = sh(host, base + " list-units 'cauce-v3-container-*' 'cauce-v3-host-*' "
                          "--all --no-legend --plain --no-pager")
    if rc != 0:
        return {}
    res = {}
    for linea in out.split("\n"):
        partes = linea.split()
        if len(partes) < 4 or not partes[0].startswith("cauce-v3-"):
            continue
        unidad = partes[0]
        m = re.match(r"cauce-v3-(?:container|host)-(.+)\.service$", unidad)
        if not m:
            continue
        res[m.group(1)] = {"unidad": unidad, "host": host,
                           "active": partes[2], "sub": partes[3]}
    return res


def estado_fresco_unidad(host, unidad):
    """Re-measure ONE unit NOW. Returns dict or None if it couldn't be measured.

    None means "couldn't measure", NOT "all is well": the caller must keep alerting in that
    case. A broken probe proves nothing (same rule that already applies to `unidades()` and
    `procesos()` in this run).
    """
    base = ("XDG_RUNTIME_DIR=/run/user/1000 systemctl --user" if host == "kratos"
            else "sudo -u stev XDG_RUNTIME_DIR=/run/user/1000 systemctl --user")
    rc, out, _ = sh(host, f"cat /proc/uptime; {base} show {unidad} -p ActiveState,SubState,Result,"
                          "ActiveEnterTimestampMonotonic,InactiveEnterTimestampMonotonic", timeout=40)
    if rc != 0 or not out.strip():
        return None
    lineas = out.strip().split("\n")
    try:
        uptime_s = float(lineas[0].split()[0])
    except (IndexError, ValueError):
        return None
    d = {}
    for linea in lineas[1:]:
        if "=" in linea:
            k, _, v = linea.partition("=")
            d[k.strip()] = v.strip()
    if "ActiveState" not in d:
        return None

    def _antiguedad(campo):
        try:
            us = int(d.get(campo, "0"))
        except ValueError:
            return None
        if us <= 0:
            return None
        return uptime_s - (us / 1000000.0)

    return {"unidad": unidad, "host": host,
            "active": d.get("ActiveState", ""), "sub": d.get("SubState", ""),
            "result": d.get("Result", ""),
            "hace_activa_s": _antiguedad("ActiveEnterTimestampMonotonic"),
            "hace_parada_s": _antiguedad("InactiveEnterTimestampMonotonic")}


def _lee_reinicio(fresco, ventana_s=VENTANA_REINICIO_S):
    """(is_restart, reason) from ONE already-taken measurement. PURE: no network, testable.
    `False, ""` = alert as usual."""
    unidad, host = fresco["unidad"], fresco["host"]
    if fresco["active"] == "active" and fresco["sub"] != "failed":
        # Covers TWO real cases: (a) the alias restarted in the gap between sample and
        # notice and is already back; (b) the chosen unit was the leftover `inactive` from
        # a host move while the real one is up. In both, with the unit active NOW, we
        # cannot conclude the alias is without adapter.
        return True, (f"la unidad {unidad} en {host} esta ACTIVA al remedirla (arriba hace "
                      f"{int(fresco['hace_activa_s']) if fresco['hace_activa_s'] else '?'} s): la "
                      "muestra del principio de la corrida no alcanza para declararlo mudo")
    if fresco["active"] in ("activating", "reloading", "deactivating"):
        return True, (f"la unidad {unidad} en {host} esta en '{fresco['active']}': esta "
                      "arrancando o parando ahora mismo, no esta caida")
    parada = fresco["hace_parada_s"]
    if fresco["result"] == "success" and parada is not None and parada < ventana_s:
        return True, (f"la unidad {unidad} en {host} se paro ORDENADAMENTE (Result=success) hace {int(parada)} s, "
                      f"dentro de la ventana de reinicio de {ventana_s} s: es un apagado deliberado en "
                      "curso, no una caida")
    return False, ""


def mapa_adaptadores(procs):
    """alias -> live adapter (host, pid, bundle, digest, container). Discovered from the
    LIVE process, not from the inventory: the inventory and unit Descriptions lie after a
    host move; the process argv does not."""
    res = {}
    for p in procs:
        m = RE_ADAPTADOR.search(p["args"])
        if not m:
            continue
        alias = m.group("alias")
        b = RE_BUNDLE.search(p["args"])
        d = RE_DIGEST.search(p["args"])
        c = RE_CTR.search(p["args"])
        res[alias] = {"host": p["host"], "pid": p["pid"], "etimes": p["etimes"],
                      "bundle": os.path.basename(b.group("bundle")) if b else "",
                      "digest": d.group("digest") if d else "",
                      "contenedor": c.group("ctr") if c else ""}
    return res


def clientes_tmux(alias, adaptador):
    """How many tmux clients are attached to the alias's panel. Restarting or killing
    anything on an alias with its owner's TUI open drops the session: never done solo."""
    sesion = f"cauce-{alias}"
    if not adaptador:
        return None
    if adaptador.get("contenedor"):
        cmd = f"docker exec {adaptador['contenedor']} tmux -L cauce list-clients -t {sesion} 2>/dev/null"
    else:
        cmd = f"tmux -L cauce list-clients -t {sesion} 2>/dev/null"
    rc, out, _ = sh(adaptador["host"], cmd, timeout=30)
    if rc != 0:
        return 0
    return len([line for line in out.strip().split("\n") if line.strip()])


def sonda_telegram():
    """Runs on the storage host so tokens never leave it."""
    # A network timeout must not blind the whole report. The probe is READ-ONLY (runs on
    # the storage host so tokens never leave it), so retrying is safe. Only CONNECTION
    # failures are retried (255 = ssh, 124 = timeout); any other rc is reported as-is, since
    # then the problem is not the network and persisting would hide it.
    rc, out, err = sh("agora", "python3 -", entrada=SONDA_TELEGRAM, timeout=180)
    if rc in (124, 255):
        rc2, out2, err2 = sh("agora", "python3 -", entrada=SONDA_TELEGRAM, timeout=180)
        if rc2 == 0:
            rc, out, err = rc2, out2, err2
        else:
            return {}, (f"sonda telegram rc={rc} y el reintento tambien fallo "
                        f"(rc={rc2}): {(err2 or err).strip()[:130]}")
    if rc != 0:
        return {}, f"sonda telegram rc={rc}: {err.strip()[:150]}"
    try:
        return json.loads(out.strip().split("\n")[-1]), None
    except Exception as e:  # noqa: BLE001
        return {}, f"sonda telegram ilegible: {e}"


def turnos_muertos_de_zeus(lista):
    """Of the deliveries zeus took and did not close, the ones that are truly DEAD.

    Waking a person requires POSITIVE evidence that the doctor is not alive, not the mere
    absence of progress: an open delivery is exactly what you see whenever zeus IS
    working (p90 of a turn is 31 min, threshold is 20). The signal of life is the LEASE:
    while it does not expire, someone is renewing it — the adapter is up. A `lease_min`
    of None means unreadable: that's blindness, not death, and doesn't escalate either."""
    return [x for x in lista
            if x.get("lease_min") is not None and x["lease_min"] < 0]


def cursores():
    filas = sql("select alias, next_update_id, "
                "round(extract(epoch from (now()-updated_at))/60) "
                "from channel_bridge_cursors;", columnas=3)
    return {a: {"cursor": int(c), "quieto_min": int(float(m))} for a, c, m in filas}


def entregas_trabadas():
    """Deliveries in flight, with what is needed to know if SOMEONE IS WORKING THEM.

    Age alone does not distinguish a long turn from a dead turn (that's why the doctor was
    reporting the doctor's own real turns as "stuck" every hour). Two measures of ROW
    MOVEMENT are also pulled:
      quieto_min: minutes since the last real advance of the delivery
      lease_min : minutes left on the lease (negative = expired)
    Postgres `greatest` ignores NULLs and `created_at` is never NULL: the count always
    comes out.
    """
    filas = sql(
        "select recipient_tenant, recipient_alias, status, attempt, "
        "round(extract(epoch from (now()-created_at))/60), id, "
        "round(extract(epoch from (now()-greatest(created_at, claimed_at, "
        "  execution_started_at, updated_at)))/60), "
        "coalesce(round(extract(epoch from (claim_expires_at-now()))/60)::text,'') "
        "from deliveries where status in ('leased','accepted','started') "
        "order by created_at;", columnas=8)
    salida = []
    for f in filas:
        if len(f) < 8:
            continue
        t, a, s, i, m, d, q, lease = f[:8]
        try:
            lease_min = int(float(lease)) if str(lease).strip() else None
        except ValueError:
            lease_min = None
        try:
            quieto = int(float(q))
        except ValueError:
            quieto = None
        salida.append({"tenant": t, "alias": a, "status": s, "intento": int(i),
                       "edad_min": int(float(m)), "id": d,
                       "quieto_min": quieto, "lease_min": lease_min})
    return salida


def error_de_transporte(err):
    """True if this `last_error` was written by the TRANSPORT (and can be cited as proof
    the response didn't arrive). False = it was written by the recipient or an operator,
    and the delivery WAS seen: it was rejected, not lost on the way back.

    In doubt, NOTHING is silenced: anything that doesn't match disappears from neither
    list — it goes through the other channel (`respuesta_rechazada`) with authorship set
    correctly. The worst case if the bus rolls out a new diagnostic this pattern doesn't
    know is it appearing in the wrong list (still visible), never being lost.
    """
    return bool(RE_ERROR_DE_TRANSPORTE.match(err or ""))


def respuestas_perdidas(horas=24):
    """(lost, rejected): two distinct things that used to be counted as one.

    `lost`     = the response died on the way back. BLINDS both ends.
    `rejected` = the response ARRIVED and the recipient rejected it, writing their reason
                 in `last_error`. Nobody was blinded: there is an alias that read it.

    `recipient_alias` is the RECIPIENT; `actor_alias`, who answered. Only in the `lost`
    group is the recipient also "the one waiting blindly": in `rejected`, they are the
    AUTHOR of the `last_error` text, and saying they were waiting for something is exactly
    the bug above.
    """
    filas = sql(
        "select d.recipient_tenant, d.recipient_alias, coalesce(m.actor_alias,'?'), "
        "left(d.id::text,8), "
        "to_char(d.terminal_at at time zone 'UTC','MM-DD HH24:MI'), "
        "left(coalesce(d.last_error,''),110), "
        "(select count(*) from deliveries d2 "
        " join messages m2 on m2.id = d2.message_id "
        " where d2.recipient_alias = d.recipient_alias and d2.status = 'done' "
        # Anchored on `created_at`: the text exists from when the response was created,
        # not from when the bus gave up. A strict `> d.terminal_at` would miss fan-ins
        # emitted in the same second as the timeout.
        "   and d2.created_at >= d.created_at "
        "   and length(coalesce(m.body->>'text','')) > 40 "
        # Searched in the FULL body (not just `body->>'text'`): the fan-in carries generic
        # boilerplate there and the real content in
        # `body->fanin_data_v1->responses[]->untrusted_text`.
        "   and position("
        "         left(regexp_replace(coalesce(m.body->>'text',''),'\\s+',' ','g'),60) "
        "         in regexp_replace(coalesce(m2.body::text,''),'\\s+',' ','g')) > 0)::text "
        "from deliveries d join messages m on m.id = d.message_id "
        "where d.status in ('dead','failed') "
        f"  and d.terminal_at > now() - interval '{int(horas)} hours' "
        "  and coalesce(m.body->>'type','') = 'agent.response' "
        "order by d.terminal_at desc;", columnas=7)
    perdidas, rechazadas = {}, {}
    for f in filas:
        if len(f) < 7:
            continue
        tenant, destinatario, contesto, did, cuando, err, rescate = f[:7]
        err = (err or "").strip()
        item = {"tenant": tenant, "contesto": contesto, "id": did,
                "cuando": cuando, "error": err,
                "rescatada": (rescate or "0").strip() not in ("", "0")}
        destino = perdidas if error_de_transporte(err) else rechazadas
        destino.setdefault(destinatario, []).append(item)
    return perdidas, rechazadas


def conversaciones_paralelas(horas=24):
    """{(tenant, alias): [(sesion8, turnos, canales, ultimo)]} for aliases answered from MORE THAN ONE
    native conversation: the consumption witness of each done turn names the conversation that answered,
    and an alias with a shared TUI must answer from ONE. A second id is a turn that landed in a copy the
    person looking at the console never sees (kratos, 2026-10-08: Steven's console turns went headless)."""
    filas = sql(
        "with t as (select d.recipient_tenant tenant, d.recipient_alias alias, coalesce(m.auth_channel,'?') canal, "
        "  a.payload->'result'->'harness_consumption_v1'->>'native_session_id' sesion, d.terminal_at "
        "  from deliveries d join messages m on m.id = d.message_id "
        "  join delivery_acks a on a.delivery_id = d.id and a.applied and a.status = 'done' "
        f" where d.terminal_at > now() - interval '{int(horas)} hours'), "
        "s as (select tenant, alias, sesion, count(*) turnos, string_agg(distinct canal, ',') canales, "
        "  max(terminal_at) ultimo from t where sesion is not null group by 1, 2, 3), "
        "v as (select tenant, alias from s group by 1, 2 having count(*) > 1) "
        "select s.tenant, s.alias, left(s.sesion, 8), s.turnos::text, s.canales, "
        "  to_char(s.ultimo at time zone 'UTC', 'MM-DD HH24:MI') "
        "from s join v using (tenant, alias) order by s.alias, s.turnos desc;", columnas=6)
    paralelas = {}
    for tenant, alias, sesion, turnos, canales, ultimo in filas:
        paralelas.setdefault((tenant, alias), []).append((sesion, int(turnos), canales, ultimo))
    return paralelas


def captura_en_vuelo(alias):
    """What will be LOST if this alias is restarted. Captured BEFORE touching anything: if
    rescue fails, this metadata is the only thing that lets it be recovered by hand. Message
    bodies never enter the doctor's logs or reports."""
    filas = sql(
        "select d.id, d.message_id, m.actor_alias, m.tenant_id, m.room_id, m.lane, "
        "m.priority, m.request_id "
        "from deliveries d join messages m on m.id = d.message_id "
        "where d.recipient_alias = '{}' "
        "and d.status in ('leased','accepted','started');".format(alias.replace("'", "''")),
        columnas=8)
    return [{"delivery": f[0], "message": f[1], "actor": f[2], "tenant": f[3],
             "room": f[4], "lane": f[5], "priority": f[6], "request_id": f[7]}
            for f in filas if len(f) >= 8]
