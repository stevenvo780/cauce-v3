import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { SPACE_BACKUP_HOST_BODY_BYTES,SPACE_BACKUP_MAX_BYTES } from '@cauce/store';
import { LoginPathSchema } from './provider-login.js';
import { BoundedTail } from './host-stderr.js';
import { backupFailure, backupHelperFailure, SpaceBackupHelperError } from './space-backup.failure.js';
export interface SpaceBackupHostConfig {python:string;policyFile:string;projectRoot:string;timeoutMs?:number}
function backupEnvironment():NodeJS.ProcessEnv {
  const environment:NodeJS.ProcessEnv={PATH:'/usr/bin:/bin',HOME:process.env.HOME??'',PYTHONDONTWRITEBYTECODE:'1'};
  for(const key of ['DOCKER_CONTEXT','DOCKER_HOST','DOCKER_CONFIG'] as const) {
    const value=process.env[key];if(value) environment[key]=value;
  }
  return environment;
}
export function invokeSpaceBackupHelper(config:SpaceBackupHostConfig,body:Record<string,unknown>,signal:AbortSignal):Promise<unknown> {
  const python=LoginPathSchema.parse(config.python);const policy=LoginPathSchema.parse(config.policyFile);
  const executable=join(LoginPathSchema.parse(config.projectRoot),'ops/cli/space_backup_runtime.py');
  const timeout=config.timeoutMs??1_800_000;
  return invokeSpaceBackupProcess(python,[executable,'--policy',policy],body,signal,timeout);
}
export function invokeSpaceBackupProcess(python:string,args:string[],body:Record<string,unknown>,signal:AbortSignal,timeout=1_800_000):Promise<unknown> {
  LoginPathSchema.parse(python);
  if (signal.aborted||!Number.isSafeInteger(timeout)||timeout<1||timeout>3_600_000) return Promise.reject(new Error('Space backup helper is unavailable'));
  return new Promise((resolve,reject)=>{
    const child=spawn(python,args,{detached:true,stdio:['pipe','pipe','pipe'],
      env:backupEnvironment()});
    const chunks:Buffer[]=[];let length=0;let invalid=false;const stderr=new BoundedTail();
    const stop=()=>{invalid=true;if (child.pid!==undefined) {try {process.kill(-child.pid,'SIGKILL');} catch {child.kill('SIGKILL');}}};
    const timer=setTimeout(stop,timeout);signal.addEventListener('abort',stop,{once:true});child.stderr.on('data',(bytes:Buffer)=>{stderr.push(bytes);});
    const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',stop);};
    child.stdout.on('data',(bytes:Buffer)=>{length+=bytes.length;if(length>SPACE_BACKUP_HOST_BODY_BYTES) stop();else chunks.push(bytes);});
    child.once('error',error=>{finish();reject(new SpaceBackupHelperError({...backupFailure(error),stage:'runtime'}));});child.stdin.once('error',stop);
    child.once('close',code=>{finish();if(invalid||code!==0) {reject(new SpaceBackupHelperError(!invalid ? backupHelperFailure(stderr.text())??{
      type:'Error',message:'Space backup helper exited without a verified diagnostic',stage:'runtime'}:{
      type:'Error',message:signal.aborted?'Space backup lease stopped':'Space backup helper exceeded its time or output limit',stage:'runtime'}));return;}
      try {resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);} catch {reject(new Error('Space backup helper receipt is unavailable'));}});
    if (signal.aborted) stop();child.stdin.end(JSON.stringify(body));
  });
}

export async function streamSpaceBackupHelper(config:SpaceBackupHostConfig,body:Record<string,unknown>,bytes:number,
  signal:AbortSignal,consume:(chunk:unknown)=>Promise<number>):Promise<void> {
  const python=LoginPathSchema.parse(config.python);const policy=LoginPathSchema.parse(config.policyFile);
  const executable=join(LoginPathSchema.parse(config.projectRoot),'ops/cli/space_backup_local.py');
  const timeout=config.timeoutMs??1_800_000;
  if(signal.aborted||!Number.isSafeInteger(timeout)||timeout<1||timeout>3_600_000||!Number.isSafeInteger(bytes)||bytes<1||bytes>SPACE_BACKUP_MAX_BYTES
    ||typeof body.offset!=='number'||!Number.isSafeInteger(body.offset)||body.offset<0||body.offset>bytes) throw new Error('Space backup stream is unavailable');
  const child=spawn(python,[executable,'--host-stream','--policy',policy],{detached:true,stdio:['pipe','pipe','pipe'],
    env:backupEnvironment()});
  const stderr=new BoundedTail();let stopped=false;let ended=false;let spawnError:Error|undefined;
  const interrupted=()=>stopped||signal.aborted;
  const spawnFailed=()=>spawnError!==undefined;
  let terminate:ReturnType<typeof setTimeout>|undefined;let kill:ReturnType<typeof setTimeout>|undefined;
  const signalGroup=(value:NodeJS.Signals)=>{if(child.pid!==undefined) {try {process.kill(-child.pid,value);} catch {child.kill(value);}}};
  const stop=()=>{
    if(stopped) return;stopped=true;
    if(!child.stdin.destroyed&&!child.stdin.writableEnded) child.stdin.end('{"cancel":true}\n');
    terminate=setTimeout(()=>{signalGroup('SIGTERM');kill=setTimeout(()=>{signalGroup('SIGKILL');},3_000);},8_000);
  };
  const closed=new Promise<number|null>(resolve=>{child.once('close',resolve);});
  child.once('error',error=>{spawnError=error;});child.stdin.on('error',stop);
  child.stderr.on('data',(chunk:Buffer)=>{stderr.push(chunk);});
  const timer=setTimeout(stop,timeout);signal.addEventListener('abort',stop,{once:true});
  let offset=body.offset;let parts:Buffer[]=[];let length=0;let failure:unknown;
  try {
    child.stdin.write(`${JSON.stringify(body)}\n`);if(interrupted()) stop();
    for await(const input of child.stdout) {
      let remaining=input as Buffer;
      while(remaining.length) {
        const newline=remaining.indexOf(10);const piece=newline<0?remaining:remaining.subarray(0,newline);
        length+=piece.length;
        if(length>SPACE_BACKUP_HOST_BODY_BYTES) throw new Error('Space backup stream frame exceeds its limit');
        parts.push(piece);remaining=newline<0?Buffer.alloc(0):remaining.subarray(newline+1);
        if(newline<0) continue;
        if(interrupted()) throw new Error('Space backup lease stopped');
        if(ended||length===0) throw new Error('Space backup stream has an unexpected frame');
        const raw:unknown=JSON.parse(Buffer.concat(parts,length).toString('utf8'));parts=[];length=0;
        if(raw!==null&&typeof raw==='object'&&!Array.isArray(raw)&&'done' in raw) {
          const done=raw as {done:unknown;offset?:unknown};
          if(Object.keys(done).length!==2||done.done!==true||done.offset!==offset||offset!==bytes) throw new Error('Space backup stream completion differs');
          ended=true;child.stdin.end();continue;
        }
        const next=await consume(raw);
        if(interrupted()) throw new Error('Space backup lease stopped');
        if(!Number.isSafeInteger(next)||next<=offset||next>bytes) throw new Error('Space backup stream acknowledgement differs');
        offset=next;child.stdin.write(`${JSON.stringify({offset})}\n`);
      }
    }
    if(length!==0||!ended) throw new Error('Space backup stream ended without a verified receipt');
  } catch(error) {failure=error;stop();}
  finally {
    const code=await closed;clearTimeout(timer);clearTimeout(terminate);clearTimeout(kill);signal.removeEventListener('abort',stop);
    if(failure===undefined&&(interrupted()||code!==0||spawnFailed())) {
      failure=new SpaceBackupHelperError(backupHelperFailure(stderr.text())??{type:'Error',
        message:interrupted()?'Space backup lease stopped':'Space backup stream exited without a verified diagnostic',stage:'runtime'});
    }
  }
  if(failure!==undefined) throw failure instanceof Error?failure:new Error('Space backup stream failed');
}
