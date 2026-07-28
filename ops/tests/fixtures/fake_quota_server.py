#!/usr/bin/env python3
"""Servidor HTTPS descartable con mTLS obligatorio, usado SOLO por
ops/tests/test_quota_collector.py para probar el handshake y el POST reales del recolector
contra algo que exige certificado de cliente -- sin esto, los tests de red solo prueban el
camino de "conexion rechazada" y nunca el de un POST exitoso de punta a punta."""

from __future__ import annotations

import json
import ssl
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    received_bodies: list[dict] = []

    def log_message(self, format, *args):  # noqa: A002 - silenciar el access log en stdout
        pass

    def do_POST(self):
        length = int(self.headers.get('Content-Length', '0'))
        body = self.rfile.read(length)
        Handler.received_bodies.append(json.loads(body.decode('utf-8')))
        response = json.dumps({
            'collection_id': 'test-collection-id',
            'host': Handler.received_bodies[-1].get('host'),
            'captured_at': Handler.received_bodies[-1].get('captured_at'),
            'duplicate': False,
            'accepted_providers': len(Handler.received_bodies[-1].get('providers', [])),
            'accepted_windows': sum(
                len(g.get('windows', [])) for p in Handler.received_bodies[-1].get('providers', [])
                for g in p.get('groups', [])
            ),
            'unbound_groups': [],
            'paused_accounts': [],
            'resumed_accounts': [],
            'pruned_collections': 0,
        }).encode('utf-8')
        self.send_response(202)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(response)))
        self.end_headers()
        self.wfile.write(response)


def start(pki_dir: str, port: int) -> HTTPServer:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile=f'{pki_dir}/server.crt', keyfile=f'{pki_dir}/server.key')
    ctx.load_verify_locations(cafile=f'{pki_dir}/ca.crt')
    ctx.verify_mode = ssl.CERT_REQUIRED  # exige cert de cliente: es el punto del test
    server = HTTPServer(('127.0.0.1', port), Handler)
    server.socket = ctx.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


if __name__ == '__main__':
    pki_dir, port = sys.argv[1], int(sys.argv[2])
    srv = start(pki_dir, port)
    print(f'listening on {port}', flush=True)
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        srv.shutdown()
