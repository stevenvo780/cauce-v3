import { NativeAdminOutcomeSchema, type NativeAdminCommand, type NativeAdminOutcome } from '@cauce/protocol';

export async function nativeAdminHttp(
  send: (route: string, body: Readonly<Record<string, unknown>>, signal?: AbortSignal) => Promise<{ status: number; body: string; overflowed: boolean }>,
  tenantId: string, alias: string, command: NativeAdminCommand, signal?: AbortSignal,
): Promise<NativeAdminOutcome> {
  try {
    const result = await send('/v3/terminal/relay/native-admin', { tenant_id: tenantId, alias, command }, signal);
    if (result.overflowed || result.status < 200 || result.status >= 500) return { type: 'error', error: 'unavailable' };
    const value = NativeAdminOutcomeSchema.safeParse(JSON.parse(result.body));
    return value.success ? value.data : { type: 'error', error: 'unavailable' };
  } catch { return { type: 'error', error: 'unavailable' }; }
}
