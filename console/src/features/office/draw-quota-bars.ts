import type { AgentQuotaBar } from './agent-quota-bar';
import type { ScreenRect } from './people';

export const QUOTA_BAR_WIDTH = 24;
export const QUOTA_BAR_HEIGHT = 5;

/** A thin health bar over the head, without text: the numbers live in the tooltip and the team panel. */
export function drawQuotaBar(ctx: CanvasRenderingContext2D, quota: AgentQuotaBar, x: number, top: number, dpr: number): ScreenRect {
  const width = QUOTA_BAR_WIDTH * dpr;
  const height = QUOTA_BAR_HEIGHT * dpr;
  const left = Math.round(x - width / 2);
  const y = Math.round(top - height);
  const inner = width - 2 * dpr;
  ctx.save();
  ctx.fillStyle = '#0e0f17';
  ctx.fillRect(left, y, width, height);
  ctx.fillStyle = '#333c57';
  ctx.fillRect(left + dpr, y + dpr, inner, height - 2 * dpr);
  if (quota.remaining === null) {
    ctx.fillStyle = '#566c86';
    for (let dash = 0; dash < inner; dash += 6 * dpr) ctx.fillRect(left + dpr + dash, y + dpr, Math.min(3 * dpr, inner - dash), height - 2 * dpr);
  } else {
    ctx.fillStyle = quota.color;
    ctx.fillRect(left + dpr, y + dpr, Math.max(quota.remaining > 0 ? dpr : 0, Math.round(inner * quota.remaining / 100)), height - 2 * dpr);
  }
  ctx.restore();
  return { left, top: y, right: left + width, bottom: y + height };
}
