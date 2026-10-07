import type { Ctx } from './paint';
import { OFFICE } from './palette';

/** What floats over a character's head: «…» while a message is in flight, then the reply. */
export type Speech = { kind: 'thinking' } | { kind: 'say'; text: string };

const FONT = '"Inter Variable", Inter, system-ui, sans-serif';

/** Splits `text` into at most `lines` lines no wider than `max`, ending in «…» when cut. */
export function wrapSpeech(text: string, max: number, lines: number, measure: (value: string) => number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const out: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (measure(next) <= max || !current) {
      current = next;
      continue;
    }
    out.push(current);
    current = word;
    if (out.length === lines) break;
  }
  if (out.length < lines && current) out.push(current);
  const cut = out.length === lines && out.join(' ').length < words.join(' ').length;
  const last = out.length - 1;
  if (last >= 0 && (cut || measure(out[last]) > max)) {
    let tail = out[last];
    while (tail.length > 1 && measure(`${tail}…`) > max) tail = tail.slice(0, -1);
    out[last] = `${tail.trimEnd()}…`;
  }
  return out;
}

function bubbleBox(ctx: Ctx, left: number, top: number, w: number, h: number, unit: number, tailX: number): void {
  ctx.fillStyle = OFFICE.outline;
  ctx.beginPath();
  ctx.roundRect(left - unit, top - unit, w + unit * 2, h + unit * 2, unit * 4);
  ctx.moveTo(tailX - unit * 4, top + h);
  ctx.lineTo(tailX, top + h + unit * 6);
  ctx.lineTo(tailX + unit * 4, top + h);
  ctx.fill();
  ctx.fillStyle = OFFICE.bubble;
  ctx.beginPath();
  ctx.roundRect(left, top, w, h, unit * 3);
  ctx.moveTo(tailX - unit * 3, top + h - unit);
  ctx.lineTo(tailX, top + h + unit * 4);
  ctx.lineTo(tailX + unit * 3, top + h - unit);
  ctx.fill();
}

/** Draws in device px with its tail pointing at `anchor`, kept inside `width`. */
export function drawSpeech(
  ctx: Ctx, speech: Speech, anchor: { x: number; y: number }, fontPx: number, dpr: number, time: number, width: number,
): void {
  const unit = Math.max(1, Math.round(dpr));
  ctx.font = `500 ${String(fontPx)}px ${FONT}`;
  const pad = Math.round(fontPx * 0.55);
  const lineH = Math.round(fontPx * 1.3);
  const lines = speech.kind === 'say' ? wrapSpeech(speech.text, 210 * dpr, 2, (value) => ctx.measureText(value).width) : [];
  const w = speech.kind === 'say' ? Math.ceil(Math.max(...lines.map((line) => ctx.measureText(line).width), fontPx)) + pad * 2 : Math.round(fontPx * 2.8);
  const h = speech.kind === 'say' ? lines.length * lineH + pad : Math.round(fontPx * 1.5);
  const left = Math.round(Math.min(width - w - 4 * unit, Math.max(4 * unit, anchor.x - w / 2)));
  const top = Math.round(anchor.y - h - 7 * unit);
  bubbleBox(ctx, left, top, w, h, unit, Math.round(Math.min(left + w - 6 * unit, Math.max(left + 6 * unit, anchor.x))));
  if (speech.kind === 'thinking') {
    const r = Math.max(1.5 * unit, fontPx * 0.15);
    for (let i = 0; i < 3; i += 1) {
      const lift = Math.floor(time * 3) % 3 === i ? r : 0;
      ctx.fillStyle = OFFICE.outline;
      ctx.beginPath();
      ctx.arc(left + w / 2 + (i - 1) * r * 3.2, top + h / 2 - lift, r, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  ctx.fillStyle = OFFICE.outline;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  lines.forEach((line, index) => { ctx.fillText(line, left + pad, top + pad / 2 + lineH * (index + 0.5)); });
}
