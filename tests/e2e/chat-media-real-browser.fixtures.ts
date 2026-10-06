import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRfcUuid, objectRecord } from '@cauce/protocol';
import { functionalTenants, type FunctionalTenant, type startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import type { FileAdapter, CapturedFile } from './chat-file-send-real-browser.fixtures.js';

import type { BrowserPage } from './console-functional-browser.fixtures.js';
type Fixture = Awaited<ReturnType<typeof startConsoleFunctionalFixture>>;
export interface MediaReplyAdapter extends FileAdapter { replyCapture: string }


export interface MediaFile { name: string; mimeType: string; buffer: Buffer }

export function waveFile(name: string): MediaFile {
  const samples = 4_000;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8_000, 24); bytes.writeUInt32LE(16_000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index += 1) {
    bytes.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 440 / 8_000) * 2_000), 44 + index * 2);
  }
  return { name, mimeType: 'audio/wav', buffer: bytes };
}

export async function generatedMedia(page: BrowserPage, prefix: string): Promise<MediaFile[]> {
  const encoded = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 32; canvas.height = 32;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Owned media canvas unavailable');
    context.fillStyle = '#228855'; context.fillRect(0, 0, 32, 32);
    const png = canvas.toDataURL('image/png').split(',')[1];
    const mime = 'video/webm;codecs=vp8';
    if (!MediaRecorder.isTypeSupported(mime)) throw new Error('Chromium VP8 recording unavailable');
    const stream = canvas.captureStream(10);
    try {
      const video = await new Promise<Blob>((resolve, reject) => {
        const chunks: Blob[] = [];
        const recorder = new MediaRecorder(stream, { mimeType: mime });
        recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
        recorder.onerror = () => { reject(new Error('Owned canvas recording failed')); };
        recorder.onstop = () => { resolve(new Blob(chunks, { type: 'video/webm' })); };
        recorder.start();
        window.setTimeout(() => { context.fillStyle = '#885522'; context.fillRect(0, 0, 32, 32); }, 100);
        window.setTimeout(() => { recorder.stop(); }, 500);
      });
      const data = new Uint8Array(await video.arrayBuffer());
      if (!png || data.length === 0) throw new Error('Generated media is empty');
      return { png, video: btoa(String.fromCharCode(...data)) };
    } finally { stream.getTracks().forEach((track) => { track.stop(); }); }
  });
  return [
    { name: `${prefix}.png`, mimeType: 'image/png', buffer: Buffer.from(encoded.png, 'base64') },
    waveFile(`${prefix}.wav`),
    { name: `${prefix}.webm`, mimeType: 'video/webm', buffer: Buffer.from(encoded.video, 'base64') },
  ];
}

export function passiveDocuments(prefix: string): MediaFile[] {
  return [
    { name: `${prefix}.svg`, mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8"/></svg>') },
    { name: `${prefix}.html`, mimeType: 'text/html', buffer: Buffer.from('<!doctype html><title>Owned passive fixture</title><p>download only</p>') },
  ];
}

export async function startMediaReplyAdapter(fixture: Fixture, tenant: FunctionalTenant): Promise<MediaReplyAdapter> {
  const tls = fixture.pki.adapterCerts[functionalTenants.indexOf(tenant)];
  if (!tls) throw new Error('Missing owned adapter certificate');
  const stem = tenant.tenant.toLowerCase();
  const home = join(fixture.directory, `fh-${stem}`);
  const codexHome = join(fixture.directory, `fc-${stem}`);
  const workspace = join(fixture.directory, `files-${stem}`);
  const capture = join(fixture.directory, `file-turns-${stem}.jsonl`);
  const replyCapture = join(fixture.directory, `reply-files-${stem}.jsonl`);
  const harness = join(fixture.directory, `file-codex-${stem}.mjs`);
  await Promise.all([home, codexHome, workspace].map((directory) => mkdir(directory, { mode: 0o700 })));
  const script = `#!/usr/bin/env node
import { randomUUID, createHash } from 'node:crypto';
import { appendFile, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
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
const replies=[];const artifacts=[];
for(const file of files){
 if(!/^(image\\/(png|jpeg|webp)|audio\\/|video\\/)/u.test(file.mime_type))continue;
 const name='agent-reply-'+file.name;
 if(name.includes('/')||name.includes(String.fromCharCode(92)))throw new Error('Unsafe own reply name');
 const path=join(root,name);const bytes=Buffer.from(file.bytes_base64,'base64');
 await writeFile(path,bytes,{mode:0o600,flag:'wx'});
 const info=await stat(path);const digest=createHash('sha256').update(await readFile(path)).digest('hex');
 if((info.mode&0o777)!==0o600||digest!==file.sha256)throw new Error('Own reply file identity changed');
 replies.push({...file,name,local_path:path,sha256:digest,mode:info.mode&0o777});
 artifacts.push({name,uri:pathToFileURL(path).href,media_type:file.mime_type,sha256:digest});
}
await appendFile(${JSON.stringify(replyCapture)},JSON.stringify({native_session_id:sid,provider_reply:artifacts.length?null:'archivo recibido por harness sintético',files:replies})+'\\n',{mode:0o600});
const result={reply:artifacts.length?null:'archivo recibido por harness sintético',messages:[],notify:[],status:'done',retryable:false,artifacts};
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
  return { capture, workspace, replyCapture };
}


export async function readReplyFiles(adapter: MediaReplyAdapter): Promise<CapturedFile[]> {
  const lines = (await readFile(adapter.replyCapture, 'utf8')).trim().split('\n');
  return lines.flatMap((line) => {
    const turn = objectRecord(JSON.parse(line) as unknown);
    if (!turn || !isRfcUuid(turn.native_session_id) || turn.provider_reply !== null || !Array.isArray(turn.files)) throw new Error('Invalid file-only provider capture');
    return turn.files.map((entry: unknown) => {
      const file = objectRecord(entry);
      if (!file || typeof file.name !== 'string' || typeof file.mime_type !== 'string' || typeof file.file_size !== 'number' || typeof file.sha256 !== 'string' || typeof file.local_path !== 'string' || typeof file.bytes_base64 !== 'string' || typeof file.mode !== 'number') throw new Error('Invalid own reply capture');
      return { name: file.name, mime_type: file.mime_type, file_size: file.file_size, sha256: file.sha256, local_path: file.local_path, bytes_base64: file.bytes_base64, mode: file.mode };
    });
  });
}
