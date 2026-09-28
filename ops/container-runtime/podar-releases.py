"""Poda la caché de releases de un alias dentro de su contenedor.

Conserva: la release activa (argv[2]), toda release que un proceso vivo nombre en cmdline/environ o
tenga como cwd/exe, toda release que nombre una configuración de arnés (MCP) y las `keep` más recientes. El supervisor vuelve a copiar la release
desde el staging del host en cada arranque, así que una release podada no se pierde: se recrea.
Uso: podar_releases.py <dir releases> <release activa> <keep> [--seco]
"""
import os, shutil, sys

root = os.path.realpath(sys.argv[1]); current = sys.argv[2]; keep = int(sys.argv[3]); seco = "--seco" in sys.argv
names = sorted(n for n in os.listdir(root)
               if os.path.isdir(os.path.join(root, n)) and not os.path.islink(os.path.join(root, n)))
live = set()
for pid in filter(str.isdigit, os.listdir("/proc")):
    for kind in ("cmdline", "environ"):
        try:
            data = open(f"/proc/{pid}/{kind}", "rb").read().replace(b"\0", b"\n").decode("utf-8", "replace") + "\n"
        except OSError:
            continue
        live.update(n for n in names if f"{root}/{n}/" in data or f"{root}/{n}\n" in data)
    for link in ("cwd", "exe"):
        try:
            t = os.readlink(f"/proc/{pid}/{link}")
        except OSError:
            continue
        live.update(n for n in names if t == f"{root}/{n}" or t.startswith(f"{root}/{n}/"))
# Configuraciones de arnés que nombran un binario de una release (MCP `cauce`, puentes): esa release
# puede no estar corriendo ahora y hace falta la próxima vez que el arnés levante el servidor.
import glob
REFS = ["/home/*/.claude.json", "/home/*/.claude/.claude.json", "/home/*/.claude/settings*.json", "/root/.claude.json",
        "/home/*/.codex/config.toml", "/root/.codex/config.toml", "/home/*/.openclaw/openclaw.json",
        "/home/*/.openclaw/agents/*/agent/codex-home/config.toml", "/home/*/.grok/config.toml",
        "/home/*/.mcp.json", "/home/*/*/.mcp.json", "/home/*/.config/cauce-v3/*.json", "/home/*/.hermes/*.yaml"]
referenciadas = set()
for pat in REFS:
    for f in glob.glob(pat):
        try:
            if os.path.getsize(f) > 8 * 1024 * 1024:
                continue
            txt = open(f, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        referenciadas.update(n for n in names if f"{root}/{n}/" in txt or f"{root}/{n}\"" in txt or f"{root}/{n}'" in txt)
live |= referenciadas
recent = sorted(names, key=lambda n: os.stat(os.path.join(root, n)).st_mtime, reverse=True)[:keep]
conservar = ({current} | live | set(recent)) & set(names)

def tam(p):
    total = 0
    for d, _, fs in os.walk(p):
        for f in fs:
            try:
                total += os.lstat(os.path.join(d, f)).st_blocks * 512
            except OSError:
                pass
    return total

liberado = 0; borradas = 0
for n in names:
    if n in conservar:
        continue
    p = os.path.join(root, n)
    liberado += tam(p); borradas += 1
    if not seco:
        shutil.rmtree(p)
print(f"{'SECO ' if seco else ''}poda {root}: {borradas} de {len(names)} borradas, {liberado/1e9:.2f} GB; "
      f"activa={current if current in names else 'AUSENTE:'+current}; vivas_o_referenciadas={sorted(live)}; recientes={recent}")
