import copy
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1] / "instances/hospital"
SPEC = importlib.util.spec_from_file_location("hospital_boundary_guard", ROOT / "operator-runtime-guard.py")
GUARD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GUARD)


def bind(source, destination, writable):
    return {"Type": "bind", "Source": source, "Destination": destination, "RW": writable}


def inspection(alias):
    runtime = GUARD.INSTANCE_RUNTIME
    side = GUARD.DEVELOPER_SIDES.get(alias)
    if side:
        mounts = [
            bind(f"{runtime}/state-muse-{side}", "/home/node/.muse", True),
            bind(f"{runtime}/muse-code-bin", "/opt/muse-code", False),
            bind(f"{runtime}/developer-workspace/{side}", "/home/node/clawd", True),
            bind(f"{runtime}/developer-candidates/{side}/crm", "/home/node/clawd/project", True),
            bind(f"{runtime}/praxis/{side}", "/home/node/clawd/praxis", True),
            bind(f"{runtime}/praxis/operator", "/home/node/clawd/praxis-upstream", False),
            bind(f"/run/hospital-access/{alias}", "/run/hospital-access", False),
        ]
        networks = {f"hospital-agent_builder-{side}": {}}
    else:
        mounts = [bind(GUARD.RUNTIME_ROOT, GUARD.RUNTIME_ROOT, False),
                  bind(f"{runtime}/state-operator", "/home/node/.openclaw", True)]
        networks = {"hospital-agent_operator": {}, "hospital-agent_browser-control": {}}
    return {"State": {"Running": True}, "Config": {"User": "1000:1000", "Env": []}, "Mounts": mounts,
            "HostConfig": {"Privileged": False, "ReadonlyRootfs": True, "CapDrop": ["ALL"], "CapAdd": [],
                           "SecurityOpt": ["no-new-privileges:true"], "NetworkMode": next(iter(networks))},
            "NetworkSettings": {"Networks": networks}}


@pytest.mark.parametrize("alias", ["operador", "teseo", "perseo"])
def test_accepts_expected_host_metadata(alias):
    assert GUARD.boundary_errors(inspection(alias), alias) == []


@pytest.mark.parametrize("section, field, value, error", [
    ("Config", "User", "0:0", "container_user_not_actor"),
    ("HostConfig", "Privileged", True, "container_privileged"),
    ("HostConfig", "ReadonlyRootfs", False, "container_rootfs_writable"),
    ("HostConfig", "CapAdd", ["SYS_ADMIN"], "container_capabilities_unsafe"),
    ("HostConfig", "CapAdd", ["CAP_DAC_OVERRIDE", "CAP_SETUID"], "container_capabilities_unsafe"),
    ("HostConfig", "CapDrop", [], "container_capabilities_unsafe"),
    ("HostConfig", "SecurityOpt", [], "container_can_gain_privileges"),
    ("HostConfig", "NetworkMode", "host", "container_host_access"),
    ("HostConfig", "NetworkMode", "container:operator", "container_host_access"),
    ("HostConfig", "PidMode", "host", "container_host_access"),
    ("HostConfig", "IpcMode", "host", "container_host_access"),
    ("HostConfig", "Devices", [{"PathOnHost": "/dev/sda"}], "container_host_access"),
])
def test_rejects_escape_routes_even_with_a_read_only_runtime(section, field, value, error):
    info = inspection("operador")
    info[section][field] = value
    assert error in GUARD.boundary_errors(info, "operador")


@pytest.mark.parametrize("source, destination, writable, error", [
    ("/var/run/docker.sock", "/var/run/docker.sock", True, "container_host_access"),
    ("/run", "/host-run", False, "container_host_access"),
    ("/", "/host", False, "container_host_access"),
    ("/opt/cauce-hospital", "/alias", True, "runtime_source_has_writable_alias"),
    (GUARD.RUNTIME_ROOT, "/alias", True, "runtime_source_has_writable_alias"),
    (f"{GUARD.RUNTIME_ROOT}/praxis-proof.py", "/alias.py", True, "runtime_source_has_writable_alias"),
    (f"{GUARD.INSTANCE_RUNTIME}/state-muse-operator", "/alias", True, "operator_has_muse_runtime"),
    (f"{GUARD.INSTANCE_RUNTIME}/muse-code-bin", "/alias", False, "operator_has_muse_runtime"),
    (GUARD.INSTANCE_RUNTIME, "/alias", False, "operator_has_muse_runtime"),
    ("/srv/agent-opt", "/opt", True, "runtime_ancestor_mounted_writable"),
])
def test_rejects_unsafe_host_sources_under_alternative_destinations(source, destination, writable, error):
    info = inspection("operador")
    info["Mounts"].append(bind(source, destination, writable))
    assert error in GUARD.boundary_errors(info, "operador")


@pytest.mark.parametrize("alias", ["teseo", "perseo"])
def test_developer_cannot_mount_other_agent_state_or_operator_access(alias):
    original = inspection(alias)
    for source in (f"{GUARD.INSTANCE_RUNTIME}/state-operator", "/etc/cauce-v3-hospital",
                   f"{GUARD.INSTANCE_RUNTIME}/state-muse-{'frontend' if alias == 'teseo' else 'backend'}"):
        info = copy.deepcopy(original)
        info["Mounts"][0]["Source"] = source
        assert "developer_mount_not_allowed" in GUARD.boundary_errors(info, alias)
    for mutation in (lambda mounts: mounts.pop(), lambda mounts: mounts.append(copy.deepcopy(mounts[0])),
                     lambda mounts: mounts[-1].update(RW=True),
                     lambda mounts: mounts.append(bind("/run/hospital-ops", "/run/hospital-ops", False))):
        info = copy.deepcopy(original)
        mutation(info["Mounts"])
        assert GUARD.boundary_errors(info, alias)


@pytest.mark.parametrize("alias", ["operador", "teseo", "perseo"])
def test_rejects_cross_role_networks(alias):
    info = inspection(alias)
    info["NetworkSettings"]["Networks"]["hospital-agent_builder-other"] = {}
    assert f"{'operator' if alias == 'operador' else 'developer'}_networks_unexpected" in GUARD.boundary_errors(info, alias)


@pytest.mark.parametrize("section", ["Config", "State", "Mounts", "HostConfig", "NetworkSettings"])
def test_missing_inspection_fields_fail_closed(section):
    info = inspection("operador")
    del info[section]
    assert GUARD.boundary_errors(info, "operador") == ["boundary_inspect_invalid"]


def test_operator_cleanup_is_checked_on_host_even_if_container_commands_lie(tmp_path, monkeypatch):
    monkeypatch.setattr(GUARD, "INSTANCE_RUNTIME", str(tmp_path))
    source = tmp_path / "state-operator"
    source.mkdir()
    config = source / "openclaw.json"
    config.write_text(json.dumps({"agents": {"defaults": {"model": {"fallbacks": ["muse-cli/muse-spark-1.3"]}}}}))
    monkeypatch.setattr(GUARD, "inspect", lambda *_: inspection("operador"))
    monkeypatch.setattr(GUARD, "actor", lambda *_: pytest.fail("container commands cannot attest host cleanup"))
    with pytest.raises(GUARD.GuardError, match="operator_config_references_muse_fallback"):
        GUARD.verify_boundary("operator", "operador")
    config.write_text("{}")
    extension = source / "extensions" / "hospital-muse-native"
    extension.mkdir(parents=True)
    with pytest.raises(GUARD.GuardError, match="operator_has_writable_muse_plugin"):
        GUARD.verify_boundary("operator", "operador")
    extension.rmdir()
    GUARD.verify_boundary("operator", "operador")
    (source / "extensions").rmdir()
    (source / "extensions").symlink_to(tmp_path / "missing")
    with pytest.raises(GUARD.GuardError, match="operator_has_writable_muse_plugin"):
        GUARD.verify_boundary("operator", "operador")


def test_unicode_escaped_fallback_is_rejected_from_host_config(tmp_path, monkeypatch):
    monkeypatch.setattr(GUARD, "INSTANCE_RUNTIME", str(tmp_path))
    source = tmp_path / "state-operator"
    source.mkdir()
    (source / "openclaw.json").write_text(r'{"fallbacks": ["muse\u002dcli/muse-spark-1.3"]}')
    with pytest.raises(GUARD.GuardError, match="operator_config_references_muse_fallback"):
        GUARD.verify_operator_state(inspection("operador"))


@pytest.mark.parametrize("alias", ["operador", "teseo", "perseo"])
def test_accepts_scratch_tmpfs_without_opening_host_mount_allowlist(alias):
    info = inspection(alias)
    info["Mounts"].append({"Type": "tmpfs", "Source": "", "Destination": "/tmp", "RW": True})
    assert GUARD.boundary_errors(info, alias) == []


@pytest.mark.parametrize("alias", ["operador", "teseo", "perseo"])
@pytest.mark.parametrize("target", ["/opt", "/home/node"])
def test_rejects_tmpfs_host_options_that_shadow_rootfs(alias, target):
    info = inspection(alias)
    info["HostConfig"]["Tmpfs"] = {target: "rw,uid=1000,gid=1000,mode=0755"}
    assert "container_tmpfs_not_allowed" in GUARD.boundary_errors(info, alias)


@pytest.mark.parametrize("scratch", [None, {}, {"/tmp": "rw,noexec,nosuid,nodev,size=64m"}])
def test_accepts_only_safe_host_tmpfs_targets(scratch):
    info = inspection("teseo")
    info["HostConfig"]["Tmpfs"] = scratch
    assert GUARD.boundary_errors(info, "teseo") == []


@pytest.mark.parametrize("scratch", [[], "tmp", {"/tmp": False}])
def test_rejects_malformed_tmpfs_host_options(scratch):
    info = inspection("teseo")
    info["HostConfig"]["Tmpfs"] = scratch
    assert "container_tmpfs_not_allowed" in GUARD.boundary_errors(info, "teseo")


def test_operator_config_symlinks_and_shadow_mounts_are_rejected(tmp_path, monkeypatch):
    monkeypatch.setattr(GUARD, "INSTANCE_RUNTIME", str(tmp_path))
    source = tmp_path / "state-operator"
    source.mkdir()
    (source / "openclaw.json").symlink_to(tmp_path / "missing")
    with pytest.raises(GUARD.GuardError, match="source_unreadable"):
        GUARD.verify_operator_state(inspection("operador"))
    (source / "openclaw.json").unlink()
    (source / "openclaw.json").write_text("{}")
    info = inspection("operador")
    info["Mounts"].append(bind(str(tmp_path / "other"), GUARD.OPENCLAW_CONFIG, False))
    with pytest.raises(GUARD.GuardError, match="operator_state_mount_untrusted"):
        GUARD.verify_operator_state(info)


def test_provision_disables_fallback_and_checks_host_before_mutating_runtime():
    script = (ROOT / "provision-agents.sh").read_text()
    assert '1) echo "El puente Muse aislado no está construido;' in script
    assert 'debe seguir en 0" >&2; exit 1' in script
    assert script.index('verify-boundary --alias') < script.index('install -o 1000')
    for container in ("openclaw-operator-gateway", "muse-backend", "muse-frontend"):
        assert f"hospital-agent-{container}-1" in script


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
