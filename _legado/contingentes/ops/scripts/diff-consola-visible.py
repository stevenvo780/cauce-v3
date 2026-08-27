#!/usr/bin/env python3
"""Muestra las diferencias visibles entre dos builds de la consola y la distribución por ruta.

Uso:
    ops/scripts/diff-consola-visible.py VIEJO.js NUEVO.js [VIEJO.css NUEVO.css] [--todo]

Los ficheros se extraen del dist de cada imagen:
    cid=$(docker create IMAGEN); docker cp $cid:/usr/share/nginx/html/assets DESTINO; docker rm $cid

Salida: textos visibles y selectores que entran y salen, y el reparto por prefijo de selector.
"""
import re
import sys


PROSA = re.compile(r"[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9 ,.:;¡!¿?%'«»-]{7,}")
CODIGO = re.compile(r"\bvar\b|\bfunction\b|\breturn\b|\bconst\b|\btypeof\b|\bnull\b|\bundefined\b")


def textos_visibles(js: str) -> set[str]:
    """Extrae tramos legibles de prosa del bundle JS."""
    fuera = set()
    for bruto in PROSA.findall(js):
        t = bruto.strip(" .,:;-")
        if not 7 < len(t) < 200:
            continue
        if ' ' not in t:
            continue
        if CODIGO.search(t):
            continue
        fuera.add(t)
    return fuera


def selectores(css: str) -> set[str]:
    return set(re.findall(r'\.([a-zA-Z][a-zA-Z0-9_-]{2,})', css))


CASTELLANO = re.compile(r"[áéíóúñÁÉÍÓÚÑ«»¿¡]")


def bloque(titulo: str, items: set[str], todo: bool, clasificar: bool = True) -> None:
    """Imprime el diff separando el copy con caracteres especiales del resto."""
    if not clasificar:
        print(f'\n== {titulo}: {len(items)} ==')
        for t in sorted(items):
            print(f'   {t}')
        return
    seguros = {t for t in items if CASTELLANO.search(t)}
    resto = items - seguros
    print(f'\n== {titulo}: {len(seguros)} de copy + {len(resto)} dudosos ==')
    for t in sorted(seguros):
        print(f'   {t}')
    if resto:
        if todo:
            print('   --- dudosos (prosa arrastrada por el renombrado del minificador) ---')
            for t in sorted(resto):
                print(f'   ? {t}')
        else:
            print(f'   ({len(resto)} tramos dudosos ocultos; --todo los lista)')


def reparto(nuevos: set[str]) -> None:
    """Agrupa por el primer tramo del selector. Un solo grupo = un solo sitio donde se ve."""
    grupos: dict[str, int] = {}
    for s in nuevos:
        grupos[s.split('-')[0]] = grupos.get(s.split('-')[0], 0) + 1
    print('\n== reparto de los selectores nuevos por prefijo ==')
    for pref, n in sorted(grupos.items(), key=lambda kv: -kv[1]):
        print(f'   {pref+"-":16} {n}')
    if len(grupos) == 1:
        pref = next(iter(grupos))
        print(f'\n   >>> TODO lo nuevo lleva el prefijo «{pref}-». Antes de cantar el despliegue,')
        print(f'   >>> di en que RUTA se pinta ese prefijo y avisa de que fuera de ella no')
        print(f'   >>> cambio un solo pixel. Si el dueno esta en otra pagina, no vera nada.')


def main() -> int:
    args = [a for a in sys.argv[1:] if a != '--todo']
    todo = '--todo' in sys.argv
    if len(args) not in (2, 4):
        print(__doc__)
        return 2
    viejo_js, nuevo_js = (open(p, encoding='utf-8', errors='replace').read() for p in args[0:2])
    a, b = textos_visibles(viejo_js), textos_visibles(nuevo_js)
    bloque('TEXTOS que entran', b - a, todo)
    bloque('TEXTOS que salen', a - b, todo)

    if len(args) == 4:
        viejo_css, nuevo_css = (open(p, encoding='utf-8', errors='replace').read() for p in args[2:4])
        sa, sb = selectores(viejo_css), selectores(nuevo_css)
        bloque('SELECTORES que entran', sb - sa, True, clasificar=False)
        bloque('SELECTORES que salen', sa - sb, True, clasificar=False)
        if sb - sa:
            reparto(sb - sa)

    if not (b - a) and not (a - b):
        print('\n>>> NINGUN texto visible cambio. Si el despliegue prometia algo que se ve,')
        print('>>> aqui tienes el fallo: no llego. No lo cantes como hecho.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
