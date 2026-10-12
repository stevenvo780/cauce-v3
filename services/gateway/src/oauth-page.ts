import { randomBytes } from 'node:crypto';
import type { FastifyReply } from 'fastify';

const styles = `
:root{color-scheme:light;--ink:#142033;--muted:#57677c;--line:#d5deea;--accent:#07735c}
*{box-sizing:border-box}body{margin:0;background:#f3f6fa;color:var(--ink);font:16px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.shell{width:min(100% - 48px,1020px);margin:64px auto;display:grid;grid-template-columns:250px minmax(0,1fr);gap:40px;align-items:start}
.brand{display:flex;align-items:center;gap:12px;font-size:25px;font-weight:750;letter-spacing:-.7px}.mark{color:var(--accent);font-size:34px;line-height:1}
.eyebrow{font-size:12px;letter-spacing:.13em;text-transform:uppercase;font-weight:700;color:var(--accent);margin:28px 0 10px}
.rail p{color:var(--muted)}.rail ul{padding:0;list-style:none;margin-top:32px}.rail li{padding:16px 0;border-top:1px solid var(--line);font-size:14px}.rail li strong{display:block;color:var(--ink)}
main{min-width:0;background:#fff;border:1px solid var(--line);border-radius:20px;padding:36px;box-shadow:0 12px 40px #14203308}
h1{font-size:30px;line-height:1.2;letter-spacing:-.8px;margin:0 0 18px}p{margin:16px 0}h2{font-size:18px;margin:28px 0 12px}
a{color:var(--accent);text-underline-offset:4px}code{font:13px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}
dl{background:#f3f6fa;border:1px solid var(--line);border-radius:12px;padding:18px;margin:20px 0}dt{color:var(--muted);font-size:12px;margin-top:12px}dt:first-child{margin-top:0}dd{margin:3px 0 0;overflow-wrap:anywhere}
label{display:block;font-weight:600;margin:18px 0}input:not([type=hidden]):not([type=checkbox]){display:block;width:100%;margin-top:8px;border:1px solid #a6b5c7;border-radius:8px;padding:12px;font:inherit;background:#fff;color:var(--ink)}
.choice{display:flex;gap:12px;align-items:flex-start;padding:16px;border:1px solid var(--line);border-radius:12px;font-weight:500;cursor:pointer}.choice:has(input:checked){border-color:var(--accent);background:#edf8f4}.choice span{min-width:0}.choice strong,.choice small{display:block}.choice small{font-size:13px;color:var(--muted);margin-top:4px}
input[type=checkbox]{accent-color:var(--accent);width:20px;height:20px;flex-shrink:0;margin:3px 0 0}
button,.button{display:inline-flex;justify-content:center;align-items:center;background:var(--accent);color:white;border:1px solid var(--accent);border-radius:9px;min-height:46px;padding:12px 18px;font:600 14px/1.35 system-ui;text-decoration:none;cursor:pointer}
button:hover,.button:hover{background:#055944}button:disabled{opacity:.65;cursor:wait}.secondary{color:var(--ink);background:white;border-color:var(--line)}.secondary:hover{background:#f3f6fa}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:24px}a:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid #1668b2;outline-offset:3px}
.note{border-left:3px solid var(--accent);padding:2px 0 2px 14px;font-size:14px;color:var(--muted)}.footer{font-size:13px;color:var(--muted);padding-top:20px;margin-top:28px;border-top:1px solid var(--line)}
#result:not(:empty){border:1px solid #c7a671;background:#fff8eb;padding:12px;border-radius:8px;font-size:14px}main ul{list-style:none;padding:0}main li{padding:18px 0;border-top:1px solid var(--line);overflow-wrap:anywhere}
@media(max-width:760px){.shell{width:min(100% - 32px,600px);margin:24px auto;grid-template-columns:minmax(0,1fr);gap:20px}.rail .eyebrow,.rail p,.rail ul{display:none}main{padding:24px;border-radius:14px}h1{font-size:26px}.actions{flex-direction:column}.actions>*{width:100%}}
`;

export function oauthLifetime(seconds: number): string {
  const unit = seconds % 86_400 === 0 ? 'días' : seconds % 3600 === 0 ? 'horas' : seconds % 60 === 0 ? 'minutos' : 'segundos';
  const divisor = unit === 'días' ? 86_400 : unit === 'horas' ? 3600 : unit === 'minutos' ? 60 : 1;
  return `${new Intl.NumberFormat('es').format(seconds / divisor)} ${unit}`;
}

export function oauthPage(reply: FastifyReply, body: string, script = '') {
  const nonce = randomBytes(24).toString('base64url');
  reply.header('Content-Security-Policy', `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
  return reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Autorizar Cauce</title><style nonce="${nonce}">${styles}</style></head><body><div class="shell"><aside class="rail"><div class="brand"><span class="mark" aria-hidden="true">≋</span>Cauce</div><div class="eyebrow">Conexión MCP</div><p>Conecta tus agentes.<br>Conserva el control del acceso.</p><ul><li><strong>Tu cuenta</strong>La conexión actúa con tu identidad.</li><li><strong>Tú eliges</strong>Sólo los permisos que autorices.</li><li><strong>Tú revocas</strong>Puedes retirar el acceso cuando quieras.</li></ul></aside><main>${body}<div class="footer">Cauce · Acceso sujeto a tu cuenta y a los permisos de tu organización.</div></main></div>${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`);
}
