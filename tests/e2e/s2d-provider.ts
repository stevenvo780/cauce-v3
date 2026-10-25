export const NEUTRAL_HISTORY = 'Owned completed task.';
export const IDLE_PLACEHOLDER = 'Ask owned provider...';

export const controlledSharedProvider = String.raw`#!/usr/bin/env node
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const child=require('node:child_process');
const harness=path.basename(process.argv[1]);
if(process.argv.includes('--version')){console.log(harness==='codex'?'codex-cli 0.144.6':'2.1.0 controlled-lab');process.exit(0);}
const home=process.env.HOME;const config=process.env[harness==='codex'?'CODEX_HOME':'CLAUDE_CONFIG_DIR'];
if(!config||!process.stdin.isTTY)throw new Error('owned provider requires its canonical interactive profile');
fs.mkdirSync(config,{recursive:true,mode:0o700});
const native=crypto.randomUUID();const transcriptRoot=harness==='codex'?path.join(config,'sessions'):path.join(config,'projects',process.cwd().replace(/\//g,'-'));
fs.mkdirSync(transcriptRoot,{recursive:true,mode:0o700});
const transcript=path.join(transcriptRoot,harness==='codex'?'rollout-owned-'+native+'.jsonl':native+'.jsonl');
function append(value){fs.appendFileSync(transcript,JSON.stringify(value)+'\n',{mode:0o600});}
if(harness==='codex')append({type:'session_meta',payload:{id:native,source:'cli'}});
let pending='',draft='',inputBytes=0,submits=0,cursorAtStart=false,cursorLine=0,cursorColumn=0;
const status=()=>fs.writeFileSync(path.join(config,'s2d-provider-state.json'),JSON.stringify({inputBytes,submits,draftLength:draft.length,pid:process.pid}),{mode:0o600});
const render=()=>{
 const composed=draft.split('\n').map((line,index)=>(index?'  ':'')+line).join('\r\n');
 const content=draft===''?'\x1b[2m'+${JSON.stringify(IDLE_PLACEHOLDER)}+'\x1b[22m':'\x1b[38;2;225;225;225m'+composed+'\x1b[0m';
 const cursor=draft===''?'\x1b[3;3H':cursorAtStart?'\x1b['+(3+cursorLine)+';'+(3+cursorColumn)+'H':'';
 process.stdout.write('\x1b[2J\x1b[H'+${JSON.stringify(NEUTRAL_HISTORY)}+'\r\n\r\n'+(harness==='codex'?'› ':'❯ ')+content+cursor);status();
};
function launchJob(){
 const script='import json,os,pathlib,sys,time\nif os.fork():os._exit(0)\nos.setsid()\np=pathlib.Path(sys.argv[1]);s=pathlib.Path("/proc/self/stat").read_text().rsplit(") ",1)[1].split()\np.write_text(json.dumps({"pid":os.getpid(),"ticks":s[19]}));p.chmod(0o600)\ntime.sleep(900)';
 child.spawn('python3',['-I','-B','-c',script,path.join(home,'s2d-job.json')],{stdio:'ignore',env:{HOME:home,PATH:'/usr/local/bin:/usr/bin:/bin'}}).unref();
}
function submit(){
 if(!draft)return;const text=draft;draft='';cursorAtStart=false;submits+=1;
 if(text==='S2D_LAUNCH_OWNED_FOREIGN_JOB'){launchJob();render();return;}
 const nonce=/(?:CAUCE_LIVE_[a-f0-9]{32}|CAUCE_BOOTSTRAP_[a-f0-9]{64})/.exec(text)?.[0];
 const correlation=/"cauce_correlation_id"\s*:\s*"([a-f0-9]{64})"/.exec(text)?.[1];
 const answer=nonce?.startsWith('CAUCE_BOOTSTRAP_')?nonce:JSON.stringify({reply:nonce||'S2D_OWNED_DONE',messages:[],status:'done',retryable:false,artifacts:[],cauce_correlation_id:correlation});
 const turn=crypto.randomUUID();
 if(harness==='codex'){
  append({type:'event_msg',payload:{type:'task_started',turn_id:turn}});
  append({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}],internal_chat_message_metadata_passthrough:{turn_id:turn}}});
  append({type:'event_msg',payload:{type:'task_complete',turn_id:turn,last_agent_message:answer}});
 }else{
  append({type:'user',uuid:turn,parentUuid:null,isSidechain:false,promptSource:'typed',sessionId:native,message:{role:'user',content:text}});
  append({type:'assistant',uuid:crypto.randomUUID(),parentUuid:turn,isSidechain:false,sessionId:native,message:{role:'assistant',stop_reason:'end_turn',content:[{type:'text',text:answer}]}});
 }
 render();
}
process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');process.stdin.resume();process.stdout.write('\x1b[?2004h');render();
process.stdin.on('data',chunk=>{
 inputBytes+=Buffer.byteLength(chunk);pending+=chunk;
 while(pending.length){
  if(pending.startsWith('\x1b[200~')){
   const end=pending.indexOf('\x1b[201~');if(end<0){status();return;}
   draft+=pending.slice(6,end).replace(/\r\n?/g,'\n');cursorAtStart=false;pending=pending.slice(end+6);render();continue;
  }
  const arrow=/^\x1b\[([ABCD])/.exec(pending);
  if(arrow&&cursorAtStart){
   const lines=draft.split('\n');pending=pending.slice(3);
   if(arrow[1]==='A')cursorLine=Math.max(0,cursorLine-1);
   if(arrow[1]==='B')cursorLine=Math.min(lines.length-1,cursorLine+1);
   if(arrow[1]==='C')cursorColumn+=1;
   if(arrow[1]==='D')cursorColumn=Math.max(0,cursorColumn-1);
   cursorColumn=Math.min(cursorColumn,lines[cursorLine].length);render();continue;
  }
  if(pending.startsWith('\x1b')&&pending.length<6){status();return;}
  const c=pending[0];pending=pending.slice(1);
  if(c==='\x01'){cursorAtStart=true;cursorLine=0;cursorColumn=0;render();continue;}
  cursorAtStart=false;
  if(c==='\r'||c==='\n')submit();else if(c==='\x7f')draft=draft.slice(0,-1);else if(c==='\x15')draft='';else if(c>=' ')draft+=c;
  render();
 }
 status();
});
`;
