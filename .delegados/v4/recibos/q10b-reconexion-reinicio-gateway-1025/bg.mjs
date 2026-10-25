// uso: node bg.mjs <d|m>  — perfil/recarga/segundo plano; busca bandas pegadas
import {open} from './lib.mjs';
import {execSync} from 'child_process';
import fs from 'fs';
const mobile=process.argv[2]==='m', tag=mobile?'m':'d';
const D='/datos/workspaces/personal/cauce-v3/.delegados/v4/recibos/qa0-entorno-exploracion-1025/q10b/';
const {b,c,p}=await open(mobile);
const band=async()=> (await p.getByText('Reconectando con el servidor').count())+(await p.getByText('No hay conexión con el servidor').count());
const setVis=v=>p.evaluate(v=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>v});Object.defineProperty(document,'hidden',{configurable:true,get:()=>v==='hidden'});document.dispatchEvent(new Event('visibilitychange'));},v);
const out=[];
const watch=async(label,ms)=>{let s='';const t=Date.now();while(Date.now()-t<ms){s+=(await band())?'B':'.';await p.waitForTimeout(500);}out.push(`${label}: ${s}`);};
const base=new URL(p.url()).origin;
for(const route of ['/my-quotas','/config','/messages']){
  await p.goto(base+route); await p.waitForTimeout(1500);
  for(let i=0;i<3;i++){ await p.reload(); await watch(`${route} recarga${i+1}`,4000); }
}
await p.goto(base+'/config'); await p.waitForTimeout(1500);
// segundo plano con el gateway reiniciando mientras está oculto
fs.writeFileSync(D+'private/gateway-restart-down-ms','8000');
await setVis('hidden'); execSync('docker --context lab kill -s USR2 zz-canary-qa-q10b-runner'); await p.waitForTimeout(14000);
await setVis('visible'); await watch('vuelta de segundo plano tras reinicio',20000);
// segundo plano largo sin fallos, vuelta por bfcache
await setVis('hidden'); await p.waitForTimeout(20000); await setVis('visible');
await p.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))); await watch('vuelta sin fallos',10000);
// 90 s de reposo
await watch('reposo 90 s',90000);
await p.screenshot({path:`${tag}-bg-final.png`});
const diag=await p.evaluate(()=>window.cauceDiagnosticoConexion().map(e=>e.event+':'+(e.detail??'')).join(' | '));
console.log(tag,'\n'+out.join('\n'),'\nbandas totales:',out.join('').split('B').length-1,'\n'+diag);
await b.close();
