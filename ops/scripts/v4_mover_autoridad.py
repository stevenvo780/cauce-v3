"""Read central issuance metadata without exporting credential material."""
from __future__ import annotations

import json
import re
import shlex
import subprocess

OBSERVER = r'''
import hashlib,importlib.util,json,os,pathlib,stat,sys
tenant,alias,host,key=sys.argv[1:]
def read_command():
    filename='/etc/cauce-v3/fleet-v35/signed-authority/command.v1.json'
    fd=os.open(filename,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        details=os.fstat(fd)
        if not stat.S_ISREG(details.st_mode) or details.st_uid!=0 or details.st_nlink!=1 or details.st_mode&0o077 or details.st_size>16384:
            raise ValueError('unsafe authority command')
        return json.loads(os.read(fd,16385))
    finally:
        os.close(fd)
command=read_command()
filename=pathlib.Path(command['executable'])
if hashlib.sha256(filename.read_bytes()).hexdigest()!=command['sha256']:
    raise ValueError('authority issuer pin changed')
spec=importlib.util.spec_from_file_location('issuer',filename)
issuer=importlib.util.module_from_spec(spec);spec.loader.exec_module(issuer)
raw,_=issuer.read(issuer.path(command['policy_file']),private=True)
if issuer.digest(raw)!=command['policy_sha256']:
    raise ValueError('authority policy pin changed')
state,registries,owners=issuer.policy_paths(json.loads(raw))
agent={'tenant_id':tenant,'alias':alias}
rows=issuer.inventory(registries,owners,agent)
history=[]
paths=list(state.glob('*.json'))
if len(paths)>20000:
    raise ValueError('authority history exceeds bound')
for path in paths:
    raw,_=issuer.read(path,private=True)
    journal=json.loads(raw);binding=journal.get('binding',{});scope=binding.get('scope',{})
    if binding.get('agent')!=agent or scope.get('host_id')!=host or scope.get('runtime_key')!=key:
        continue
    history.append({'operation_id':scope['operation_id'],'host_id':host,'runtime_key':key,
        'preserve_legacy':binding.get('preserve_legacy',False),
        'issued':[{'phase':phase,'registered':entry.get('registered',False),
            'certificate_sha256':entry['receipt']['certificate_sha256'],
            'expires_at':entry['receipt']['expires_at']}
            for phase,entry in journal.get('issued',{}).items()],
        'revocation_requested':'revoked' in journal,'revoke_complete':journal.get('revoke_complete',False)})
authorities=[{'id':name,'sha256':proof['sha256'],'records':[
    {'principal':{field:row['principal'][field] for field in
        ('tenant_id','alias','channel','session_id','roles','permissions') if field in row['principal']},'expires_at':row.get('expires_at'),
     **({'certificate_sha256':row['certificate_sha256']} if 'certificate_sha256' in row else {})}
    for row in proof['matching_records']]} for name,_,_,proof in rows]
print(json.dumps({'read_only':True,'tenant':tenant,'alias':alias,'host_id':host,'runtime_key':key,
    'authorities':authorities,'history':history,
    'active_fleet_records':sum(len(row['records']) for row in authorities if row['id'].startswith('fleet_'))}))
'''


def inventory(settings, tenant, alias, host, runtime_key):
    route = settings.get('route', 'local')
    if route != 'local' and re.fullmatch(r'ssh:[A-Za-z0-9_][A-Za-z0-9_.@-]*', route) is None:
        raise ValueError('invalid central authority route')
    command = ['python3', '-I', '-B', '-c', OBSERVER, tenant, alias, host, runtime_key]
    if route != 'local':
        command = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', route[4:], shlex.join(command)]
    result = subprocess.run(command, capture_output=True, text=True, timeout=90, check=False)
    if result.returncode:
        raise RuntimeError('central authority metadata observation is unverified')
    observed = json.loads(result.stdout)
    if observed.get('read_only') is not True or any(observed.get(field) != value for field, value in
            [('tenant', tenant), ('alias', alias), ('host_id', host), ('runtime_key', runtime_key)]):
        raise ValueError('central authority inventory scope changed')
    return observed
