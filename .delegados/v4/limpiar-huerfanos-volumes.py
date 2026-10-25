from __future__ import annotations

import datetime
import hashlib
import json
import os
import re
import shlex
import subprocess

NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z')
HASH = re.compile(r'[a-f0-9]{64}\Z')
TEST = re.compile(r'(?:^|[_.-])(?:zz-canary-|e2e(?:[_.-]|$)|lab(?:[_.-]|$))', re.I)
LABELS = ('cauce.fleet.alias', 'cauce.fleet.tenant', 'cauce.fleet.host', 'cauce.fleet.runtime_key',
          'cauce.fleet.owner', 'cauce.fleet.operation', 'cauce.company_id', 'cauce.fleet.company', 'cauce.e2e.owner',
          'com.docker.compose.project', 'com.docker.compose.volume', 'org.testcontainers')


class VolumeBlocked(RuntimeError):
    pass


def retention_policy():
    try:
        value = json.loads(os.environ["CAUCE_ORPHANS_RETENTION_POLICY"])
    except (KeyError, TypeError, ValueError):
        raise VolumeBlocked("explicit retention policy is required") from None
    fields = {"protected_identifiers", "protected_pattern", "campaign_pattern", "inventory_company",
              "platform_company", "lab_owner"}
    if not isinstance(value, dict) or set(value) != fields:
        raise VolumeBlocked("invalid retention policy")
    identities = value["protected_identifiers"]
    if not isinstance(identities, list) or not identities or any(
            not isinstance(identity, str) or not identity or len(identity) > 128 for identity in identities):
        raise VolumeBlocked("invalid protected identifiers")
    for field in fields - {"protected_identifiers"}:
        item = value[field]
        if not isinstance(item, str) or not item or len(item) > 512 or any(ord(char) < 32 for char in item):
            raise VolumeBlocked("invalid retention policy field")
    try:
        for field in ("protected_pattern", "campaign_pattern"):
            re.compile(value[field], re.I)
    except re.error:
        raise VolumeBlocked("invalid retention policy pattern") from None
    return value


def ssh_targets():
    try:
        targets = json.loads(os.environ.get("CAUCE_ORPHANS_SSH_TARGETS", "[]"))
    except (TypeError, ValueError):
        raise VolumeBlocked("invalid SSH target configuration") from None
    if not isinstance(targets, list) or any(
            not isinstance(target, str) or not target or len(target) > 255 or target.startswith("-")
            or any(char.isspace() or ord(char) < 32 for char in target) for target in targets):
        raise VolumeBlocked("invalid SSH target configuration")
    return set(targets)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def validate(item, plan):
    required = {'id', 'kind', 'name', 'scope', 'location', 'pin'}
    if not isinstance(item, dict) or set(item) != required \
            or item['kind'] not in {'test_volume', 'test_container', 'test_network', 'test_image'} \
            or not isinstance(item['name'], str) \
            or not (re.fullmatch(r'sha256:[a-f0-9]{64}', item['name']) if item['kind'] == 'test_image'
                    else NAME.fullmatch(item['name'])):
        raise VolumeBlocked('El recurso Docker no tiene un esquema acotado')
    scope = item['scope']
    if not isinstance(scope, dict) or 'company_id' not in scope \
            or set(scope) - {'company_id', 'tenant_id', 'alias', 'host_id'} \
            or any(not isinstance(value, str) or not value or len(value) > 128 for value in scope.values()) \
            or scope['company_id'] != plan['company_id']:
        raise VolumeBlocked('El alcance del volumen no coincide con el plan')
    location = item['location']
    if location == {'kind': 'lab_socket'}:
        if not plan['company_id'].startswith('zz-canary-h10'):
            raise VolumeBlocked('El socket de laboratorio sólo admite una compañía sintética h10')
    elif not isinstance(location, dict) or set(location) != {'kind', 'target'} \
            or location['kind'] != 'ssh' or location['target'] not in ssh_targets():
        raise VolumeBlocked('El destino Docker no es uno de los destinos explícitos autorizados')
    elif plan['company_id'] != retention_policy()["platform_company"]:
        raise VolumeBlocked('remote cleanup requires the configured platform company')
    pin = item['pin']
    identity = 'volume_sha256' if item['kind'] == 'test_volume' else 'resource_sha256'
    if not isinstance(pin, dict) or set(pin) != {'daemon_id', identity, 'preview_sha256'} \
            or not isinstance(pin['daemon_id'], str) or not 1 <= len(pin['daemon_id']) <= 128 \
            or any(pin[key] is not None and (not isinstance(pin[key], str) or not HASH.fullmatch(pin[key]))
                   for key in (identity, 'preview_sha256')):
        raise VolumeBlocked('Los pins del volumen no son válidos')


def command(location, arguments):
    if location['kind'] == 'lab_socket':
        return ['docker', *arguments]
    return ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', location['target'],
            shlex.join(['docker', *arguments])]


def run(location, arguments):
    result = subprocess.run(command(location, arguments), capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise VolumeBlocked('Docker no pudo acreditar la consulta o el efecto solicitado')
    return result.stdout.strip()


def inspect(item):
    location, name = item['location'], item['name']
    daemon = json.loads(run(location, ['info', '--format', '{{json .ID}}']))
    if daemon != item['pin']['daemon_id']:
        raise VolumeBlocked('La identidad del daemon cambió')
    if item['kind'] != 'test_volume':
        return inspect_resource(item, daemon)
    names = run(location, ['volume', 'ls', '--format', '{{.Name}}']).splitlines()
    if name not in names:
        return {'daemon_id': daemon, 'name': name, 'exists': False}
    selected = '{{json .Name}}\n{{json .Driver}}\n{{json .Scope}}\n{{json .CreatedAt}}\n{{len .Options}}\n'
    selected += '\n'.join('{{json (index .Labels "' + key + '")}}' for key in LABELS)
    values = [json.loads(value) for value in run(location, ['volume', 'inspect', '--format', selected, name]).splitlines()]
    if len(values) != 5 + len(LABELS) or values[0] != name or not isinstance(values[3], str) or not values[3]:
        raise VolumeBlocked('Docker no devolvió los metadatos exactos del volumen')
    volume = dict(zip(('name', 'driver', 'scope', 'created_at', 'option_count'), values[:5], strict=True))
    volume['labels'] = dict(zip(LABELS, values[5:], strict=True))
    references = run(location, ['ps', '-a', '--no-trunc', '--filter', 'volume=' + name,
                                '--format', '{{.ID}}']).splitlines()
    if any(not re.fullmatch(r'[a-f0-9]{64}', value) for value in references):
        raise VolumeBlocked('La lista de montajes no es verificable')
    return {'daemon_id': daemon, 'name': name, 'exists': True, 'volume': volume,
            'volume_sha256': digest(volume), 'container_references': sorted(references)}


def inspect_resource(item, daemon):
    kind, name, location = item['kind'][5:], item['name'], item['location']
    if kind == 'image':
        identities = run(location, ['image', 'ls', '--all', '--quiet', '--no-trunc']).splitlines()
        present = name in identities
        template = '{{json .Id}}\n{{json .RepoTags}}\n{{json (index . "Created")}}\n{{json .Size}}'
        fields = ('id', 'tags', 'created_at', 'size_bytes')
    else:
        flags = ['-a', '--no-trunc'] if kind == 'container' else ['--no-trunc']
        names = run(location, [kind, 'ls', *flags, '--format', '{{.Name}}' if kind == 'network' else '{{.Names}}']).splitlines()
        present = name in names
        if kind == 'container':
            template = '{{json .Id}}\n{{json .Name}}\n{{json .Created}}\n{{json .State.Running}}\n{{json .Image}}'
            fields = ('id', 'name', 'created_at', 'running', 'image_id')
        else:
            template = '{{json .Id}}\n{{json .Name}}\n{{json .Created}}\n{{json .Driver}}\n{{json .Scope}}\n{{len .Containers}}'
            fields = ('id', 'name', 'created_at', 'driver', 'scope', 'endpoint_count')
    if not present:
        return {'daemon_id': daemon, 'name': name, 'exists': False}
    base = '(index .Config "Labels")' if kind == 'image' else '.Config.Labels' if kind == 'container' else '.Labels'
    selected = ['{{json (index ' + base + ' "' + key + '")}}' for key in LABELS]
    if kind == 'image':
        selected = ['{{if index .Config "Labels"}}' + value + '{{else}}null{{end}}' for value in selected]
    template += '\n' + '\n'.join(selected)
    values = [json.loads(value) for value in run(location, [kind, 'inspect', '--format', template, name]).splitlines()]
    if len(values) != len(fields) + len(LABELS):
        raise VolumeBlocked('Docker no devolvió los metadatos exactos del recurso')
    resource = dict(zip(fields, values[:len(fields)], strict=True))
    resource['labels'] = dict(zip(LABELS, values[len(fields):], strict=True))
    if not re.fullmatch(r'sha256:[a-f0-9]{64}' if kind == 'image' else r'[a-f0-9]{64}', resource['id']):
        raise VolumeBlocked('Docker no acreditó una identidad inmutable')
    if kind == 'container':
        resource['name'] = resource['name'].removeprefix('/')
        if resource['name'] != name or type(resource['running']) is not bool:
            raise VolumeBlocked('El nombre o estado del contenedor cambió')
    references = []
    image_container_count = None
    if kind == 'image':
        references = run(location, ['ps', '-a', '--no-trunc', '--filter', 'ancestor=' + name, '--format', '{{.ID}}']).splitlines()
        if any(not re.fullmatch(r'[a-f0-9]{64}', value) for value in references):
            raise VolumeBlocked('Las referencias de la imagen no son verificables')
        usage = run(location, ['system', 'df', '--verbose', '--format',
                               '{{range .Images}}{{json .ID}}|{{json .Containers}}{{println}}{{end}}'])
        counts = []
        for line in usage.splitlines():
            identity, count = (json.loads(value) for value in line.split('|'))
            if identity in {name, resource['id']}:
                if isinstance(count, str) and re.fullmatch(r'[0-9]+', count):
                    count = int(count)
                counts.append(count)
        if len(counts) != 1 or type(counts[0]) is not int or counts[0] < 0:
            raise VolumeBlocked('Docker no acreditó el contador de referencias de la imagen')
        image_container_count = counts[0]
    return {'daemon_id': daemon, 'name': name, 'exists': True, 'resource': resource,
            'resource_sha256': digest(resource), 'container_references': sorted(references),
            **({'image_container_count': image_container_count} if kind == 'image' else {})}


def retained(item, reason):
    return {'id': item['id'], 'status': 'retained', 'reason_code': reason,
            'resource_type': item['kind'][5:], 'name': item['name'], 'scope': item['scope'],
            'reason': 'Recurso conservado por identidad, propiedad, referencias o recibo insuficiente: ' + reason}


def protection(item, observed):
    values = [item['name'], *item['scope'].values()]
    resource = observed.get('volume', observed.get('resource', {}))
    labels = resource.get('labels', {})
    values.extend(value for value in labels.values() if isinstance(value, str))
    if any(re.search(retention_policy()["protected_pattern"], value, re.I) for value in values):
        return 'praxis_inventory_only'
    if any(re.search(retention_policy()["campaign_pattern"], value, re.I) for value in values):
        return 'active_campaign_144'
    alias = labels.get('cauce.fleet.alias')
    runtime = labels.get('cauce.fleet.runtime_key')
    scoped_alias = item['scope'].get('alias')
    if any(value and not TEST.search(value) for value in (alias, runtime, scoped_alias)):
        return 'real_agent_volume'
    for key in ('alias', 'tenant_id', 'host_id'):
        label_key = {'alias': 'alias', 'tenant_id': 'tenant', 'host_id': 'host'}[key]
        label = labels.get('cauce.fleet.' + label_key)
        if label and item['scope'].get(key) and item['scope'][key] != label:
            return 'scope_mismatch'
    companies = [labels.get(key) for key in ('cauce.company_id', 'cauce.fleet.company')]
    if any(value and value.casefold() != retention_policy()["platform_company"] and not TEST.search(value) for value in companies):
        return 'other_company_volume'
    if item['kind'] == 'test_volume':
        if resource.get('driver') != 'local' or resource.get('scope') != 'local':
            return 'nonlocal_volume'
        if resource['option_count'] != 0:
            return 'volume_driver_options'
    if item['kind'] == 'test_container' and resource.get('running') is not False:
        return 'container_running'
    if item['kind'] == 'test_network':
        if resource.get('endpoint_count') != 0:
            return 'network_has_endpoints'
        if resource.get('driver') != 'bridge' or resource.get('scope') != 'local' \
                or item['name'] in {'bridge', 'host', 'none'}:
            return 'system_or_nonlocal_network'
    names = resource.get('tags') or [] if item['kind'] == 'test_image' else [item['name']]
    if item['kind'] == 'test_image' and len(names) > 1:
        return 'image_has_multiple_tags'
    compose_test = bool(re.fullmatch(r'cauce-test-[0-9]+-[a-f0-9]{12}', labels.get('com.docker.compose.project') or ''))
    if item['kind'] == 'test_image' and names and any(not TEST.search(name)
            and not name.startswith('cauce-ui-functional:')
            and not (compose_test and re.fullmatch(r'cauce-v3-test-(?:qa|runtime):[A-Za-z0-9_.-]+', name)) for name in names):
        return 'image_has_non_test_tag'
    if item['location']['kind'] == 'lab_socket' and (labels.get('cauce.e2e.owner') != retention_policy()["lab_owner"]
            or not names or any(not name.startswith('zz-canary-' + retention_policy()["lab_owner"] + '-') for name in names)):
        return 'lab_ownership_missing'
    test_name = any(TEST.search(name) or name.startswith('cauce-ui-functional:') for name in names)
    test_label = labels.get('org.testcontainers') == 'true' or bool(labels.get('cauce.e2e.owner')) or compose_test
    if not test_name and not test_label:
        return 'test_provenance_missing'
    if observed.get('container_references') or observed.get('image_container_count', 0) > 0:
        return 'volume_mounted' if item['kind'] == 'test_volume' else 'image_referenced'
    return None


def fresh(saved, preview_sha):
    try:
        observed = datetime.datetime.fromisoformat(saved['observed_at'])
        age = (datetime.datetime.now(datetime.UTC) - observed).total_seconds()
        return observed.tzinfo is not None and 0 <= age <= 120 \
            and saved['status'] == 'would_remove' and saved['preview_sha256'] == preview_sha
    except (KeyError, TypeError, ValueError):
        return False


def action(item, plan, saved, journal, apply):
    identity = 'volume_sha256' if item['kind'] == 'test_volume' else 'resource_sha256'
    observed = inspect(item)
    if not observed['exists']:
        if saved.get('status') == 'removed' and saved.get(identity) == item['pin'][identity]:
            return {**saved, 'idempotent_replay': True}, False
        if saved.get('status') == 'prepared' and saved.get(identity) == item['pin'][identity] \
                and saved.get('preview_sha256') == item['pin']['preview_sha256']:
            return {**saved, 'status': 'removed', 'reason_code': 'absent_after_prepared_effect',
                    'reason': 'El volumen está ausente tras un intento durable; no se reenvía ni se atribuye su retirada.',
                    'prior_effects_possible': True, 'idempotent_replay': True}, False
        return retained(item, 'resource_absent_without_receipt'), apply
    reason = protection(item, observed)
    if reason:
        return retained(item, reason), False
    preview = {'version': 1, 'kind': item['kind'], 'company_id': plan['company_id'],
               'location': item['location'], 'scope': item['scope'], **observed}
    preview_sha = digest(preview)
    result = {'id': item['id'], 'status': 'would_remove', 'reason_code': 'ready',
              'reason': 'Recurso de prueba sin referencias, identidad y preview verificadas en Docker.',
              'name': item['name'], 'scope': item['scope'], 'preview': preview,
              'preview_sha256': preview_sha, identity: observed[identity],
              'observed_at': datetime.datetime.now(datetime.UTC).isoformat()}
    if item['pin'][identity] is None or item['pin']['preview_sha256'] is None:
        return {**result, 'status': 'retained', 'reason_code': 'preview_review_required'}, apply
    if item['pin'][identity] != observed[identity] or item['pin']['preview_sha256'] != preview_sha:
        return {**result, 'status': 'blocked', 'reason_code': 'preview_changed'}, True
    if not apply:
        return result, False
    if not fresh(saved, preview_sha):
        return {**result, 'status': 'blocked', 'reason_code': 'fresh_simulation_required'}, True
    renewed = inspect(item)
    if renewed != observed or protection(item, renewed):
        return {**result, 'status': 'blocked', 'reason_code': 'inventory_changed'}, True
    result['status'] = 'prepared'
    journal(result)
    target = item['name'] if item['kind'] == 'test_volume' else observed['resource']['id']
    run(item['location'], [item['kind'][5:], 'rm', *(['--no-prune'] if item['kind'] == 'test_image' else []), target])
    after = inspect(item)
    if after['exists']:
        raise VolumeBlocked('El recurso continúa presente después de la retirada')
    return {**result, 'status': 'removed', 'reason_code': item['kind'][5:] + '_removed',
            'reason': 'Docker retiró el recurso exacto sin referencias; ausencia comprobada.'}, False
