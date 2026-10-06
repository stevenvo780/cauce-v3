from __future__ import annotations

import copy
import csv
import importlib.util
import json
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import test_praxis_preview as previews
import test_praxis_supervision as fixtures

# cauce:requiere none

SUP = fixtures.SUP


class OptionalProjectTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.PraxisSupervisionTests()
        self.fixture.setUp()
        self.profile = copy.deepcopy(SUP.STATE.PROFILE.DEFAULT)
        self.profile.update(project_name="Laboratorio Delta", tenant_id="EmpresaDelta", room_id="grp.delta",
            supervisor_alias="delta-watch", recipient_alias="jefe", participants=["jefe", "ingeniero"],
            postgres_container="delta-db-1", postgres_user="delta_user", postgres_database="delta_database",
            workspace=str(self.fixture.workspace), actor_container="delta-engineer-1", actor_workspace="/srv/delta/project",
            acceptance_root=str(self.fixture.directory / "control"), state_path=str(self.fixture.directory / "control/state.json"),
            config_path=str(self.fixture.directory / "control/config.json"), issue_count=38, roadmap_count=217,
            deferred_issues=[], root_text="Continuar el objetivo autorizado de Delta con datos sintéticos.", preview=None,
            acceptance_origin={"kind": "authenticated-owner", "channel": "cauce.trusted-origin", "conversation_id": "delta-owner"})
        self.config = {**self.fixture.config, "project_profile": self.profile,
                       "project_profile_sha256": SUP.STATE.PROFILE.fingerprint(self.profile), "issue_count": 38,
                       "roadmap_count": 217, "preview_files": {}}
        self.config.pop("preview_root")

    def tearDown(self):
        self.fixture.tearDown()

    def load(self):
        path = self.fixture.directory / "config.json"
        path.write_text(json.dumps(self.config))
        return SUP.load_config(path)

    def test_other_project_counts_and_no_preview_have_readable_fingerprinted_profile(self):
        self.load()
        with (self.fixture.workspace / "ISSUES.csv").open("w") as stream:
            writer=csv.writer(stream)
            writer.writerow(["order", "id", "phase", "title", "hito", "status", "owner", "evidence", "blocker", "source"])
            for number in range(38):
                writer.writerow([number, f"DELTA{number}", "phase", "title", "hito", "pending", "", "", "", ""])
        self.fixture.write_json("roadmap.json", {"goal_sha256": self.config["goal_sha256"], "issues": [
            {"id": f"DELTA{number}", "criteria": [{"id": f"C{index}", "text": "Implementar criterio completo"}
                for index in range(6 if number < 27 else 5)]} for number in range(38)]})
        def git(command, deadline, config=None):
            return "" if "status" in command or "diff" in command else fixtures.HEAD
        with mock.patch.object(SUP, "run_command", side_effect=git):
            evidence=SUP.engineering_snapshot(self.config,time.monotonic()+55)
        self.assertEqual((evidence["issues_total"],evidence["roadmap_total"]),(38,217))
        self.assertEqual(evidence["files"],{})
        self.assertEqual(SUP.PREVIEW.publish(self.config,evidence,{},time.monotonic()+55,SUP.STATE,
            mock.Mock(),mock.Mock(),mock.Mock())["action"],"preview_disabled")
        self.assertFalse(evidence["completion_candidate"])

    def test_external_profile_readability_and_fingerprint_are_checked(self):
        path=self.fixture.directory / "project.json"
        path.write_text(json.dumps(self.profile))
        self.config.pop("project_profile")
        self.config["project_profile_file"]=str(path)
        self.assertEqual(self.load()["project_profile"]["tenant_id"],"EmpresaDelta")
        path.write_text(json.dumps({**self.profile,"room_id":"grp.tampered"}))
        with self.assertRaisesRegex(SUP.SupervisionError,"fingerprint_mismatch"):
            self.load()
        path.chmod(0o666)
        with self.assertRaisesRegex(SUP.SupervisionError,"untrusted_control_file"):
            self.load()

    def test_unsafe_paths_unknown_keys_and_unprivileged_bounds_are_rejected(self):
        for mutation in ({"workspace":"/srv/project/../secrets"},{"actor_workspace":"/srv/credentials"},
                         {"actor_uid":0},{"participants":["jefe", "jefe"]}, {"tenant_id":"quote'unsafe"},
                         {"extra":"ignored"}):
            with self.subTest(mutation=mutation):
                value={**self.profile,**mutation}
                self.config.update(project_profile=value,project_profile_sha256=SUP.STATE.PROFILE.fingerprint(value))
                with self.assertRaises(SUP.SupervisionError):
                    self.load()
        self.config.update(project_profile=self.profile,project_profile_sha256=SUP.STATE.PROFILE.fingerprint(self.profile))
        self.config["issues_file"]="../ISSUES.csv"
        with self.assertRaisesRegex(SUP.SupervisionError,"artifact_scope"):
            self.load()

    def test_another_container_scope_payload_and_read_only_sql_are_used(self):
        self.load()
        actors=[{"alias":actor,"enabled":True,"online":True,"heartbeat_age":3} for actor in self.profile["participants"]]
        data={"observed_at":time.time(),"open_gates":0,"actors":actors,"work":{status:0 for status in SUP.OPEN}}
        with mock.patch.object(SUP,"run_command",return_value=json.dumps(data)) as command:
            self.assertTrue(SUP.runtime_snapshot(self.config,time.monotonic()+55)["ready"])
        argv=command.call_args.args[0]
        self.assertIn("delta-db-1",argv)
        self.assertIn("delta_user",argv)
        sql=command.call_args.args[2]
        self.assertIn("BEGIN READ ONLY",sql)
        self.assertIn("'EmpresaDelta'",sql)
        self.assertNotIn("Hospital",sql)
        with mock.patch.object(SUP.STATE.os,"geteuid",return_value=0), mock.patch.object(SUP.STATE.Path,"stat",return_value=mock.Mock(st_uid=1000)):
            isolated=SUP.STATE.isolated_command(["git","-C",str(self.fixture.workspace),"status"],self.config)
        self.assertIn("delta-engineer-1",isolated)
        self.assertIn("/srv/delta/project",isolated)
        supervisor=SUP.Supervisor(self.config,Path(self.profile["state_path"]),self.fixture.api,fixtures.NOW)
        payload=supervisor.payload("idempotent","synthetic request")
        self.assertEqual(payload["room_id"],"grp.delta")
        self.assertEqual(payload["recipients"],[{"tenant_id":"EmpresaDelta","alias":"jefe"}])
        receipt={"request_id":"request", "trace_id":"trace", "body":{"type":"request"},
            "deliveries":[{"tenant_id":"Hospital","alias":"operador","delivery_id":"delivery"}]}
        binding={"request_id":"request","trace_id":"trace","body_type":"request",
            "body_sha256":SUP.digest(SUP.canonical(receipt["body"])),"delivery_ids":["delivery"]}
        self.assertFalse(SUP.STATE.receipt_matches(receipt,binding,self.config))
        receipt["deliveries"][0].update(tenant_id="EmpresaDelta",alias="jefe")
        self.assertTrue(SUP.STATE.receipt_matches(receipt,binding,self.config))

    def test_state_and_notifications_cannot_change_scope_or_authority(self):
        root=Path(self.profile["acceptance_root"])
        root.mkdir(mode=0o700)
        state_path=Path(self.profile["state_path"])
        supervisor=SUP.Supervisor(self.config,state_path,self.fixture.api,fixtures.NOW)
        supervisor.save()
        changed={**self.profile,"tenant_id":"ForeignCompany"}
        config={**self.config,"project_profile":changed,"project_profile_sha256":SUP.STATE.PROFILE.fingerprint(changed)}
        with self.assertRaisesRegex(SUP.SupervisionError,"foreign_state_project"):
            SUP.Supervisor(config,state_path,self.fixture.api,fixtures.NOW)
        self.profile["notification"]["enabled"]=False
        self.config["project_profile_sha256"]=SUP.STATE.PROFILE.fingerprint(self.profile)
        state_path.unlink()
        supervisor=SUP.Supervisor(self.config,state_path,self.fixture.api,fixtures.NOW)
        supervisor.notice("measured","digest","synthetic notice")
        self.assertEqual(self.fixture.api.posts,[])
        self.profile["tenant_id"]="tampered"
        with self.assertRaisesRegex(SUP.SupervisionError,"fingerprint_mismatch"):
            supervisor.publish({"payload":supervisor.payload("synthetic-key","request")})
        self.assertEqual(self.fixture.api.posts,[])

    def test_main_resolves_company_state_before_lock_and_rejects_foreign_state(self):
        config_path=self.fixture.directory/"config.json"
        self.config["pass_seconds"]=55
        supervisor=mock.Mock()
        supervisor.owner_stop.return_value={"action":"owner_stopped"}
        argv=["supervision","--config",str(config_path),"--observe-only"]
        with mock.patch.object(SUP,"load_config",return_value=self.config), mock.patch.object(SUP,"Supervisor",return_value=supervisor) as create, \
                mock.patch.object(sys,"argv",argv), mock.patch.object(SUP,"StateLock",wraps=SUP.STATE.StateLock) as lock:
            self.assertEqual(SUP.main(),0)
            own=Path(self.profile["state_path"])
            lock.assert_called_once_with(own.parent/"pass.lock")
            self.assertEqual(create.call_args.args[1],own)
            self.assertTrue((own.parent/"pass.lock").is_file())
        with mock.patch.object(SUP,"load_config",return_value=self.config), mock.patch.object(SUP,"StateLock") as lock, \
                mock.patch.object(sys,"argv",[*argv,"--state",SUP.STATE.PROFILE.DEFAULT["state_path"]]):
            self.assertEqual(SUP.main(),1)
            lock.assert_not_called()

    def test_main_rejects_noncanonical_relative_and_symlink_state_before_lock(self):
        self.config["pass_seconds"]=55
        alias=self.fixture.directory/"control-link"
        alias.symlink_to(Path(self.profile["acceptance_root"]),target_is_directory=True)
        unsafe=[str(Path(self.profile["acceptance_root"])/"../foreign/state.json"),"relative/state.json",str(alias/"state.json")]
        for path in unsafe:
            with self.subTest(path=path), mock.patch.object(SUP,"load_config",return_value=self.config), \
                    mock.patch.object(SUP,"StateLock") as lock, mock.patch.object(sys,"argv",["supervision","--state",path]):
                self.assertEqual(SUP.main(),1)
                lock.assert_not_called()
        self.assertFalse((self.fixture.directory/"foreign").exists())
        self.assertFalse(Path(self.profile["acceptance_root"]).exists())

    def test_profile_change_cannot_resume_foreign_reserved_scope(self):
        goal=self.config["goal_sha256"]
        root={"error":"unauthorized","attempts":1,"baseline":{"goal_sha256":goal},
              "payload":{"room_id":"grp.hospital","recipients":[{"tenant_id":"Hospital","alias":"operador"}],
                         "idempotency_key":"praxis-engineering:"+goal[:16]+":00000000-0000-4000-8000-000000000001",
                         "body":{"type":"praxis.supervision.continue"}}}
        self.assertFalse(SUP.STATE.resumable_reservation(root,goal,self.config))
        root["payload"].update(room_id="grp.delta",recipients=[{"tenant_id":"EmpresaDelta","alias":"jefe"}])
        self.assertTrue(SUP.STATE.resumable_reservation(root,goal,self.config))


class InstallationDelegationTests(unittest.TestCase):
    def setUp(self):
        path=fixtures.PROGRAM.with_name("install-profile.py")
        spec=importlib.util.spec_from_file_location("installation_profile_test",path)
        self.install=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.install)
        self.fake=SimpleNamespace(load_instance_descriptor=mock.Mock(return_value={"paths":{"state":"/srv/delta/state"}}),
                                  InstanceError=ValueError)

    def invoke(self,action="plan"):
        with mock.patch.dict(sys.modules,{"instance":self.fake}), mock.patch.object(sys,"path",list(sys.path)), \
                mock.patch.object(sys,"argv",["install-profile.py",action,"--descriptor","/srv/delta/instance.json"]):
            return self.install.main()

    def test_absent_project_integration_delegates_to_common_without_loading_supervisor(self):
        with mock.patch.object(self.install,"load_supervision") as supervisor, mock.patch.object(self.install.os,"execv") as launch:
            self.invoke()
        supervisor.assert_not_called()
        self.fake.load_instance_descriptor.assert_called_once_with(Path("/srv/delta/instance.json"))
        self.assertEqual(launch.call_args.args[1][-3:],["plan","--descriptor","/srv/delta/instance.json"])
        self.assertTrue(launch.call_args.args[1][1].endswith("ops/instances/common/cauce-instance"))

    def test_update_delegates_to_common_update_without_duplicate_installer(self):
        with mock.patch.object(self.install,"load_supervision") as supervisor, mock.patch.object(self.install.os,"execv") as launch:
            self.invoke("update")
        supervisor.assert_not_called()
        self.assertEqual(launch.call_args.args[1][-3:],["update","--descriptor","/srv/delta/instance.json"])

    def test_configured_project_validates_explicit_profile_and_state_scope_before_common(self):
        self.fake.load_instance_descriptor.return_value={"paths":{"state":"/srv/delta/state"},"integrations":{
            "supervision":{"config":"/srv/delta/config/supervisor.json","workspace":"/srv/delta/project"}}}
        config={"workspace":"/srv/delta/project","project_profile":{"acceptance_root":"/srv/foreign/state"}}
        supervisor=SimpleNamespace(load_config=mock.Mock(return_value=config),SupervisionError=SUP.SupervisionError)
        with mock.patch.object(self.install,"load_supervision",return_value=supervisor), mock.patch.object(self.install.os,"execv") as launch:
            self.assertEqual(self.invoke(),1)
            launch.assert_not_called()
            config["project_profile"]["acceptance_root"]="/srv/delta/state/supervision"
            self.invoke()
            launch.assert_called_once()
            launch.reset_mock()
            config.pop("project_profile")
            self.assertEqual(self.invoke(),1)
            launch.assert_not_called()



class OtherPreviewTests(previews.PreviewPublicationTests):
    def setUp(self):
        super().setUp()
        self.profile=copy.deepcopy(SUP.STATE.PROFILE.DEFAULT)
        self.profile.update(project_name="Taller Delta",tenant_id="EmpresaDelta",room_id="grp.delta",
            workspace=str(self.fixture.workspace),acceptance_root=str(self.control),
            config_path=str(self.control/"config.json"),state_path=str(self.control/"state.json"),
            actor_container="delta-engineer-1",actor_workspace="/srv/delta/project",issue_count=38,roadmap_count=217)
        self.profile["preview"].update(workspace=str(self.fixture.workspace),root=str(self.fixture.preview),
            publication_state=str(self.marker),unit_file=str(self.unit),service=self.unit.name,
            health_url="http://127.0.0.1:19077/api/session")
        self.config.update(project_profile=self.profile,project_profile_sha256=SUP.STATE.PROFILE.fingerprint(self.profile))

    def test_other_project_preview_uses_declared_service_and_keeps_protected_marker(self):
        SUP.STATE.PROFILE.validate(self.profile,SUP.STATE)
        self.assertEqual(self.publish()["action"],"preview_published")
        value=json.loads(self.marker.read_text())
        self.assertEqual(value["service"],self.profile["preview"]["service"])
        self.assertEqual(self.marker.stat().st_mode & 0o777,0o600)
        self.profile["preview"]["root"]="/srv/tampered"
        with self.assertRaisesRegex(SUP.SupervisionError,"fingerprint_mismatch"):
            self.publish()
