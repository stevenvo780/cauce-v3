from __future__ import annotations

import os
import pathlib
import pwd
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
import provider_login_native
from provider_login_state import LoginFailure, validate_plan


class NativeHomeBoundaryTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='native-home-boundary-', dir='/var/tmp')
        self.root = pathlib.Path(self.temporary.name)
        self.passwd_home = self.root / 'passwd-home'
        self.passwd_home.mkdir(mode=0o700)
        self.home = self.passwd_home / 'operator-home'
        self.home.mkdir(mode=0o750)
        user = pwd.getpwuid(os.getuid())
        self.user = pwd.struct_passwd((user.pw_name, user.pw_passwd, user.pw_uid, user.pw_gid,
            user.pw_gecos, str(self.passwd_home), user.pw_shell))
        self.plan = {'runtime_user': user.pw_name, 'home': str(self.home), 'cwd': str(self.home), 'command': ['/usr/bin/true']}
        self.identity = mock.patch.object(provider_login_native.pwd, 'getpwnam', return_value=self.user)
        self.identity.start()

    def tearDown(self):
        self.identity.stop()
        self.temporary.cleanup()

    def test_accepts_owned_nested_home_without_changing_passwd_or_plan(self):
        original = dict(self.plan)
        self.assertEqual(provider_login_native.native_user(self.plan), self.user)
        self.assertEqual(self.plan, original)
        self.assertEqual(self.user.pw_dir, str(self.passwd_home))
        self.assertEqual(provider_login_native.native_user({**self.plan, 'home': str(self.passwd_home)}), self.user)
        child = self.home / 'working'
        child.mkdir(mode=0o700)
        self.plan['cwd'] = str(child)
        self.assertEqual(provider_login_native.native_user(self.plan), self.user)

    def test_rejects_escaped_noncanonical_and_other_home_or_cwd(self):
        foreign = self.root / 'foreign'
        foreign.mkdir(mode=0o700)
        for field, value in [('home', str(foreign)), ('cwd', str(foreign)),
                ('cwd', str(self.passwd_home)), ('home', str(self.home) + '/../operator-home'),
                ('cwd', str(self.home) + '//working'), ('home', str(self.home) + '/'), ('home', 'relative')]:
            with self.subTest(field=field, value=value):
                plan = {**self.plan, field: value}
                with self.assertRaises((LoginFailure, OSError)):
                    provider_login_native.native_user(plan)

    def test_rejects_symlinks_and_writable_home_cwd_or_parent(self):
        link = self.passwd_home / 'link'
        link.symlink_to(self.home, target_is_directory=True)
        for field in ('home', 'cwd'):
            with self.subTest(field=field), self.assertRaises((LoginFailure, OSError)):
                provider_login_native.native_user({**self.plan, field: str(link)})
        for directory in (self.passwd_home, self.home):
            for mode in (0o770, 0o707):
                with self.subTest(directory=directory, mode=mode):
                    directory.chmod(mode)
                    with self.assertRaises(LoginFailure):
                        provider_login_native.native_user(self.plan)
                    directory.chmod(0o750)
        child = self.home / 'working'
        child.mkdir(mode=0o777)
        child.chmod(0o777)
        with self.assertRaises(LoginFailure):
            provider_login_native.native_user({**self.plan, 'cwd': str(child)})

    def test_checks_intermediate_directory_owner_mode_and_symlink(self):
        parent = self.home / 'working-parent'
        parent.mkdir(mode=0o700)
        cwd = parent / 'working'
        cwd.mkdir(mode=0o700)
        plan = {**self.plan, 'cwd': str(cwd)}
        parent.chmod(0o770)
        with self.assertRaises(LoginFailure):
            provider_login_native.native_user(plan)
        parent.chmod(0o700)
        redirect = self.home / 'redirect'
        redirect.symlink_to(parent, target_is_directory=True)
        with self.assertRaises(OSError):
            provider_login_native.native_user({**plan, 'cwd': str(redirect / 'working')})

    def test_container_child_retains_exact_passwd_home_and_external_mounted_cwd(self):
        plan = {**self.plan, 'home': str(self.passwd_home), 'cwd': str(self.root)}
        self.assertEqual(provider_login_native.native_user(plan, child=True), self.user)
        with self.assertRaises(LoginFailure):
            provider_login_native.native_user(plan)
        with self.assertRaises(LoginFailure):
            provider_login_native.native_user(self.plan, child=True)
        packet = {**self.plan, 'operation_id': '74000000-0000-4000-8000-000000000001',
            'env': {}, 'backend': 'native', 'state_root': str(self.root), 'account_scope': 'fixture', 'child': True}
        with self.assertRaises(LoginFailure):
            validate_plan(packet)

    def test_rejects_foreign_owner_and_executor_uid_before_pins(self):
        with mock.patch.object(provider_login_native.os, 'geteuid', return_value=self.user.pw_uid + 1), \
                mock.patch.object(provider_login_native, 'pinned_digest') as pin:
            with self.assertRaises(LoginFailure):
                provider_login_native.native_user(self.plan)
            pin.assert_not_called()
        original = os.fstat
        def foreign_owner(fd):
            current = original(fd)
            return mock.Mock(st_uid=self.user.pw_uid + 1, st_mode=current.st_mode)
        with mock.patch.object(provider_login_native.os, 'fstat', side_effect=foreign_owner):
            with self.assertRaises(LoginFailure):
                provider_login_native.native_user(self.plan)


if __name__ == '__main__':
    unittest.main()
