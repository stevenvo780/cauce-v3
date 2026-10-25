// uso: QA_EMAIL=... node scen.mjs <d|m> <restart|pause> <abajo_ms>
import {open} from './lib.mjs';
import {execSync} from 'child_process';
import fs from 'fs';
const [,, kind='d', mode='restart', downArg='6000']=process.argv;
const mobile=kind==='m', tag=`${kind}-${mode}-${downArg}`;
const D='/datos/workspaces/personal/cauce-v3/.delegados/v4/recibos/qa0-entorno-exploracion-1025/q10b/';
const runner='zz-canary-qa-q10b-runner';
const dk=a=>execSync(`docker --context lab ${a} ${runner}`,{stdio:'pipe'});
const {b,c,p:A}=await open(mobile);
const href=await A.locator('a[href*="/messages/hub-"]').first().getAttribute('href');
const chat=new URL(href,A.url()).toString();
const B=await c.newPage(); await B.goto(chat); await A.goto(chat); await A.waitForTimeout(3000);
const state=async()=> (await A.getByText('Reconectando con el servidor').count())?'R':(await A.getByText('No hay conexión con el servidor').count())?'U':'.';
// línea base 10 s
let base=''; for(let i=0;i<20;i++){ base+=await state(); await A.waitForTimeout(500); }
fs.writeFileSync(D+'private/gateway-restart-down-ms',String(downArg));
const t0=Date.now(); const tl=[]; let firstAlert=-1, last='.';
if(mode==='restart') dk('kill -s USR2'); else dk('pause');
const downFor = mode==='restart'? Number(downArg)+3000 : Number(downArg);
let resumed=false, backAt=0;
while(Date.now()-t0<downFor+4000){
  if(mode==='pause' && !resumed && Date.now()-t0>=downFor){ dk('unpause'); resumed=true; backAt=Date.now(); }
  const s=await state(); tl.push(s); if(s!=='.'&&firstAlert<0) firstAlert=Date.now()-t0;
  await A.waitForTimeout(250);
}
await A.screenshot({path:`${tag}-durante.png`});
// esperar a que el gateway responda y la banda desaparezca
const t1=Date.now(); let gone=-1; while(Date.now()-t1<60000){ if(await state()==='.'){gone=Date.now()-t1;break;} await A.waitForTimeout(250); }
const m=`zz-canary-q10b-${tag}-${Date.now()%100000}`;
await B.reload(); await B.waitForTimeout(1500);
await B.fill('textarea',m); await B.keyboard.press('Enter');
const t2=Date.now(); let ap=-1; while(Date.now()-t2<30000){ if(await A.getByText(m).count()){ap=Date.now()-t2;break;} await A.waitForTimeout(250);}
await A.screenshot({path:`${tag}-despues.png`});
const diag=await A.evaluate(()=>window.cauceDiagnosticoConexion?.().map(e=>e.event+':'+(e.detail??'')).join(' | ')).catch(()=>'n/d');
console.log(JSON.stringify({tag,base,firstAlertMs:firstAlert,timeline:tl.join('').replace(/(.)\1{7,}/g,(m0,ch)=>`${ch}x${m0.length}`),bandGoneMsAfterWindow:gone,msgAppearsMs:ap,finalState:await state(),diag},null,0));
await b.close();
