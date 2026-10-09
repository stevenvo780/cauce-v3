#!/usr/bin/env python3
"""Cuota de asiento Codex (ChatGPT) por HTTP puro, SIN navegador y SIN el CLI `codex`.

Lee `auth.json` de uno o varios CODEX_HOME en SOLO LECTURA y consulta el endpoint de
uso del asiento. Emite el contrato JSON comun del medidor de cuotas de la flota.

REGLAS QUE NO SE TOCAN (cada una tiene su motivo, no son formalismo):

  * NUNCA se invoca el binario `codex` (ni `codex login`, ni `codex app-server`).
    Arrancarlo hace que el CLI refresque y REESCRIBA el auth.json compartido, lo que
    revoca la cadena de credenciales viva de toda la flota. Medir no puede costar
    tumbar a los agentes: por eso esto es HTTP a pelo.

  * NUNCA se escribe auth.json ni se refresca el token. Si esta vencido o revocado,
    la sonda devuelve error y la cuenta sale "sin dato" ese ciclo. Un hueco en el
    panel es barato; rotarle el token a las sesiones vivas, no.

  * NUNCA se imprime un secreto. Del auth.json solo salen datos derivados no
    sensibles (email, plan, account_id, caducidad). El token jamas va a stdout, ni a
    un log, ni a la linea de comandos (`ps` es publico y el panel es compartido).

Uso:
    codex-http-probe.py [CODEX_HOME ...]
Por defecto mide los dos CODEX_HOME de kratos:
    /datos/agents/shared/.codex  y  /datos/agents/shared/.codex-200

kant, 2026-09-05.
"""

import base64
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

ESQUEMA = 1

# Los dos CODEX_HOME de kratos. En ils-server son ~/.codex y ~/.codex-200: se pasan
# por argumento, no se adivinan aqui.
HOMES_POR_DEFECTO = [
    "/datos/agents/shared/.codex",
    "/datos/agents/shared/.codex-200",
]

# wham/usage es el que usa el cliente de asiento; codex/usage devuelve HOY el MISMO
# esquema (verificado, byte a byte salvo los `reset_after_seconds`). Se
# mantiene como segundo intento por si OpenAI jubila uno de los dos: nos quedamos con
# el primero que conteste con ventanas utiles.
ENDPOINTS = [
    "https://chatgpt.com/backend-api/wham/usage",
    "https://chatgpt.com/backend-api/codex/usage",
]

# Presupuesto TOTAL de red, no por intento: el contrato del colector exige <= 25 s
# para la sonda entera, y aqui puede haber 2 endpoints x N cuentas.
PRESUPUESTO_RED_S = 25.0

# Clave estable de cuenta. Se indexa por ACCOUNT_ID, no por ruta, a proposito:
# el mismo asiento aparece en varios CODEX_HOME (p.ej. /datos/agents/jhon-config/.codex
# lleva el mismo account_id que .codex-200 pero con token fresco: es su relevo). Si
# indexaramos por ruta, el panel contaria dos veces la misma cuota. Indexando por
# asiento, el dir que tenga token vivo es el que reporta.
CLAVE_POR_ACCOUNT = {
    "56121ead-a9bb-4c23-9918-cc147deb3686": "codex-b2b",   # b2b@polidinamica.com
    "b5fbdfe7-2b45-47f7-abca-c4cbf40f6fd3": "codex200",    # stevenvallejo780@gmail.com
}

# Nombres humanos de ventana a partir de su duracion. OJO: NO se puede asumir que la
# ventana "primary" sea la de 5h. Verificado en la cuenta pro b2b: viene
# primary_window con limit_window_seconds=604800 (semanal) y secondary_window=null.
# Etiquetar primary como "5h" a ciegas produciria un panel que miente.
NOMBRE_VENTANA = {
    3600: "1h",
    18000: "5h",
    86400: "dia",
    604800: "7d",
    2592000: "30d",
}


def iso(epoch):
    """Epoch (segundos) -> ISO8601 UTC. El contrato pide ISO, la API da epoch."""
    if epoch in (None, "", 0):
        return None
    try:
        return datetime.fromtimestamp(float(epoch), timezone.utc).isoformat().replace("+00:00", "Z")
    except Exception:
        return None


def host_actual():
    h = socket.gethostname().split(".")[0]
    if h.startswith("srv") or h.startswith("vps"):
        return "vps"
    return h  # kratos / ils-server / server1 se llaman igual que su alias


def claims(jwt):
    """Payload de un JWT SIN verificar firma. Solo lo usamos para datos descriptivos
    (email, plan, caducidad); nada de autorizacion depende de esto, asi que no
    validar la firma es aceptable y nos ahorra dependencias."""
    if not jwt or jwt.count(".") != 2:
        return {}
    pl = jwt.split(".")[1]
    pl += "=" * (-len(pl) % 4)
    try:
        return json.loads(base64.urlsafe_b64decode(pl))
    except Exception:
        return {}


def nombre_ventana(segundos, respaldo):
    if segundos in NOMBRE_VENTANA:
        return NOMBRE_VENTANA[segundos]
    if isinstance(segundos, (int, float)) and segundos > 0:
        s = int(segundos)
        return f"{s // 3600}h" if s % 3600 == 0 else f"{s}s"
    return respaldo


def ventanas_de(rl, prefijo=""):
    """Normaliza un bloque rate_limit {primary_window, secondary_window} a la lista
    "ventanas" del contrato. La clave sale de la DURACION, no de la posicion."""
    salida = []
    for pos, respaldo in (("primary_window", "primaria"), ("secondary_window", "secundaria")):
        v = (rl or {}).get(pos)
        if not isinstance(v, dict):
            continue
        clave = prefijo + nombre_ventana(v.get("limit_window_seconds"), respaldo)
        pct = v.get("used_percent")
        salida.append({
            "clave": clave,
            "usado_pct": float(pct) if isinstance(pct, (int, float)) else None,
            "reset_at": iso(v.get("reset_at")),
        })
    return salida


def base(codex_home):
    """Esqueleto del contrato. Se rellena siempre, incluso al fallar, para que la
    sonda NUNCA imprima algo que el colector no sepa parsear."""
    return {
        "esquema": ESQUEMA,
        "proveedor": "codex",
        "cuenta": "codex:" + os.path.basename(codex_home.rstrip("/")),
        "identidad": None,
        "plan": None,
        "fuente": "wham-http",
        "host": host_actual(),
        "fetched_at": time.time(),
        "ventanas": [],
        "extra": {"codex_home": codex_home, "estado": "sin_dato"},
        "error": None,
    }


def pedir(url, token, account_id, timeout):
    req = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + token,
        "ChatGPT-Account-Id": account_id,
        "Accept": "application/json",
        # UA de cliente de asiento: el endpoint es el que alimenta al CLI y responde
        # mejor a un UA reconocible que a python-urllib.
        "User-Agent": "codex-cli/rust",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def sonda(codex_home):
    out = base(codex_home)

    # --- 1. Leer credencial (SOLO LECTURA, sin bloquear el fichero) --------------
    ruta = os.path.join(codex_home, "auth.json")
    try:
        with open(ruta) as f:
            auth = json.load(f)
    except FileNotFoundError:
        out["error"] = f"no existe {ruta}"
        out["extra"]["estado"] = "sin_credencial"
        return out
    except Exception as e:
        out["error"] = f"auth.json ilegible ({type(e).__name__}: {e})"
        out["extra"]["estado"] = "sin_credencial"
        return out

    tokens = auth.get("tokens") or {}
    token = tokens.get("access_token")
    account_id = tokens.get("account_id")

    # Identidad y plan salen del id_token; si no, del propio access_token. Es gratis
    # y sirve para etiquetar la cuenta aunque la peticion HTTP acabe fallando.
    c_id = claims(tokens.get("id_token"))
    c_acc = claims(token)
    autor = (c_id.get("https://api.openai.com/auth") or {})
    autor_acc = (c_acc.get("https://api.openai.com/auth") or {})
    out["identidad"] = c_id.get("email") or None
    out["plan"] = autor.get("chatgpt_plan_type") or autor_acc.get("chatgpt_plan_type")
    account_id = account_id or autor_acc.get("chatgpt_account_id")
    if account_id:
        out["cuenta"] = CLAVE_POR_ACCOUNT.get(account_id, "codex-" + account_id[:8])
        out["extra"]["account_id"] = account_id
    out["extra"]["last_refresh"] = auth.get("last_refresh")
    exp = c_acc.get("exp")
    out["extra"]["token_expira_at"] = iso(exp)

    if not token:
        # Modo API key: hay OPENAI_API_KEY pero no asiento OAuth. No hay cuota de
        # asiento que medir; se dice, no se inventa.
        if auth.get("OPENAI_API_KEY"):
            out["error"] = "auth.json en modo API key: no hay asiento OAuth que medir"
        else:
            out["error"] = "auth.json sin tokens.access_token"
        out["extra"]["estado"] = "sin_credencial"
        return out
    if not account_id:
        out["error"] = "auth.json sin account_id (cabecera ChatGPT-Account-Id obligatoria)"
        out["extra"]["estado"] = "sin_credencial"
        return out

    # Vencimiento local: se comprueba ANTES de salir a red para no gastar una
    # peticion condenada. Pero NO es suficiente para detectar revocacion: el token de
    # codex200 esta *vigente* y aun asi el servidor lo rechaza con
    # 401 token_revoked. Vencido y revocado son dos estados distintos.
    if isinstance(exp, (int, float)) and exp <= time.time():
        out["error"] = f"access token vencido el {iso(exp)} (no se refresca a proposito)"
        out["extra"]["estado"] = "token_invalidado"
        return out

    # --- 2. Consultar el endpoint de uso ----------------------------------------
    limite = time.time() + PRESUPUESTO_RED_S
    datos = None
    fallos = []
    for url in ENDPOINTS:
        restante = limite - time.time()
        if restante <= 1.0:
            fallos.append(f"sin presupuesto de tiempo para {url}")
            break
        try:
            datos = pedir(url, token, account_id, min(restante, PRESUPUESTO_RED_S))
            out["extra"]["endpoint"] = url
            out["fuente"] = "wham-http"
            break
        except urllib.error.HTTPError as e:
            cuerpo = ""
            try:
                cuerpo = e.read().decode("utf-8", "replace")[:300]
            except Exception:
                pass
            if e.code in (401, 403):
                # Credencial rechazada: reintentar en el otro endpoint no arregla un
                # token muerto, solo suma ruido y otro 401 a la cuenta. Se corta aqui.
                # (Tampoco se refresca: eso reescribiria el auth.json de la flota.)
                motivo = "revocado/invalidado" if ("invalidated" in cuerpo or "token_revoked" in cuerpo) \
                    else "rechazado"
                out["error"] = (f"token {motivo} por el servidor (HTTP {e.code}). Reautenticar ese CODEX_HOME "
                                f"a mano; la sonda no refresca.")
                out["extra"]["estado"] = "token_invalidado"
                out["extra"]["http_status"] = e.code
                out["extra"]["respuesta_servidor"] = cuerpo
                return out
            if e.code == 429:
                out["error"] = "HTTP 429: el propio endpoint de uso esta limitando la sonda"
                out["extra"]["estado"] = "fallo_de_red"
                out["extra"]["http_status"] = e.code
                return out
            fallos.append(f"HTTP {e.code} en {url}: {cuerpo}")
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            fallos.append(f"{type(e).__name__} en {url}: {e}")
        except Exception as e:
            fallos.append(f"{type(e).__name__} en {url}: {e}")

    if datos is None:
        out["error"] = "fallo de red/endpoint: " + " | ".join(fallos)[:300]
        out["extra"]["estado"] = "fallo_de_red"
        return out

    # --- 3. Normalizar al contrato ----------------------------------------------
    out["identidad"] = datos.get("email") or out["identidad"]
    out["plan"] = datos.get("plan_type") or out["plan"]

    rl = datos.get("rate_limit") or {}
    out["ventanas"].extend(ventanas_de(rl))

    # Ventanas adicionales (hoy: el cubo Spark de GPT-5.3-Codex, con sus propias 5h y
    # semanal). Se prefijan con el nombre del limite para no pisar las principales.
    for ad in (datos.get("additional_rate_limits") or []):
        nombre = ad.get("limit_name") or ad.get("metered_feature") or "adicional"
        out["ventanas"].extend(ventanas_de(ad.get("rate_limit"), prefijo=nombre + ":"))

    # Limite de revision de codigo, cuando existe (suele venir null).
    if datos.get("code_review_rate_limit"):
        out["ventanas"].extend(ventanas_de(datos["code_review_rate_limit"], prefijo="code_review:"))

    # Estado "cuota agotada" NO es un error: la medicion es valida y vale oro. Se
    # marca en extra y se deja error=null para que el colector no descarte el dato.
    #
    # La senal autoritativa es `allowed`/`limit_reached`, NUNCA el porcentaje.
    # Verificado contra el asiento de stevenvallejo780: used_percent=100
    # con allowed=true y limit_reached=false, o sea al tope de la ventana pero AUN
    # SIRVIENDO. Dar por muerta esa cuenta por el 100% dejaria al panel enrutando el
    # trabajo fuera de un asiento que funciona. Ese caso se etiqueta "al_limite".
    tope = any((v["usado_pct"] or 0) >= 100 for v in ventanas_de(rl))
    if bool(rl.get("limit_reached")) or rl.get("allowed") is False:
        out["extra"]["estado"] = "cuota_agotada"
    else:
        out["extra"]["estado"] = "al_limite" if tope else "ok"
    out["extra"]["limite_alcanzado"] = bool(rl.get("limit_reached"))
    out["extra"]["permitido"] = rl.get("allowed")

    creditos = datos.get("credits") or {}
    if creditos:
        out["extra"]["creditos"] = {
            "tiene": creditos.get("has_credits"),
            "ilimitado": creditos.get("unlimited"),
            "saldo": creditos.get("balance"),
            "tope_excedente_alcanzado": creditos.get("overage_limit_reached"),
        }
    # "Creditos de reset": los usos con los que se puede resetear la ventana a mano.
    # Son lo que decide si una cuenta al 100% esta realmente muerta o rescatable.
    rrc = datos.get("rate_limit_reset_credits") or {}
    if rrc:
        out["extra"]["creditos_reset"] = {
            "disponibles": rrc.get("available_count"),
            "aplicables": rrc.get("applicable_available_count"),
        }
    if datos.get("model_usage"):
        out["extra"]["modelos"] = datos["model_usage"]
    if datos.get("spend_control"):
        out["extra"]["control_gasto"] = datos["spend_control"]
    if datos.get("rate_limit_reached_type"):
        out["extra"]["tipo_limite"] = datos["rate_limit_reached_type"]

    return out


def main():
    homes = sys.argv[1:] or HOMES_POR_DEFECTO
    res = []
    for h in homes:
        try:
            res.append(sonda(h))
        except Exception as e:
            # Red de seguridad: pase lo que pase, sale JSON valido. El colector no
            # debe tener que distinguir una traza de un resultado.
            r = base(h)
            r["error"] = f"fallo interno de la sonda ({type(e).__name__}: {e})"
            r["extra"]["estado"] = "fallo_de_red"
            res.append(r)
    json.dump(res if len(res) > 1 else res[0], sys.stdout, ensure_ascii=False)
    print()
    return 0 if all(r["error"] is None for r in res) else 1


if __name__ == "__main__":
    sys.exit(main())
