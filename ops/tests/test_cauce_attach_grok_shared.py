import contextlib
import io
import pathlib
import sys
import tempfile
import unittest
from importlib import machinery, util

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'ops/cli/cauce-attach'


def load_attach():
    loader = machinery.SourceFileLoader('cauce_attach_grok_shared_test', str(SOURCE))
    spec = util.spec_from_loader(loader.name, loader)
    module = util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class FakeSesiones:
    def __init__(self, harness):
        self.harness = harness

    def alias_info(self, _alias):
        return {'harness': self.harness, 'container': 'agv2-steven-hades-oc', 'user': 'claw', 'home': '/home/claw'}

    def inventario(self, _alias):
        return {'error': 'inventario no disponible en la prueba'}


class TestGrokSharedSessionGuard(unittest.TestCase):
    def setUp(self):
        sys.dont_write_bytecode = True
        self.attach = load_attach()
        self.config = tempfile.TemporaryDirectory()
        self.attach.CONFIG = self.config.name

    def tearDown(self):
        self.config.cleanup()

    def run_main(self, harness, *args):
        self.attach.sesiones_mod = lambda: FakeSesiones(harness)
        stderr = io.StringIO()
        original = sys.argv
        sys.argv = ['cauce-attach', 'hades', *args]
        try:
            with contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit):
                self.attach.main()
        finally:
            sys.argv = original
        return stderr.getvalue()

    def write_env(self, body):
        pathlib.Path(self.config.name, 'hades.env').write_text(body, encoding='utf-8')

    def test_shared_grok_alias_refuses_a_second_grok_process(self):
        self.write_env('BUNDLE_RELEASE=r\nSHARED_SESSION=1\n')
        for args in ((), ('--dm', '--bifurcar'), ('--sin-parar',)):
            message = self.run_main('grok', *args)
            self.assertIn('tiene sesion compartida', message)
            self.assertIn('cauce hades', message)

    def test_forzar_or_no_shared_session_keeps_the_previous_path(self):
        self.write_env('BUNDLE_RELEASE=r\nSHARED_SESSION=1\n')
        self.assertIn('no pude leer las sesiones', self.run_main('grok', '--forzar'))
        self.write_env('BUNDLE_RELEASE=r\n')
        self.assertIn('no pude leer las sesiones', self.run_main('grok', '--dm', '--bifurcar'))
        self.assertFalse(self.attach.compartida('otro'))

    def test_other_harnesses_are_not_blocked_by_the_grok_guard(self):
        self.write_env('BUNDLE_RELEASE=r\nSHARED_SESSION=1\n')
        self.assertIn('no pude leer las sesiones', self.run_main('claude'))


if __name__ == '__main__':
    unittest.main()
