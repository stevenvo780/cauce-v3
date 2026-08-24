"""Marca `tests/` como paquete para que `unittest discover` BAJE hasta aca.

Sin este fichero, `python3 -m unittest discover` lanzado desde `ops/pty-agent/` —que es la forma
natural de correr la suite, y la que se pide en los encargos— respondia:

    Ran 0 tests in 0.000s
    NO TESTS RAN

Cero pruebas y salida 0. Un verde que no probaba absolutamente nada, con 74 pruebas escritas al
lado sin ejecutarse. La unica invocacion que las corria era `cd tests && python3 -m unittest
discover`, que no esta escrita en ningun sitio.

No es cosmetico: cualquiera que agregue un fichero de pruebas aca y verifique con `discover`
desde la raiz del componente se lleva un OK sin haber corrido su prueba.
"""
