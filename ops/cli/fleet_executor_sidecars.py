from __future__ import annotations

import json
import re

from fleet_policy_paths import SafeFailure

# Manifest list of tecnativa/docker-socket-proxy v0.5.0. Nightly is not accepted.
PROXY_IMAGE = 'tecnativa/docker-socket-proxy@sha256:1f5038b54f06c3e18422902cf00ba21803d1c97805aae032e5e6673d532d3459'
# Manifest list of chromedp/headless-shell:stable. The image serves CDP on port 9222.
BROWSER_IMAGE = 'chromedp/headless-shell@sha256:53cc0f33c0598ff244f6e45458f6dfaf0ae4206d388ae7364903afd1d9d14f0a'
SOCKET = '/var/run/docker.sock'
PROXY_PORT = 2375
BROWSER_PORT = 9222
NAME = re.compile(r'[a-z0-9][a-z0-9_.-]{0,80}')
LABEL_VALUE = re.compile(r'[A-Za-z0-9_.:@/-]{1,128}')
PROXY_FLAGS = (
    'ALLOW_PAUSE', 'ALLOW_RESTARTS', 'ALLOW_START', 'ALLOW_STOP', 'ALLOW_UNPAUSE',
    'AUTH', 'BUILD', 'COMMIT', 'CONFIGS', 'CONTAINERS', 'DISTRIBUTION', 'EVENTS',
    'EXEC', 'GRPC', 'IMAGES', 'INFO', 'NETWORKS', 'NODES', 'PING', 'PLUGINS', 'POST',
    'SECRETS', 'SERVICES', 'SESSION', 'SWARM', 'SYSTEM', 'TASKS', 'VERSION', 'VOLUMES',
)
READ_FLAGS = {'CONTAINERS': '1', 'INFO': '1', 'PING': '1', 'VERSION': '1'}
CONTROL_FLAGS = {'POST': '1', 'EXEC': '1', 'IMAGES': '1', 'NETWORKS': '1', 'VOLUMES': '1'}
# Fleet containers carry the company as cauce.fleet.tenant. Quota containers use cauce.quota.company.
COMPANY_LABEL_FORMAT = '{{.Label "cauce.fleet.tenant"}}\t{{.Label "cauce.quota.company"}}'
COMPANY_LABEL_BOUND = 1024 * 1024


def docker(*arguments: str) -> bytes:
    from fleet_executor_container import docker as run
    return run(*arguments)


def ownership(policy: dict, agent: dict) -> dict:
    from fleet_executor_container import expected_labels
    labels = expected_labels(policy, agent)
    if any(LABEL_VALUE.fullmatch(str(value)) is None for value in labels.values()):
        raise SafeFailure('sidecar ownership label is not canonical')
    return labels


def extensions(agent: dict) -> list:
    rows = agent.get('extensions')
    if rows is None:
        return []
    if not isinstance(rows, list) or len(rows) > 100 or any(not isinstance(row, dict) for row in rows):
        raise SafeFailure('extensions must be a bounded list')
    return rows


def one(rows: list, kind: str) -> dict | None:
    found = [row for row in rows if row.get('type') == kind]
    if len(found) > 1:
        raise SafeFailure(f'extension {kind} is ambiguous')
    return found[0] if found else None


def admit(policy: dict, kind: str) -> None:
    allowed = policy.get('extensions_allowed')
    types = allowed.get('types') if isinstance(allowed, dict) else None
    if not isinstance(types, list) or kind not in types:
        raise SafeFailure(f'computer does not admit extension {kind}')


def admit_docker_level(policy: dict, access: str) -> None:
    from fleet_executor_policy import admitted_docker_access
    allowed = policy.get('extensions_allowed')
    levels = admitted_docker_access(allowed.get('docker_access') if isinstance(allowed, dict) else None)
    if access not in levels:
        raise SafeFailure('computer does not admit docker access ' + access)


def own_company_labels(policy: dict, agent: dict) -> set[str]:
    own = set()
    tenant = agent.get('tenant_id')
    if isinstance(tenant, str) and tenant:
        own.add(tenant)
    for source in (agent, policy):
        company = source.get('company_id')
        if isinstance(company, str) and company:
            own.add(company)
    return own


def refuse_shared_daemon(policy: dict, agent: dict) -> None:
    from fleet_executor_policy import admitted_docker_daemon_dedicated
    allowed = policy.get('extensions_allowed')
    if isinstance(allowed, dict) and 'docker_daemon_dedicated' in allowed \
            and admitted_docker_daemon_dedicated(allowed['docker_daemon_dedicated']):
        return
    own = own_company_labels(policy, agent)
    raw = docker('ps', '-a', '--format', COMPANY_LABEL_FORMAT)
    if len(raw) > COMPANY_LABEL_BOUND:
        raise SafeFailure('docker daemon company labels exceed their bound')
    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError:
        raise SafeFailure('docker daemon company labels are outside the contract') from None
    for line in text.splitlines():
        parts = line.split('\t')
        if len(parts) != 2:
            raise SafeFailure('docker daemon company labels are outside the contract')
        if any(value and value not in own for value in parts):
            raise SafeFailure('docker daemon is shared with another company')


def proxy_environment(access: str) -> dict:
    if access not in {'read', 'control'}:
        raise SafeFailure('docker extension access is outside the contract')
    values = {flag: '0' for flag in PROXY_FLAGS}
    values.update(READ_FLAGS)
    if access == 'control':
        values.update(CONTROL_FLAGS)
    return values


def sidecar_plan(policy: dict, agent: dict) -> dict | None:
    if not isinstance(agent.get('container_name'), str) or NAME.fullmatch(agent['container_name']) is None:
        raise SafeFailure('sidecar container name is not canonical')
    for key in ('runtime_key', 'tenant_id', 'alias'):
        if not isinstance(agent.get(key), str) or not agent[key]:
            raise SafeFailure('sidecar agent identity is incomplete')
    for key in ('host_id', 'executor_user'):
        if not isinstance(policy.get(key), str) or not policy[key]:
            raise SafeFailure('sidecar policy identity is incomplete')
    if agent.get('host_id') not in (None, policy['host_id']):
        raise SafeFailure('sidecar agent host is not approved')
    rows = extensions(agent)
    docker_row = one(rows, 'docker')
    browser_row = one(rows, 'browser')
    access = None
    if docker_row is not None:
        if set(docker_row) != {'type', 'access'}:
            raise SafeFailure('docker extension is outside the contract')
        access = docker_row['access']
        proxy_environment(access)
        admit(policy, 'docker')
        admit_docker_level(policy, access)
        refuse_shared_daemon(policy, agent)
    browser = False
    if browser_row is not None:
        mode = browser_row.get('mode')
        if mode == 'sidecar' and set(browser_row) == {'type', 'mode'}:
            browser = True
        elif mode == 'ssh_tunnel' and set(browser_row) == {'type', 'mode', 'host', 'port'}:
            browser = False
        else:
            raise SafeFailure('browser extension is outside the contract')
        admit(policy, 'browser')
    if access is None and not browser:
        return None
    base = agent['container_name']
    return {'access': access, 'browser': browser, 'network': base + '-sidecars',
            'proxy': base + '-docker-proxy', 'chromium': base + '-browser'}


def public_result(plan: dict | None, browser_address: str | None = None) -> dict:
    if plan is None:
        return {'network': None, 'environment': {}, 'containers': []}
    environment = {}
    containers = []
    if plan['access'] is not None:
        environment['DOCKER_HOST'] = f'tcp://{plan["proxy"]}:{PROXY_PORT}'
        containers.append(plan['proxy'])
    if plan['browser']:
        # Chrome rejects a CDP Host that is not an IP or localhost. The private-network address is stable until recreate.
        if not isinstance(browser_address, str) or re.fullmatch(r'\d{1,3}(?:\.\d{1,3}){3}', browser_address) is None:
            raise SafeFailure('browser sidecar has no address on its private network')
        environment['CAUCE_BROWSER_CDP_URL'] = f'http://{browser_address}:{BROWSER_PORT}'
        containers.append(plan['chromium'])
    return {'network': plan['network'], 'environment': environment, 'containers': containers,
            'access': plan['access'], 'browser': 'sidecar' if plan['browser'] else None}


def labels_for(policy: dict, agent: dict, role: str) -> dict:
    return {**ownership(policy, agent), 'cauce.fleet.sidecar': role}


def label_arguments(labels: dict) -> list[str]:
    return [item for key, value in labels.items() for item in ('--label', f'{key}={value}')]


def inspect_container(name: str) -> dict | None:
    from fleet_executor_container import inspect_container as inspect
    return inspect(name)


def image_id(reference: str) -> str:
    items = json.loads(docker('image', 'inspect', reference))
    if not isinstance(items, list) or len(items) != 1 or not isinstance(items[0].get('Id'), str):
        raise SafeFailure('sidecar image is ambiguous')
    return items[0]['Id']


def environment_map(observed: dict) -> dict:
    values = {}
    for item in observed.get('Config', {}).get('Env') or []:
        if not isinstance(item, str) or '=' not in item:
            continue
        key, value = item.split('=', 1)
        values[key] = value
    return values


def owned(observed: dict | None, labels: dict) -> bool:
    current = (observed or {}).get('Config', {}).get('Labels') or {}
    return all(current.get(key) == value for key, value in labels.items())


def require_owned(name: str, observed: dict | None, labels: dict) -> dict:
    if observed is None:
        raise SafeFailure('sidecar container is missing')
    if not owned(observed, labels):
        raise SafeFailure('existing sidecar has another owner')
    if observed.get('Name') not in {name, '/' + name}:
        raise SafeFailure('sidecar container name differs')
    return observed


def network_observed(name: str) -> dict | None:
    listed = docker('network', 'ls', '--filter', 'name=^' + name + '$', '--format', '{{.Name}}').decode().splitlines()
    if name not in listed:
        return None
    items = json.loads(docker('network', 'inspect', name))
    if not isinstance(items, list) or len(items) != 1:
        raise SafeFailure('sidecar network observation is ambiguous')
    return items[0]


def ensure_network(policy: dict, agent: dict, plan: dict) -> None:
    labels = labels_for(policy, agent, 'network')
    observed = network_observed(plan['network'])
    if observed is None:
        docker('network', 'create', '--internal', *label_arguments(labels), plan['network'])
        observed = network_observed(plan['network'])
    if observed is None or observed.get('Internal') is not True or not all(
            (observed.get('Labels') or {}).get(key) == value for key, value in labels.items()):
        raise SafeFailure('sidecar network differs from the owned private network')


def proxy_arguments(policy: dict, agent: dict, plan: dict) -> list[str]:
    environment = proxy_environment(plan['access'])
    env_arguments = [item for key in PROXY_FLAGS for item in ('--env', f'{key}={environment[key]}')]
    # HAProxy writes /run/haproxy.pid. /run stays a tmpfs so the read-only root can keep the socket mount.
    return ['create', '--name', plan['proxy'], '--network', plan['network'], '--read-only',
            '--tmpfs', '/tmp:rw,nosuid,noexec,size=16m', '--tmpfs', '/run:rw,nosuid,noexec,size=16m',
            '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges', '--pids-limit', '64',
            '--mount', f'type=bind,source={SOCKET},destination={SOCKET},readonly',
            *label_arguments(labels_for(policy, agent, 'docker')), *env_arguments, PROXY_IMAGE]


def browser_arguments(policy: dict, agent: dict, plan: dict) -> list[str]:
    return ['create', '--name', plan['chromium'], '--network', plan['network'],
            '--shm-size', '268435456', '--tmpfs', '/tmp:rw,nosuid,size=64m',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128',
            *label_arguments(labels_for(policy, agent, 'browser')), BROWSER_IMAGE]


def create_or_keep(name: str, labels: dict, arguments: list[str]) -> None:
    observed = inspect_container(name)
    if observed is None:
        docker(*arguments)
        return
    require_owned(name, observed, labels)


def connect_agent(agent: dict, network: str) -> None:
    observed = inspect_container(agent['container_name'])
    if observed is None:
        return
    attached = (observed.get('NetworkSettings') or {}).get('Networks') or {}
    if network in attached:
        return
    # Docker refuses to add a network to a container whose only network is none.
    if observed.get('HostConfig', {}).get('NetworkMode') == 'none':
        raise SafeFailure('agent container uses network none and must be recreated on the sidecar network')
    docker('network', 'connect', network, agent['container_name'])


def container_address(name: str, network: str) -> str:
    observed = require_running(name)
    address = ((observed.get('NetworkSettings') or {}).get('Networks') or {}).get(network, {}).get('IPAddress')
    if not isinstance(address, str) or re.fullmatch(r'\d{1,3}(?:\.\d{1,3}){3}', address) is None:
        raise SafeFailure('browser sidecar has no address on its private network')
    return address


def require_running(name: str) -> dict:
    observed = inspect_container(name)
    if observed is None or not observed['State']['Running'] or observed['State']['Pid'] <= 0:
        raise SafeFailure('sidecar container is not observed running')
    return observed


def start_if_needed(name: str) -> dict:
    observed = inspect_container(name)
    if observed is None:
        raise SafeFailure('sidecar container is missing')
    if not observed['State']['Running']:
        docker('start', name)
        observed = inspect_container(name)
    if observed is None or not observed['State']['Running'] or observed['State']['Pid'] <= 0:
        raise SafeFailure('sidecar container is not observed running')
    return observed


def published(observed: dict) -> bool:
    ports = (observed.get('NetworkSettings') or {}).get('Ports') or {}
    bindings = (observed.get('HostConfig') or {}).get('PortBindings') or {}
    return any(ports.values()) or any(bindings.values())


def validate_proxy(policy: dict, agent: dict, plan: dict, observed: dict) -> None:
    labels = labels_for(policy, agent, 'docker')
    require_owned(plan['proxy'], observed, labels)
    expected = proxy_environment(plan['access'])
    actual = environment_map(observed)
    if any(actual.get(key) != value for key, value in expected.items()):
        raise SafeFailure('docker proxy allowlist differs')
    mounts = observed.get('Mounts') or []
    socket = [row for row in mounts if row.get('Destination') == SOCKET]
    networks = (observed.get('NetworkSettings') or {}).get('Networks') or {}
    if observed.get('Image') != image_id(PROXY_IMAGE) or observed['HostConfig'].get('ReadonlyRootfs') is not True \
            or observed['HostConfig'].get('Privileged') is not False or published(observed) \
            or set(networks) != {plan['network']} or len(socket) != 1 or socket[0].get('RW') is not False:
        raise SafeFailure('docker proxy isolation differs')


def validate_browser(policy: dict, agent: dict, plan: dict, observed: dict) -> None:
    labels = labels_for(policy, agent, 'browser')
    require_owned(plan['chromium'], observed, labels)
    networks = (observed.get('NetworkSettings') or {}).get('Networks') or {}
    if observed.get('Image') != image_id(BROWSER_IMAGE) or observed['HostConfig'].get('Privileged') is not False \
            or published(observed) or set(networks) != {plan['network']}:
        raise SafeFailure('browser sidecar isolation differs')


def validate_sidecars(policy: dict, agent: dict) -> dict:
    plan = sidecar_plan(policy, agent)
    if plan is None:
        return public_result(None)
    network = network_observed(plan['network'])
    network_labels = labels_for(policy, agent, 'network')
    if network is None or network.get('Internal') is not True or not all(
            (network.get('Labels') or {}).get(key) == value for key, value in network_labels.items()):
        raise SafeFailure('sidecar network differs from the owned private network')
    if plan['access'] is not None:
        validate_proxy(policy, agent, plan, require_running(plan['proxy']))
    elif inspect_container(plan['proxy']) is not None:
        raise SafeFailure('docker proxy exists without a docker extension')
    if plan['browser']:
        validate_browser(policy, agent, plan, require_running(plan['chromium']))
    elif inspect_container(plan['chromium']) is not None:
        raise SafeFailure('browser sidecar exists without a sidecar extension')
    agent_container = inspect_container(agent['container_name'])
    if agent_container is not None:
        attached = (agent_container.get('NetworkSettings') or {}).get('Networks') or {}
        if plan['network'] not in attached:
            raise SafeFailure('agent container is outside its sidecar network')
    address = container_address(plan['chromium'], plan['network']) if plan['browser'] else None
    return public_result(plan, address)


def ensure_sidecars(policy: dict, agent: dict) -> dict:
    plan = sidecar_plan(policy, agent)
    if plan is None:
        return public_result(None)
    ensure_network(policy, agent, plan)
    if plan['access'] is not None:
        create_or_keep(plan['proxy'], labels_for(policy, agent, 'docker'), proxy_arguments(policy, agent, plan))
        start_if_needed(plan['proxy'])
    if plan['browser']:
        create_or_keep(plan['chromium'], labels_for(policy, agent, 'browser'), browser_arguments(policy, agent, plan))
        start_if_needed(plan['chromium'])
    connect_agent(agent, plan['network'])
    return validate_sidecars(policy, agent)


def remove_container(name: str, labels: dict) -> dict | None:
    observed = inspect_container(name)
    if observed is None:
        return None
    if not owned(observed, labels):
        raise SafeFailure('existing sidecar has another owner')
    docker('rm', '-f', name)
    return {'type': 'container', 'name': name}


def purge_sidecars(policy: dict, agent: dict) -> dict:
    if not isinstance(agent.get('container_name'), str) or NAME.fullmatch(agent['container_name']) is None:
        raise SafeFailure('sidecar container name is not canonical')
    base = agent['container_name']
    names = {'network': base + '-sidecars', 'proxy': base + '-docker-proxy', 'chromium': base + '-browser'}
    removed = []
    for name, role in ((names['proxy'], 'docker'), (names['chromium'], 'browser')):
        row = remove_container(name, labels_for(policy, agent, role))
        if row is not None:
            removed.append(row)
    network = network_observed(names['network'])
    if network is not None:
        network_labels = labels_for(policy, agent, 'network')
        if not all((network.get('Labels') or {}).get(key) == value for key, value in network_labels.items()):
            raise SafeFailure('existing sidecar network has another owner')
        agent_container = inspect_container(agent['container_name'])
        attached = ((agent_container or {}).get('NetworkSettings') or {}).get('Networks') or {}
        if agent_container is not None and names['network'] in attached:
            docker('network', 'disconnect', names['network'], agent['container_name'])
        docker('network', 'rm', names['network'])
        removed.append({'type': 'network', 'name': names['network']})
    return {'removed': removed}
