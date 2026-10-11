import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { LoginPathSchema } from './provider-login.js';
export interface SpaceBackupHostConfig {python:string;policyFile:string;projectRoot:string;timeoutMs?:number}
export function invokeSpaceBackupHelper(config:SpaceBackupHostConfig,body:Record<string,unknown>,signal:AbortSignal):Promise<unknown> {
  const python=LoginPathSchema.parse(config.python);const policy=LoginPathSchema.parse(config.policyFile);
  const executable=join(LoginPathSchema.parse(config.projectRoot),'ops/cli/space_backup_runtime.py');
  const timeout=config.timeoutMs??180_000;
  if (signal.aborted||!Number.isSafeInteger(timeout)||timeout<1||timeout>300_000) return Promise.reject(new Error('Space backup helper is unavailable'));
  return new Promise((resolve,reject)=>{
    const child=spawn(python,[executable,'--policy',policy],{detached:true,stdio:['pipe','pipe','pipe'],
      env:{PATH:'/usr/bin:/bin',HOME:process.env.HOME??'',PYTHONDONTWRITEBYTECODE:'1'}});
    const chunks:Buffer[]=[];let length=0;let invalid=false;
    const stop=()=>{invalid=true;if (child.pid!==undefined) {try {process.kill(-child.pid,'SIGKILL');} catch {child.kill('SIGKILL');}}};
    const timer=setTimeout(stop,timeout);signal.addEventListener('abort',stop,{once:true});child.stderr.resume();
    const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',stop);};
    child.stdout.on('data',(bytes:Buffer)=>{length+=bytes.length;if(length>131_072) stop();else chunks.push(bytes);});
    child.once('error',()=>{finish();reject(new Error('Space backup helper is unavailable'));});child.stdin.once('error',stop);
    child.once('close',code=>{finish();if(invalid||code!==0) {reject(new Error('Space backup helper is unavailable'));return;}
      try {resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);} catch {reject(new Error('Space backup helper receipt is unavailable'));}});
    if (signal.aborted) stop();child.stdin.end(JSON.stringify(body));
  });
}
