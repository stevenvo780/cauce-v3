import { chromium } from '/datos/workspaces/personal/cauce-v3/console/node_modules/playwright/index.mjs';
import fs from 'fs';
const R='/datos/workspaces/personal/cauce-v3/.delegados/v4/recibos/qa0-entorno-exploracion-1025/q10b/';
export const url=fs.readFileSync(R+'url','utf8').trim();
export async function open(mobile){
  const b=await chromium.launch();
  const c=await b.newContext({ignoreHTTPSErrors:true,viewport:mobile?{width:390,height:844}:{width:1440,height:900},isMobile:!!mobile,hasTouch:!!mobile});
  const p=await c.newPage();
  await p.goto(url); await p.fill('input[name=email],input[type=email]',process.env.QA_EMAIL);
  await p.fill('input[type=password]',fs.readFileSync(R+'password','utf8').trim());
  await p.click('button[type=submit]'); await p.waitForTimeout(3000);
  return {b,c,p};
}
export const banner=p=>p.getByText('Reconectando con el servidor').count();
