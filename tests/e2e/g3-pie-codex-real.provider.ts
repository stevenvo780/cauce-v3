import assert from 'node:assert/strict';
import { controlledSharedProvider, IDLE_PLACEHOLDER, NEUTRAL_HISTORY } from './s2d-provider.js';

export const CODEX_STATUS_SEGMENTS = ['GPT-6.1-Sol default', '/workspace', 'Owned canary task'] as const;
export const CODEX_STATUS_LINE = CODEX_STATUS_SEGMENTS.join(' · ');
export const CODEX_SHORTCUT_LINE = '? for shortcuts                ⚠ 2 warnings · f2 to view';

const colors = [223, 151, 225];
const footer = '  ' + CODEX_STATUS_SEGMENTS.map((segment, index) => '\x1b[38;5;' + String(colors[index]) + 'm' + segment + '\x1b[0m').join(' · ')
  + '\r\n  \x1b[1m?\x1b[0m for shortcuts                \x1b[38;5;179m⚠ 2 warnings\x1b[0m · \x1b[1mf2\x1b[0m to view';
const anchors = [...controlledSharedProvider.matchAll(/^const render=\(\)=>\{[\s\S]*?^\};$/gmu)];
assert.equal(anchors.length, 1, 'the shared provider must have exactly one render function');
const anchor = anchors[0]?.[0]; assert.ok(anchor);
const renderer = anchor.replace('const render=', 'const g3BaseRender=') + String.raw`
const render=()=>{
 if(harness!=='codex'){g3BaseRender();return;}
 const lines=draft.split('\n'),composed=lines.map((line,index)=>(index?'  ':'')+line).join('\r\n');
 const content=draft===''?'\x1b[2m'+${JSON.stringify(IDLE_PLACEHOLDER)}+'\x1b[22m':composed;
 const row=draft===''?3:cursorAtStart?3+cursorLine:2+lines.length;
 const column=draft===''?3:cursorAtStart?3+cursorColumn:3+lines.at(-1).length;
 process.stdout.write('\x1b[0m\x1b[2J\x1b[H'+${JSON.stringify(NEUTRAL_HISTORY)}+'\r\n\r\n› '+content+'\r\n\r\n'+${JSON.stringify(footer)}+'\x1b['+row+';'+column+'H');status();
};`;

export const codexFooterProvider = controlledSharedProvider.replace(anchor, () => renderer);
