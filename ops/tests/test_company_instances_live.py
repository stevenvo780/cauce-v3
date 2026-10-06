from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import pathlib
import ssl
import subprocess
import sys
import threading
import time
import unittest
import urllib.error
import uuid

from company_instances_live_support import (
    COMMON,
    IMAGES,
    UPDATE_CONSOLE,
    Api,
    canonical,
    execute,
    prepare_company,
    resources,
    restore_blob_volume,
    snapshot_blob_volume,
)

# cauce:requiere none

ENABLED = os.environ.get("CAUCE_COMPANY_LIVE") == "1"


def normalized_mounts(mounts):
    return sorted(mounts, key=canonical)


class ResourceSnapshotTest(unittest.TestCase):
    def test_mount_order_preserves_all_fields_and_multiplicity(self):
        first = {"Destination": "/one", "Source": "/owned/one", "Type": "bind", "RW": False, "Mode": "ro"}
        second = {"Destination": "/two", "Source": "/owned/two", "Type": "bind", "RW": False, "Mode": "ro"}
        before = [first, second, first]
        reordered = [second, first, first]
        self.assertEqual(normalized_mounts(before), normalized_mounts(reordered))
        self.assertCountEqual([canonical(mount) for mount in before], [canonical(mount) for mount in reordered])
        self.assertEqual(len(normalized_mounts(before)), 3)
        self.assertNotEqual(normalized_mounts(before), normalized_mounts([first, second]))
        changes = (
            ("Destination", "/foreign"),
            ("Source", "/foreign"),
            ("Type", "volume"),
            ("RW", True),
            ("Mode", "rw"),
            ("Propagation", "shared"),
        )
        for field, replacement in changes:
            with self.subTest(field=field):
                changed = [dict(first), dict(second), dict(first)]
                changed[0][field] = replacement
                self.assertNotEqual(normalized_mounts(before), normalized_mounts(changed))


@unittest.skipUnless(ENABLED, "explicit opt-in required for owned live Docker installations")
class CompanyInstancesLiveTest(unittest.TestCase):
    def setUp(self):
        self.assertEqual(os.getuid(), 1000, "live acceptance must run as workspace owner")
        self.assertTrue(os.environ.get("CAUCE_INSTANCE_REGISTRY_ROOT"), "shared host registry required")
        self.nonce = uuid.uuid4().hex[:12]
        evidence = pathlib.Path(
            os.environ.get("CAUCE_COMPANY_LIVE_EVIDENCE", "/home/stev/cauce-independent-evidence-20261006")
        )
        self.root = evidence / ("company-live-" + self.nonce)
        self.root.mkdir(mode=0o700)
        (self.root / "test-owner.json").write_bytes(canonical({"owner": self.nonce, "uid": os.getuid()}))
        self.events = []
        self.companies = []
        self.backup_volumes = []
        self.addCleanup(self.cleanup_owned)
        release = {key: os.environ.get("CAUCE_COMPANY_LIVE_" + key.upper(), value) for key, value in IMAGES.items()}
        for image in [*release.values(), UPDATE_CONSOLE]:
            execute(["docker", "image", "inspect", image], timeout=10)
        for letter in ("a", "b"):
            company = prepare_company(self.root, letter, release)
            self.companies.append(company)
        self.record(
            "prepared",
            {
                "instance_ids": [company["descriptor"]["instanceId"] for company in self.companies],
                "same_alias": "operador",
                "separate_cas": True,
                "release": release,
                "profileless": True,
            },
        )

    def record(self, stage, facts):
        self.events.append({"stage": stage, "at": dt.datetime.now(dt.timezone.utc).isoformat(), "facts": facts})
        (self.root / "evidence.json").write_bytes(canonical({"owner": self.nonce, "events": self.events}))
        print(json.dumps({"stage": stage, "facts": facts}, sort_keys=True), flush=True)

    def cli(self, company, action):
        self.record(action + "_start", {"instance_id": company["descriptor"]["instanceId"]})
        command = [sys.executable, str(COMMON / "cauce-instance"), action, "--descriptor", str(company["path"])]
        value = subprocess.run(command, capture_output=True, text=True, timeout=420)
        (company["home"] / (action + ".stdout.json")).write_text(value.stdout)
        (company["home"] / (action + ".stderr.log")).write_text(value.stderr)
        if value.returncode:
            self.record(
                action + "_failed",
                {
                    "instance_id": company["descriptor"]["instanceId"],
                    "exit": value.returncode,
                    "error": value.stderr[-1800:],
                },
            )
            self.fail(action + " failed; see owned evidence " + str(company["home"]))
        result = json.loads(value.stdout)
        self.record(
            action + "_completed",
            {
                "instance_id": company["descriptor"]["instanceId"],
                "plan_hash": result.get("planHash"),
                "status": result.get("status"),
            },
        )
        return result

    def postgres(self, company):
        value = execute(
            [
                "docker",
                "ps",
                "-q",
                "--filter",
                "label=com.docker.compose.project=" + company["descriptor"]["compose"]["project"],
                "--filter",
                "label=com.docker.compose.service=postgres",
            ]
        ).split()
        self.assertEqual(len(value), 1)
        return value[0]

    def sql(self, company, sql):
        return execute(
            [
                "docker",
                "exec",
                "-i",
                self.postgres(company),
                "psql",
                "-XAtq",
                "-U",
                "cauce",
                "-d",
                "cauce",
                "--set=ON_ERROR_STOP=1",
            ],
            data=sql,
        )

    def publish(self, company, sender, text, attachments=None):
        body = {"type": "request", "text": text}
        if attachments is not None:
            body["attachments_v1"] = attachments
        status, value = sender.request(
            "POST",
            "/v3/messages",
            {
                "room_id": company["room"],
                "recipients": [{"tenant_id": company["tenant"], "alias": "operador"}],
                "body": body,
                "idempotency_key": "company-live:" + self.nonce + ":" + str(uuid.uuid4()),
            },
        )
        self.assertEqual(status, 202, str(value))
        return value

    def process(self, company, consumer, sender, text, attachments=None):
        consumer.heartbeat()
        published = self.publish(company, sender, text, attachments)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            deliveries = consumer.query()
            if deliveries:
                break
            time.sleep(0.1)
        self.assertEqual(len(deliveries), 1)
        delivery = deliveries[0]
        self.assertEqual(delivery["message_id"], published["message_id"])
        self.assertEqual(delivery["body"]["text"], text)
        if attachments is not None:
            self.assertEqual(delivery["body"]["attachments_v1"], attachments)
        result = consumer.ack(delivery)
        self.assertEqual(result["status"], "done")
        return published["message_id"], delivery

    def recover_retry(self, company, consumer, sender):
        published = self.publish(company, sender, "synthetic retry recovery")
        first = consumer.query()[0]
        self.assertEqual(first["message_id"], published["message_id"])
        transition = consumer.ack(first, "failed", retryable=True)
        self.assertEqual(transition["status"], "retry")
        deadline = time.monotonic() + 20
        recovered = []
        while time.monotonic() < deadline:
            consumer.heartbeat()
            recovered = consumer.query()
            if recovered:
                break
            time.sleep(0.2)
        self.assertEqual(len(recovered), 1)
        second = recovered[0]
        self.assertEqual(second["delivery_id"], first["delivery_id"])
        self.assertGreater(second["attempt"], first["attempt"])
        self.assertTrue(second["claim_token"] != first["claim_token"], "recovery must rotate the claim")
        stale = {
            "version": "3.0",
            "status": "done",
            "instance_id": consumer.instance_id,
            "epoch": consumer.lease["epoch"],
            "event_id": str(uuid.uuid4()),
            "claim_token": first["claim_token"],
            "attempt": first["attempt"],
        }
        delivery_id = str(uuid.UUID(second["delivery_id"]))
        query = f"""SELECT json_build_object(
            'delivery',(SELECT json_build_object('status',status,'attempt',attempt,
                'claim_hash',encode(digest(claim_token::text,'sha256'),'hex'),
                'instance_id',consumer_instance_id,'epoch',consumer_epoch) FROM deliveries WHERE id='{delivery_id}'),
            'lease',(SELECT json_build_object('instance_id',instance_id,'epoch',epoch,'lease_until',lease_until,
                'connection_hash',encode(digest(connection_token::text,'sha256'),'hex'))
                FROM connection_leases WHERE tenant_id='{company["tenant"]}' AND alias='operador'));"""
        before = json.loads(self.sql(company, query))
        self.assertEqual(before["delivery"]["attempt"], second["attempt"])
        self.assertEqual(before["delivery"]["claim_hash"], hashlib.sha256(second["claim_token"].encode()).hexdigest())
        code, rejected = consumer.request("POST", "/v3/deliveries/" + first["delivery_id"] + "/ack", stale)
        self.assertEqual(code, 200)
        self.assertIs(rejected.get("applied"), False)
        self.assertEqual(rejected.get("receipt"), "ownership_lost")
        self.assertEqual(before, json.loads(self.sql(company, query)))
        self.record(
            "stale_ack_refused",
            {
                "http_status": code,
                "applied": False,
                "receipt": rejected["receipt"],
                "current_claim_and_lease_unchanged": True,
            },
        )
        self.assertEqual(consumer.ack(second)["status"], "done")
        self.assertEqual(
            self.sql(company, "SELECT status FROM deliveries WHERE id='" + delivery_id + "';").strip(), "done"
        )
        self.record(
            "retry_recovery",
            {
                "delivery_id": second["delivery_id"],
                "first_attempt": first["attempt"],
                "recovered_attempt": second["attempt"],
                "stale_claim_http_status": code,
                "stale_claim_applied": False,
                "current_claim_and_lease_unchanged": True,
                "fresh_ack_applied": True,
                "method": "real retryable ACK and durable re-claim",
            },
        )

    def blobs(self, a, b, aa, ab, sa, sb):
        content = b"synthetic same content independently authorized in both companies"
        sha = hashlib.sha256(content).hexdigest()
        headers = {
            "Content-Type": "application/octet-stream",
            "x-cauce-blob-name": "synthetic.txt",
            "x-cauce-blob-sha256": sha,
            "x-cauce-blob-media-type": "text/plain",
        }
        status, uploaded = sa.request("PUT", "/v3/blobs", data=content, headers=headers)
        self.assertEqual(status, 201, str(uploaded))
        self.assertEqual(uploaded["sha256"], sha)
        self.assertEqual(uploaded["bytes"], len(content))
        status, _ = sb.request("GET", "/v3/blobs/" + sha)
        self.assertEqual(status, 404)
        status, uploaded = sb.request("PUT", "/v3/blobs", data=content, headers=headers)
        self.assertEqual(status, 201, str(uploaded))
        self.assertEqual(uploaded["sha256"], sha)
        self.assertEqual(uploaded["bytes"], len(content))
        for sender in (sa, sb):
            status, value = sender.request("GET", "/v3/blobs/" + sha)
            self.assertEqual(status, 200)
            self.assertEqual(value, content)
        attachment = {
            "kind": "document",
            "name": "synthetic.txt",
            "mime_type": "text/plain",
            "file_size": len(content),
            "blob": "sha256:" + sha,
            "sha256": sha,
        }
        attachment_messages = []
        for company, consumer, sender in ((a, aa, sa), (b, ab, sb)):
            message, _ = self.process(company, consumer, sender, "synthetic blob attachment", [attachment])
            status, downloaded = consumer.request("GET", "/v3/blobs/" + sha)
            self.assertEqual(status, 200)
            self.assertEqual(downloaded, content)
            attachment_messages.append(message)
        self.record(
            "blob_attachment_end_to_end",
            {
                "message_ids": attachment_messages,
                "sha256": sha,
                "bytes": len(content),
                "recipient_downloads": 2,
                "durable_ack_done": True,
            },
        )
        owners = []
        for company in (a, b):
            self.assertEqual(self.sql(company, "SELECT count(*) FROM blobs WHERE sha256='" + sha + "';").strip(), "1")
            receipt = json.loads((company["home"] / "state/installation-receipt.json").read_text())
            owners.extend([name for name in receipt["docker"] if name.endswith("-blobs-data")])
        self.assertEqual(len(set(owners)), 2)
        self.record(
            "same_sha_blobs_isolated",
            {
                "sha256": sha,
                "bytes": len(content),
                "own_volumes": owners,
                "b_before_own_upload": 404,
                "separate_downloads": True,
            },
        )

    def identities(self, company):
        query = "SELECT json_build_object('tenants',(SELECT json_agg(id) FROM tenants),'agents',(SELECT json_agg(alias) FROM agents),'acl_edges',(SELECT count(*) FROM acl_edges),'memberships',(SELECT json_agg(json_build_object('alias',alias,'role',role)) FROM memberships),'ownership',(SELECT row_to_json(t) FROM cauce_instance_ownership t));"
        value = json.loads(self.sql(company, query))
        self.assertEqual(value["tenants"], [company["tenant"]])
        self.assertEqual(value["agents"], ["operador"])
        self.assertEqual(value["acl_edges"], 0)
        self.assertEqual({row["alias"] for row in value["memberships"]}, {"operador", "emisor"})
        self.assertTrue(all(row["role"] == "operator" for row in value["memberships"]))
        self.record("owned_database", value)

    def snapshot(self, company):
        receipt = json.loads((company["home"] / "state/installation-receipt.json").read_text())
        values = json.loads(
            execute(
                [
                    "docker",
                    "inspect",
                    *execute(["docker", "ps", "-aq", "--filter", "label=io.cauce.owner=" + receipt["owner"]]).split(),
                ]
            )
        )
        return {
            "docker": receipt["docker"],
            "owner": receipt["owner"],
            "containers": {
                value["Config"]["Labels"]["com.docker.compose.service"]: {
                    "id": value["Id"],
                    "mounts": normalized_mounts(value["Mounts"]),
                }
                for value in values
            },
            "files": {path: hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest() for path in receipt["files"]},
        }

    def assert_resources_unchanged(self, company, before, stage):
        after = self.snapshot(company)
        for label, snapshot in (("before", before), ("after", after)):
            (self.root / (stage + "-" + label + ".json")).write_bytes(canonical(snapshot))
        self.assertEqual(after, before)
        self.record(
            stage,
            {"snapshot_sha256": hashlib.sha256(canonical(after)).hexdigest(), "all_resource_fields_equal": True},
        )

    def test_two_profileless_installations_and_real_tls_delivery_update_isolation(self):
        a, b = self.companies
        for company in self.companies:
            self.cli(company, "install")
            self.identities(company)
        aa, ab = Api(a), Api(b)
        aa.hello()
        ab.hello()
        sa, sb = Api(a, "emisor"), Api(b, "emisor")
        ids = []
        claimed = []
        for company, consumer, sender in ((a, aa, sa), (b, ab, sb)):
            message, delivery = self.process(company, consumer, sender, "synthetic " + company["tenant"])
            ids.append(message)
            claimed.append(delivery)
            self.record(
                "durable_done",
                {
                    "tenant": company["tenant"],
                    "message_id": message,
                    "delivery_id": delivery["delivery_id"],
                    "attempt": delivery["attempt"],
                    "epoch": consumer.lease["epoch"],
                },
            )
        self.assertNotEqual(ids[0], ids[1])
        for sender, own_id in ((sa, ids[0]), (sb, ids[1])):
            status, value = sender.request("GET", "/v3/messages/" + own_id)
            self.assertEqual(status, 200, str(value))
        for company, foreign, message in ((a, b, ids[1]), (b, a, ids[0])):
            client = Api(company, "emisor", foreign)
            with self.assertRaises((urllib.error.URLError, ssl.SSLError, OSError)):
                client.request("GET", "/v3/messages/" + message)
        self.record(
            "foreign_certificates_refused",
            {"a_to_b": True, "b_to_a": True, "method": "real independent CA TLS handshake"},
        )
        for sender, foreign_id in ((sa, ids[1]), (sb, ids[0])):
            status, _ = sender.request("GET", "/v3/messages/" + foreign_id)
            self.assertEqual(status, 404)
        self.record("foreign_messages_refused", {"same_alias": "operador", "status": 404})
        code, _ = ab.request(
            "POST",
            "/v3/deliveries/query",
            {
                "instance_id": aa.instance_id,
                "epoch": aa.lease["epoch"],
                "connection_token": aa.lease["connection_token"],
                "limit": 1,
            },
        )
        self.assertIn(code, (403, 409))
        foreign_ack = {
            "version": "3.0",
            "status": "done",
            "instance_id": aa.instance_id,
            "epoch": aa.lease["epoch"],
            "event_id": str(uuid.uuid4()),
            "claim_token": claimed[0]["claim_token"],
            "attempt": claimed[0]["attempt"],
        }
        ack_code, _ = ab.request("POST", "/v3/deliveries/" + claimed[0]["delivery_id"] + "/ack", foreign_ack)
        self.assertIn(ack_code, (403, 404))
        self.record(
            "foreign_session_and_ack_refused",
            {"correct_b_certificate": True, "foreign_connection_token": code, "foreign_delivery_ack": ack_code},
        )
        self.recover_retry(a, aa, sa)
        self.blobs(a, b, aa, ab, sa, sb)
        for company in self.companies:
            self.assertEqual(self.cli(company, "status")["status"], "installed")
            receipt = self.cli(company, "install")
            self.assertEqual(receipt["instanceId"], company["descriptor"]["instanceId"])
        snapshots = [self.snapshot(company) for company in (a, b)]
        self.assertTrue(set(snapshots[0]["docker"]).isdisjoint(snapshots[1]["docker"]))
        self.assertNotEqual(snapshots[0]["owner"], snapshots[1]["owner"])
        for own, foreign in ((0, 1), (1, 0)):
            foreign_root = str(self.companies[foreign]["home"])
            for container in snapshots[own]["containers"].values():
                for mount in container["mounts"]:
                    self.assertFalse(mount["Source"].startswith(foreign_root + "/"))
        self.record("owned_resources_disjoint", {"docker_names": True, "owners": True, "foreign_mounts": False})
        before = snapshots[1]
        heartbeat_stop = threading.Event()
        successes = []
        errors = []

        def traffic():
            while not heartbeat_stop.is_set():
                try:
                    message, _ = self.process(b, ab, sb, "synthetic concurrent B")
                    successes.append(message)
                except Exception as error:
                    errors.append(str(error))
                    break
                heartbeat_stop.wait(0.3)

        worker = threading.Thread(target=traffic, daemon=True)
        worker.start()
        try:
            self.backup_restore(a, b, before)
            original_console = a["descriptor"]["release"]["consoleImage"]
            updated = json.loads(a["path"].read_text())
            updated["release"]["consoleImage"] = UPDATE_CONSOLE
            a["path"].write_bytes(canonical(updated))
            a["descriptor"] = updated
            self.cli(a, "update")
            self.assertEqual(self.cli(a, "status")["status"], "installed")
            final_release = json.loads(a["path"].read_text())
            final_release["release"]["consoleImage"] = original_console
            a["path"].write_bytes(canonical(final_release))
            a["descriptor"] = final_release
            self.cli(a, "update")
            self.assertEqual(self.cli(a, "status")["status"], "installed")
        finally:
            heartbeat_stop.set()
            worker.join(timeout=20)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        self.assertGreater(len(successes), 0)
        self.assert_resources_unchanged(b, before, "b_resources_after_update")
        for company in (a, b):
            self.identities(company)
        self.record(
            "update_a_keeps_b",
            {
                "b_deliveries_done": len(successes),
                "b_resources_unchanged": True,
                "a_changed_console_digest": True,
                "a_restored_qualified_console_digest": True,
                "runtime_digest_unchanged": True,
            },
        )
        self.record(
            "acceptance_limits",
            {
                "covered": [
                    "two profileless installs",
                    "idempotent retry",
                    "durable HTTP claim and fenced ACK",
                    "retryable failure recovery and stale claim fencing",
                    "same-SHA blob isolation",
                    "blob attachment publish/claim/ACK/recipient download",
                    "foreign connection token and delivery ACK rejection with own B certificate",
                    "own PostgreSQL dump and staging database restore",
                    "own blob volume snapshot and isolated volume restore",
                    "profileless descriptor snapshot and unchanged B traffic/resources",
                    "real foreign mTLS refusal",
                    "foreign message refusal",
                    "console release update while B processes",
                    "B container/mount/volume/network/generated-file identity",
                ],
                "pending": [
                    "third independent installation",
                    "process crash/reaper recovery",
                    "cross-cookie/bearer-token/ticket acceptance",
                    "terminal/TUI confinement",
                    "stop/restore A with B terminal open",
                    "new runtime migration upgrade",
                ],
            },
        )

    def backup_restore(self, a, b, b_before):
        receipt = json.loads((a["home"] / "state/installation-receipt.json").read_text())
        container = self.postgres(a)
        labels = json.loads(execute(["docker", "inspect", container]))[0]["Config"]["Labels"]
        self.assertEqual(labels["io.cauce.owner"], receipt["owner"])
        self.assertEqual(labels["io.cauce.installation"], a["descriptor"]["instanceId"])
        backup = a["home"] / "backups" / ("acceptance-" + self.nonce)
        backup.mkdir(mode=0o700)
        summary = """SELECT json_build_object(
            'tenants',(SELECT json_agg(id ORDER BY id) FROM tenants),
            'agents',(SELECT json_agg(alias ORDER BY alias) FROM agents),
            'messages',(SELECT json_agg(json_build_object('id',id,'body',body) ORDER BY id) FROM messages),
            'deliveries',(SELECT json_agg(json_build_object('id',id,'message_id',message_id,'status',status,'attempt',attempt) ORDER BY id) FROM deliveries),
            'blobs',(SELECT json_agg(json_build_object('sha256',sha256,'bytes',bytes,'tenant_id',tenant_id) ORDER BY sha256) FROM blobs),
            'ownership',(SELECT row_to_json(t) FROM cauce_instance_ownership t));"""
        expected = json.loads(self.sql(a, summary))
        dumped = subprocess.run(
            [
                "docker",
                "exec",
                container,
                "pg_dump",
                "-U",
                "cauce",
                "-d",
                "cauce",
                "--format=custom",
                "--no-owner",
                "--no-privileges",
            ],
            capture_output=True,
            timeout=90,
        )
        self.assertEqual(dumped.returncode, 0, dumped.stderr.decode())
        (backup / "database.dump").write_bytes(dumped.stdout)
        (backup / "database.dump").chmod(0o600)
        descriptor_before = hashlib.sha256(a["path"].read_bytes()).hexdigest()
        (backup / "descriptor.json").write_bytes(a["path"].read_bytes())
        self.assertNotIn("supervision", a["descriptor"].get("integrations", {}))
        blob_volume = next(item.split(":", 1)[1] for item in receipt["docker"] if item.endswith("-blobs-data"))
        original = resources.inspect_resource("volume", blob_volume)
        self.assertEqual(original["Labels"]["io.cauce.owner"], receipt["owner"])
        files = snapshot_blob_volume(a["descriptor"]["release"]["runtimeImage"], blob_volume)
        self.assertGreater(len(files), 0)
        (backup / "blob-volume.json").write_bytes(canonical(files))
        blob_target = backup / "restored-blobs"
        blob_target.mkdir(mode=0o700)
        restored_volume = a["descriptor"]["instanceId"] + "-restore-blobs"
        execute(
            [
                "docker",
                "volume",
                "create",
                "--driver",
                "local",
                "--opt",
                "type=none",
                "--opt",
                "o=bind",
                "--opt",
                "device=" + str(blob_target),
                "--label",
                "io.cauce.owner=" + receipt["owner"],
                "--label",
                "io.cauce.installation=" + a["descriptor"]["instanceId"],
                "--label",
                "io.cauce.live-test=" + self.nonce,
                restored_volume,
            ]
        )
        restored_identity = resources.docker_identity("volume", resources.inspect_resource("volume", restored_volume))
        self.backup_volumes.append(
            (restored_volume, receipt["owner"], a["descriptor"]["instanceId"], restored_identity)
        )
        restore_blob_volume(a["descriptor"]["release"]["runtimeImage"], restored_volume, files)
        self.assertEqual(files, snapshot_blob_volume(a["descriptor"]["release"]["runtimeImage"], restored_volume))
        database = "live_restore_" + self.nonce
        comment = "company-live:" + self.nonce + ":" + receipt["owner"]
        self.sql(a, 'CREATE DATABASE "' + database + '" TEMPLATE template0;')
        try:
            self.sql(a, 'COMMENT ON DATABASE "' + database + "\" IS '" + comment + "';")
            restored = subprocess.run(
                [
                    "docker",
                    "exec",
                    "-i",
                    container,
                    "pg_restore",
                    "-U",
                    "cauce",
                    "-d",
                    database,
                    "--exit-on-error",
                    "--no-owner",
                    "--no-privileges",
                ],
                input=dumped.stdout,
                capture_output=True,
                timeout=90,
            )
            self.assertEqual(restored.returncode, 0, restored.stderr.decode())
            actual = json.loads(
                execute(
                    [
                        "docker",
                        "exec",
                        "-i",
                        container,
                        "psql",
                        "-XAtq",
                        "-U",
                        "cauce",
                        "-d",
                        database,
                        "--set=ON_ERROR_STOP=1",
                    ],
                    data=summary,
                )
            )
            self.assertEqual(actual, expected)
            self.assertEqual(actual["ownership"]["owner"], receipt["owner"])
            self.assert_resources_unchanged(b, b_before, "b_resources_after_restore")
            self.assertEqual(hashlib.sha256(a["path"].read_bytes()).hexdigest(), descriptor_before)
            self.record(
                "own_backup_restore",
                {
                    "dump_sha256": hashlib.sha256(dumped.stdout).hexdigest(),
                    "staging_database": database,
                    "database_snapshot_equal": True,
                    "blob_files": len(files),
                    "blob_volume_bytes_equal": True,
                    "profileless_descriptor_unchanged": True,
                    "b_resources_unchanged": True,
                },
            )
        finally:
            owner_comment = self.sql(
                a, "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname='" + database + "';"
            ).strip()
            self.assertEqual(owner_comment, comment)
            current_labels = json.loads(execute(["docker", "inspect", container]))[0]["Config"]["Labels"]
            self.assertEqual(current_labels["io.cauce.owner"], receipt["owner"])
            self.sql(a, 'DROP DATABASE "' + database + '";')
            self.assertEqual(
                self.sql(a, "SELECT count(*) FROM pg_database WHERE datname='" + database + "';").strip(), "0"
            )
            self.record("staging_database_removed", {"name": database, "own_comment_verified": True})

    def cleanup_owned(self):
        removed = []
        failures = []
        for company in reversed(self.companies):
            name = company["descriptor"]["instanceId"]
            path = company["home"] / "state/installation-receipt.json"
            receipt = json.loads(path.read_text()) if path.exists() else None
            if receipt is None:
                continue
            owner = receipt["owner"]
            try:
                containers = execute(["docker", "ps", "-aq", "--filter", "label=io.cauce.owner=" + owner]).split()
                for identifier in containers:
                    value = json.loads(execute(["docker", "inspect", identifier]))[0]
                    self.assertEqual(value["Config"]["Labels"]["io.cauce.installation"], name)
                    execute(["docker", "rm", "-f", identifier], timeout=60)
                    removed.append("container:" + identifier)
                for registered in receipt["docker"]:
                    kind, resource = registered.split(":", 1)
                    value = resources.inspect_resource(kind, resource)
                    if value is None:
                        continue
                    self.assertEqual(value["Labels"]["io.cauce.owner"], owner)
                    self.assertEqual(value["Labels"]["io.cauce.installation"], name)
                    self.assertEqual(resources.docker_identity(kind, value), receipt["docker"][registered])
                    execute(["docker", kind, "rm", resource], timeout=30)
                    removed.append(kind + ":" + resource)
                registry = resources.REGISTRY_ROOT / (name + ".json")
                with resources.reservation_lock(require_shared=True):
                    if registry.exists():
                        reservation = resources.read_reservation(registry, own=True)
                        self.assertEqual(reservation["owner"], owner)
                        self.assertEqual(reservation["installerUid"], os.getuid())
                        self.assertEqual(reservation["resources"]["instanceId"], name)
                        self.assertEqual(reservation["immutableHash"], receipt["immutableHash"])
                        self.assertIn(self.nonce, name)
                        registry.unlink()
            except Exception as error:
                failures.append(str(error))
        for volume, owner, name, identity in self.backup_volumes:
            try:
                value = resources.inspect_resource("volume", volume)
                if value is not None:
                    self.assertEqual(value["Labels"]["io.cauce.owner"], owner)
                    self.assertEqual(value["Labels"]["io.cauce.installation"], name)
                    self.assertEqual(value["Labels"]["io.cauce.live-test"], self.nonce)
                    self.assertEqual(resources.docker_identity("volume", value), identity)
                    execute(["docker", "volume", "rm", volume])
                    removed.append("volume:" + volume)
            except Exception as error:
                failures.append(str(error))
        self.record("cleanup", {"removed": removed, "errors": failures})
        for company in self.companies:
            for key in company["home"].glob("pki/*"):
                if key.suffix in {".key", ".csr", ".srl", ".extensions"}:
                    key.unlink()
            for name in ("database-url", "postgres-password"):
                (company["home"] / "config" / name).unlink(missing_ok=True)
        if failures:
            self.fail("owned cleanup failed: " + "; ".join(failures))


if __name__ == "__main__":
    unittest.main()
