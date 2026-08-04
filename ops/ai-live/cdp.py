"""Cliente CDP mínimo por WebSocket, sin dependencias.

Hace falta porque el endpoint HTTP de Chrome sólo abre y lista pestañas: para LEER lo que hay en
la página —que es donde aparece el código de autorización— hay que hablar el protocolo por
WebSocket. Son 60 líneas y evita meter una dependencia nueva en un contenedor de producción.
"""
import base64, json, os, socket, struct, urllib.parse, urllib.request


def _handshake(sock, host, ruta):
    clave = base64.b64encode(os.urandom(16)).decode()
    pedido = (
        "GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % (ruta, host, clave)
    )
    sock.sendall(pedido.encode())
    datos = b""
    while b"\r\n\r\n" not in datos:
        trozo = sock.recv(4096)
        if not trozo:
            raise RuntimeError("el servidor cerró durante el handshake")
        datos += trozo
    if b"101" not in datos.split(b"\r\n")[0]:
        raise RuntimeError("no hubo upgrade a websocket: %s" % datos[:80])


def _envia(sock, texto):
    carga = texto.encode()
    cabecera = bytearray([0x81])
    mascara = os.urandom(4)
    n = len(carga)
    if n < 126:
        cabecera.append(0x80 | n)
    elif n < 65536:
        cabecera.append(0x80 | 126); cabecera += struct.pack(">H", n)
    else:
        cabecera.append(0x80 | 127); cabecera += struct.pack(">Q", n)
    cabecera += mascara
    sock.sendall(bytes(cabecera) + bytes(b ^ mascara[i % 4] for i, b in enumerate(carga)))


def _recibe(sock):
    def leer(n):
        buf = b""
        while len(buf) < n:
            t = sock.recv(n - len(buf))
            if not t:
                raise RuntimeError("conexión cerrada")
            buf += t
        return buf
    b1, b2 = leer(2)
    largo = b2 & 0x7F
    if largo == 126:
        largo = struct.unpack(">H", leer(2))[0]
    elif largo == 127:
        largo = struct.unpack(">Q", leer(8))[0]
    return leer(largo).decode("utf-8", "replace")


class Pagina:
    """Una pestaña sobre la que se pueden evaluar expresiones."""

    def __init__(self, ws_url, timeout=30):
        u = urllib.parse.urlparse(ws_url)
        self.sock = socket.create_connection((u.hostname, u.port), timeout=timeout)
        self.sock.settimeout(timeout)
        _handshake(self.sock, "%s:%s" % (u.hostname, u.port), u.path + ("?" + u.query if u.query else ""))
        self.id = 0

    def llama(self, metodo, **params):
        self.id += 1
        _envia(self.sock, json.dumps({"id": self.id, "method": metodo, "params": params}))
        while True:
            msg = json.loads(_recibe(self.sock))
            if msg.get("id") == self.id:
                return msg

    def evalua(self, expresion):
        r = self.llama("Runtime.evaluate", expression=expresion, returnByValue=True, awaitPromise=True)
        return (((r.get("result") or {}).get("result")) or {}).get("value")

    def cierra(self):
        try: self.sock.close()
        except OSError: pass


def pestanas(puerto):
    with urllib.request.urlopen("http://127.0.0.1:%s/json/list" % puerto, timeout=15) as r:
        return json.loads(r.read().decode())


def abre(puerto, url):
    req = urllib.request.Request(
        "http://127.0.0.1:%s/json/new?%s" % (puerto, urllib.parse.quote(url, safe=":/?=&%")),
        method="PUT")
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read().decode())
