import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRfcUuid, objectRecord } from '@cauce/protocol';
import { functionalTenants, type FunctionalTenant, type startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';

type Fixture = Awaited<ReturnType<typeof startConsoleFunctionalFixture>>;
export interface CapturedFile {
  name: string;
  mime_type: string;
  file_size: number;
  sha256: string;
  local_path: string;
  bytes_base64: string;
  mode: number;
}
interface CapturedTurn { native_session_id: string; files: CapturedFile[] }
export interface FileAdapter { capture: string; workspace: string }

export async function readFileTurns(adapter: FileAdapter): Promise<CapturedTurn[]> {
  const lines = (await readFile(adapter.capture, 'utf8')).trim().split('\n');
  return lines.map((line) => {
    const turn = objectRecord(JSON.parse(line) as unknown);
    if (!turn || !isRfcUuid(turn.native_session_id) || !Array.isArray(turn.files)) throw new Error('Invalid synthetic file turn');
    const files = turn.files.map((value: unknown) => {
      const item = objectRecord(value);
      if (!item || typeof item.name !== 'string' || typeof item.mime_type !== 'string'
          || typeof item.file_size !== 'number' || typeof item.sha256 !== 'string'
          || typeof item.local_path !== 'string' || typeof item.bytes_base64 !== 'string'
          || typeof item.mode !== 'number') throw new Error('Invalid synthetic file capture');
      return { name: item.name, mime_type: item.mime_type, file_size: item.file_size,
        sha256: item.sha256, local_path: item.local_path, bytes_base64: item.bytes_base64, mode: item.mode };
    });
    return { native_session_id: turn.native_session_id, files };
  });
}

export async function startFileAdapter(fixture: Fixture, tenant: FunctionalTenant): Promise<FileAdapter> {
  const tls = fixture.pki.adapterCerts[functionalTenants.indexOf(tenant)];
  if (!tls) throw new Error('Missing owned adapter certificate');
  const stem = tenant.tenant.toLowerCase();
  const home = join(fixture.directory, `fh-${stem}`);
  const codexHome = join(fixture.directory, `fc-${stem}`);
  const workspace = join(fixture.directory, `files-${stem}`);
  const capture = join(fixture.directory, `file-turns-${stem}.jsonl`);
  const harness = join(fixture.directory, `file-codex-${stem}.mjs`);
  await Promise.all([home, codexHome, workspace].map((directory) => mkdir(directory, { mode: 0o700 })));
  const script = `#!/usr/bin/env node
import { randomUUID, createHash } from 'node:crypto';
import { appendFile, readFile, realpath, stat } from 'node:fs/promises';
import { sep } from 'node:path';
const root=await realpath(${JSON.stringify(workspace)});
const chunks=[];let size=0;
for await(const item of process.stdin){size+=item.length;if(size>1048576)throw new Error('File fixture prompt budget exceeded');chunks.push(Buffer.from(item));}
const prompt=Buffer.concat(chunks).toString('utf8');
if(!prompt.includes('--- BEGIN TRUSTED DELIVERY CONTEXT ---'))throw new Error('Missing trusted delivery context');
const files=[];
for(const line of prompt.split('\\n')){
 const match=/^Attachment \\d+: (.+)$/u.exec(line);if(!match)continue;
 const item=JSON.parse(match[1]);
 const path=await realpath(item.local_path);if(!path.startsWith(root+sep))throw new Error('Attachment escaped owned workspace');
 const info=await stat(path);if(!info.isFile()||(info.mode&0o777)!==0o600)throw new Error('Attachment is not a private regular file');
 const bytes=await readFile(path);const sha=createHash('sha256').update(bytes).digest('hex');
 if(bytes.length!==item.file_size||sha!==item.sha256)throw new Error('Materialized attachment differs from its identity');
 files.push({...item,local_path:path,mode:info.mode&0o777,bytes_base64:bytes.toString('base64')});
}
if(files.length===0)throw new Error('No materialized attachment delivered to harness');
const args=process.argv.slice(2);const resume=args.indexOf('resume');
const sid=resume<0?randomUUID():args[resume+2];if(!sid)throw new Error('Missing Codex resume SID');
await appendFile(${JSON.stringify(capture)},JSON.stringify({native_session_id:sid,files})+'\\n',{mode:0o600});
const result={reply:'archivo recibido por harness sintético',messages:[],notify:[],status:'done',retryable:false,artifacts:[]};
process.stdout.write(JSON.stringify({type:'thread.started',thread_id:sid})+'\\n');
process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}})+'\\n');
`;
  await writeFile(harness, script, { mode: 0o700, flag: 'wx' });
  await chmod(harness, 0o700);
  const child = spawn(process.execPath, ['packages/adapter-sdk/dist/src/bin/codex.js'], {
    cwd: process.cwd(), env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'test', HOME: home, CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'),
      CAUCE_TENANT: tenant.tenant, CAUCE_ROOM: tenant.room, CAUCE_ALIAS: tenant.target,
      CAUCE_INSTANCE_ID: `file-e2e-${stem}`, CAUCE_STATE_DIR: join(fixture.directory, `fs-${stem}`),
      CAUCE_AGENT_WORKSPACE: workspace,
      CAUCE_RELAY_URL: `${fixture.gatewayUrl.replace('https:', 'wss:')}/v3/ws`, CAUCE_ENVIRONMENT: 'test',
      CAUCE_HARNESS_COMMAND: harness, CAUCE_HEARTBEAT_MS: '250',
      CAUCE_TLS_CERT_FILE: tls.cert, CAUCE_TLS_KEY_FILE: tls.key, CAUCE_TLS_CA_FILE: fixture.pki.ca.cert,
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const [channel, stream] of [['stdout', child.stdout], ['stderr', child.stderr]] as const) {
    stream.on('data', (chunk: Buffer) => {
      const key = `${tenant.tenant}:${channel}`;
      fixture.prompts[key] = ((fixture.prompts[key] ?? '') + chunk.toString('utf8')).slice(-64 * 1024);
    });
  }
  fixture.adapters.push(child);
  process.stdout.write(`File E2E adapter: tenant=${tenant.tenant} pid=${String(child.pid)} cwd=${process.cwd()} workspace=${workspace}\n`);
  return { capture, workspace };
}

export function fileSha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
