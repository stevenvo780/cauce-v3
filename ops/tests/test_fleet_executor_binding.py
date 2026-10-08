from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import test_fleet_executor as fixtures


class ApprovedLoginBindingTest(unittest.TestCase):
    setUp = fixtures.PhysicalExecutorTest.setUp
    tearDown = fixtures.PhysicalExecutorTest.tearDown
    save_policy = fixtures.PhysicalExecutorTest.save_policy
    configure_hooks = fixtures.PhysicalExecutorTest.configure_hooks
    run_step = fixtures.PhysicalExecutorTest.run_step

    def binding(self):
        return subprocess.run([sys.executable, str(fixtures.CLI), '--policy', str(self.policy_file), '--binding'],
            input=json.dumps(self.context), capture_output=True, text=True, timeout=10)

    def test_native_binding_is_approved_read_without_artifacts(self):
        self.configure_hooks()
        result = self.binding()
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt['profile_binding'], self.policy['profiles']['fixture-account'])
        self.assertEqual(receipt['agent']['runtime_user'], self.user)
        self.assertNotIn('_placement', receipt['agent'])
        self.assertNotIn('runtime_binding', receipt)
        self.assertEqual(list(self.roots['state'].iterdir()), [])

    def test_missing_profile_or_unapproved_runtime_is_closed(self):
        self.assertNotEqual(self.binding().returncode, 0)
        self.configure_hooks()
        self.context['request']['parameters']['placement']['runtime_user'] = 'unapproved'
        self.assertNotEqual(self.binding().returncode, 0)
        self.assertEqual(list(self.roots['state'].iterdir()), [])


if __name__ == '__main__':
    unittest.main()
