#!/usr/bin/env python3
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

import tomllib

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'scripts/decisiones-registrar-mcp.py'
BIN = '/opt/cauce-v3-adapter/zeus/releases/nueva/packages/adapter-sdk/dist/src/bin/cauce-decisiones-mcp.js'
SOCKET = '/home/dev/.local/state/cauce-v3/zeus/mcp-emission.sock'
SECRETO = 'clave-vecina-que-no-debe-imprimirse-0123456789'

ORIGINALES = {
    'claude': ('.claude.json', json.dumps({'mcpServers': {'cauce': {'type': 'stdio', 'command': '/usr/bin/node', 'args': ['/x/cauce-mcp.js', SOCKET]}},
                                            'otro': {'API_KEY': SECRETO}}, indent=2)),
    'openclaw': ('openclaw.json', json.dumps({'mcp': {'servers': {'cauce': {'command': '/usr/bin/node', 'args': ['/x/cauce-mcp.js', SOCKET]},
                                                                  'eikon': {'command': 'eikon', 'env': {'API_KEY': SECRETO}}}}})),
    'codex': ('config.toml', f'model = "gpt"\n\n[mcp_servers.eikon]\ncommand = "eikon"\nenv = {{ API_KEY = "{SECRETO}" }}\n'),
    'grok': ('config.toml', f'[mcp_servers.cauce]\ncommand = "node"\nargs = [\n    "/x/cauce-mcp.js",\n    "{SOCKET}",\n]\nenabled = true\n\n[models]\nkey = "{SECRETO}"\n'),
}


def servidores(arnes, texto):
    if arnes == 'claude':
        return json.loads(texto)['mcpServers']
    if arnes == 'openclaw':
        return json.loads(texto)['mcp']['servers']
    return tomllib.loads(texto)['mcp_servers']


class RegistrarMcp(unittest.TestCase):
    def correr(self, *argumentos):
        return subprocess.run([sys.executable, str(SCRIPT), *argumentos], capture_output=True, text=True, check=False)

    def test_simula_escribe_y_quita_en_los_cuatro_arneses_sin_imprimir_vecinos(self):
        for arnes, (nombre, contenido) in ORIGINALES.items():
            with self.subTest(arnes=arnes), tempfile.TemporaryDirectory() as temporal:
                ruta = pathlib.Path(temporal) / nombre
                ruta.write_text(contenido)
                ruta.chmod(0o600)
                base = ['--arnes', arnes, '--config', str(ruta), '--bin', BIN]
                if arnes == 'codex':
                    base += ['--socket', SOCKET]
                simulado = self.correr(*base)
                self.assertEqual(simulado.returncode, 0, simulado.stderr)
                self.assertEqual(ruta.read_text(), contenido)
                self.assertNotIn(SECRETO, simulado.stdout + simulado.stderr)
                aplicado = self.correr(*base, '--aplicar')
                self.assertEqual(aplicado.returncode, 0, aplicado.stderr)
                self.assertNotIn(SECRETO, aplicado.stdout)
                entrada = servidores(arnes, ruta.read_text())['cauce-decisiones']
                self.assertEqual(entrada['args'], [BIN, SOCKET])
                self.assertEqual(ruta.stat().st_mode & 0o777, 0o600)
                self.assertIn(SECRETO, ruta.read_text())
                self.assertEqual(len(list(pathlib.Path(temporal).glob(f'{nombre}.pre-cauce-decisiones.*'))), 1)
                antes = ruta.read_text()
                repetido = self.correr(*base, '--aplicar')
                self.assertEqual(repetido.returncode, 0, repetido.stderr)
                clave = '[mcp_servers.cauce-decisiones]' if arnes in ('codex', 'grok') else '"cauce-decisiones":'
                self.assertEqual(ruta.read_text(), antes)
                self.assertEqual(ruta.read_text().count(clave), 1)
                quitado = self.correr('--arnes', arnes, '--config', str(ruta), '--quitar', '--aplicar')
                self.assertEqual(quitado.returncode, 0, quitado.stderr)
                self.assertNotIn('cauce-decisiones', servidores(arnes, ruta.read_text()))

    def test_rechaza_enlaces_rutas_relativas_y_socket_desconocido(self):
        with tempfile.TemporaryDirectory() as temporal:
            real = pathlib.Path(temporal) / 'real.json'
            real.write_text('{}')
            enlace = pathlib.Path(temporal) / '.claude.json'
            enlace.symlink_to(real)
            self.assertNotEqual(self.correr('--arnes', 'claude', '--config', str(enlace), '--bin', BIN, '--socket', SOCKET).returncode, 0)
            self.assertNotEqual(self.correr('--arnes', 'claude', '--config', str(real), '--bin', 'relativo.js', '--socket', SOCKET).returncode, 0)
            self.assertNotEqual(self.correr('--arnes', 'claude', '--config', str(real), '--bin', BIN).returncode, 0)


if __name__ == '__main__':
    unittest.main()
