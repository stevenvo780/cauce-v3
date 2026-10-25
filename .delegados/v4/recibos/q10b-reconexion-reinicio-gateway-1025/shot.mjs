import {open} from './lib.mjs';
import {execSync} from 'child_process';
import fs from 'fs';
const D='/datos/workspaces/personal/cauce-v3/.delegados/v4/recibos/qa0-entorno-exploracion-1025/q10b/';
for(const tag of ['d','m']){
  const {b,p}=await open(tag==='m');
  await p.goto(new URL('/config',p.url()).toString()); await p.waitForTimeout(2000);
  fs.writeFileSync(D+'private/gateway-restart-down-ms','20000');
  execSync('docker --context lab kill -s USR2 zz-canary-qa-q10b-runner');
  await p.waitForTimeout(9000); await p.screenshot({path:`${tag}-aviso-reinicio.png`});
  await p.getByText('No hay conexión con el servidor').first().waitFor({state:'detached',timeout:40000});
  await b.close(); }
