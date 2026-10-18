import type { AgentQuotaBar } from './agent-quota-bar';
import type { ScreenRect } from './people';

export const QUOTA_BAR_WIDTH = 76;
export const QUOTA_BAR_HEIGHT = 22;

export function drawQuotaBar(ctx: CanvasRenderingContext2D, quota: AgentQuotaBar, x: number, top: number, dpr: number): ScreenRect {
  const width = QUOTA_BAR_WIDTH * dpr;
  const height = QUOTA_BAR_HEIGHT * dpr;
  const left = Math.round(x - width / 2);
  const y = Math.round(top - height);
  ctx.save();
  ctx.fillStyle = '#0e0f17';
  ctx.fillRect(left, y, width, height);
  ctx.fillStyle = quota.color;
  ctx.fillRect(left, y + 16 * dpr, width, 6 * dpr);
  ctx.fillStyle = '#334155';
  ctx.fillRect(left + dpr, y + 17 * dpr, width - 2 * dpr, 4 * dpr);
  ctx.fillStyle = quota.color;
  ctx.fillRect(left + dpr, y + 17 * dpr, (width - 2 * dpr) * (quota.remaining ?? 100) / 100, 4 * dpr);
  ctx.font = `600 ${String(11 * dpr)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#f8fafc';
  ctx.fillText(quota.remaining === null ? '—' : quota.label, Math.round(x), y + 8 * dpr, width - 6 * dpr);
  ctx.restore();
  return { left, top: y, right: left + width, bottom: y + height };
}
