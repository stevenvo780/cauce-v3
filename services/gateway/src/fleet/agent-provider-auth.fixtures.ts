import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { FleetOperationsRepository, type DatabasePool } from '@cauce/store';
import { channelCapabilities, channelCompany, channelCreate, channelHost } from './host-channel.fixtures.js';
import { SignedHostChannel, HostChannelFleetSource } from './signed-source.js';
import { AgentProviderAuthHost } from './agent-provider-auth-host.js';
import { FleetExecutor } from './executor.js';

export async function enrolledAgentAuthFixture(pool: DatabasePool, app: FastifyInstance) {
  const company = await channelCompany(pool, 'agent-auth-local'); const host = await channelHost(pool, company);
  const user = userInfo(); const directory = await mkdtemp(join(user.homedir, 'cauce-agent-auth-'));
  const gateway = await app.listen({ host: '127.0.0.1', port: 0 });
  const identity = (await pool.query<{ enrollment_id: string; key_fingerprint: string }>(
    'SELECT enrollment_id,key_fingerprint FROM fleet_host_identities WHERE host_id=$1', [host.host_id])).rows[0];
  await writeFile(join(directory, 'identity.json'), JSON.stringify({ ...identity, host_id: host.host_id, company_id: host.company_id,
    gateway, state: 'enrolled', executor_ready: false }), { mode: 0o600 });
  await writeFile(join(directory, 'private.pem'), host.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const channel = await SignedHostChannel.load(directory); const source = new HostChannelFleetSource(channel);
  const capabilities = channelCapabilities(); capabilities.templates = [{ template_id: 'native-synthetic', provider: 'codex', harness_id: 'codex',
    runtime_user: user.username, mode: 'native', home_directory: directory, state_root: directory, systemd_user: user.username }];
  await channel.request('POST', `/v3/fleet/hosts/${host.host_id}/channel`, capabilities);
  const request = channelCreate(company, host, 'auth-local');
  if (request.kind !== 'create') throw new Error('Synthetic request is unavailable');
  request.parameters.placement = { host_id: host.host_id, mode: 'native', runtime_user: user.username, home_directory: directory,
    state_directory: join(directory, 'runtime'), systemd_user: user.username };
  const actor = { tenant_id: company.hub.id, alias: 'owner', subject: `console:${company.user.id}`, requestedCompany: company.company.id };
  const repository = new FleetOperationsRepository(pool);
  const operation = await repository.enqueue(actor.tenant_id, actor.alias, request, actor.subject);
  const executor = new FleetExecutor(source, { host: host.host_id, worker: `host-${host.host_id}`,
    perform: async step => step === 'authenticate' ? { awaiting_auth: true, evidence: {} }
      : { evidence: { runtime_digest: 'a'.repeat(64), artifact_sha256: 'b'.repeat(64), certificate_fingerprint: 'c'.repeat(64) } } });
  await executor.runOnce();
  const settled = await repository.get(actor.tenant_id, actor.alias, operation.id, actor.subject);
  if (settled.status !== 'awaiting_auth') throw new Error(`Synthetic fleet preparation did not await auth: ${settled.status}`);
  const python = await realpath('/usr/bin/python3'); const command = join(directory, 'synthetic-codex');
  const verified = join(directory, 'synthetic-identity');
  const commandSource = command + '.c';
  await writeFile(commandSource, `#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <termios.h>
int main(int argc,char **argv) {
 if(argc!=3||strcmp(argv[1],"login")||strcmp(argv[2],"--device-auth"))return 2;
 struct termios mode;if(tcgetattr(0,&mode))return 3;mode.c_lflag&=~ECHO;tcsetattr(0,TCSANOW,&mode);
 printf("SYNTHETIC_PTY %d %s\\n",(int)getuid(),isatty(0)?"True":"False");fflush(stdout);
 char input[100];if(fgets(input,sizeof input,stdin)&&!strcmp(input,"SYNTHETIC_LOGIN_INPUT\\n")) {
  FILE *file=fopen(${JSON.stringify(verified)},"w");if(!file)return 4;fputs("synthetic",file);fclose(file);
  puts("SYNTHETIC_INPUT_ACCEPTED");fflush(stdout);
 }
 sleep(60);return 0;
}
`, { mode: 0o600 });
  await promisify(execFile)('/usr/bin/cc', [commandSource, '-o', command], { timeout: 10_000 });
  const fingerprint = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');
  const helper = fileURLToPath(new URL('../../../../ops/cli/provider-login.py', import.meta.url));
  const profile = { provider: 'codex', path: join(directory, 'synthetic-profile'), identity: 'agent-auth-local-account', runtime_user: user.username };
  const profiles = { 'agent-auth-local-account': profile }; const policyFile = join(directory, 'executor-policy.json');
  await writeFile(policyFile, JSON.stringify({ schemaVersion: 1, host_id: host.host_id, profiles }), { mode: 0o600 });
  const authPolicyFile = join(directory, 'auth-policy.json');
  await writeFile(authPolicyFile, JSON.stringify({ schemaVersion: 1, host_id: host.host_id, state_root: directory,
    helper: { executable: helper, sha256: await fingerprint(helper) }, profiles,
    logins: { codex: { method: 'device', command: [command, 'login', '--device-auth'], sha256: await fingerprint(command) } } }), { mode: 0o600 });
  const executable = join(directory, 'synthetic-executor.py');
  await writeFile(executable, `import json,sys,pathlib
x=json.load(sys.stdin);policy=json.load(open(sys.argv[sys.argv.index('--policy')+1]))
assert all('credential_ref' not in account for account in x['trusted_accounts'])
if '--binding' in sys.argv:
 agent=next(a for a in x['snapshot']['agents'] if a['alias']=='auth-local')
 print(json.dumps({'agent':agent,'profile_binding':policy['profiles'][agent['primary_account_id']]}))
else:
 step=sys.argv[sys.argv.index('--step')+1]
 assert step in ['login-stop','authenticate']
 print(json.dumps({'evidence':{'stopped_verified':True} if step=='login-stop' else {'provider_verified':pathlib.Path(${JSON.stringify(verified)}).exists()}}))
`, { mode: 0o600 });
  const hostRuntime = new AgentProviderAuthHost(channel, { hostConfig: { host: host.host_id,
    command: { python, executable, policyFile, timeoutMs: 5000 } }, authPolicyFile,
    projectRoot: fileURLToPath(new URL('../../../../', import.meta.url)) });
  hostRuntime.start();
  return { company, host, actor, operation, channel, directory, hostRuntime, verified, command };
}
