import type { RequestFn } from './system-client';

export interface HostEnrollment {
  enrollment_id: string; company_id: string; host_id: string; display_name: string;
  state: 'pending' | 'enrolled' | 'revoked'; expires_at: string; enrolled_at: string | null;
}
export interface HostInvitation {
  enrollment_id: string; company_id: string; host_id: string; nonce: string;
  invitation_token: string; expires_at: string; state: 'pending';
}
export interface HostEnrollmentClient {
  getHostEnrollments(): Promise<{ enrollments: HostEnrollment[] }>;
  inviteHost(input: { host_id: string; display_name: string; notes?: string }): Promise<HostInvitation>;
  revokeHostInvitation(id: string): Promise<{ enrollment_id: string; state: 'revoked' }>;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('No se confirmó la invitación del ordenador. Relee el estado.');
  return value as Record<string, unknown>;
}
function identifier(value: unknown): boolean { return typeof value === 'string' && value.length > 0; }
function date(value: unknown): boolean { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function validIdentity(row: Record<string, unknown>): boolean {
  return [row.enrollment_id, row.company_id, row.host_id].every(identifier) && date(row.expires_at);
}
export function hostEnrollmentClient(request: RequestFn): HostEnrollmentClient {
  const path = '/v3/console/fleet/hosts/enrollments';
  return {
    getHostEnrollments: async () => {
      const value = await request<unknown>(path, { cache: 'no-store' }); const row = object(value);
      if (!Array.isArray(row.enrollments)) throw new Error('No se pudo verificar el listado de invitaciones.');
      for (const item of row.enrollments as unknown[]) {
        const enrollment = object(item);
        if (!validIdentity(enrollment) || !identifier(enrollment.display_name)
          || !['pending', 'enrolled', 'revoked'].includes(String(enrollment.state))
          || (enrollment.enrolled_at !== null && !date(enrollment.enrolled_at))) throw new Error('No se pudo verificar el estado de la invitación.');
      }
      return value as { enrollments: HostEnrollment[] };
    },
    inviteHost: async input => {
      const value = await request<unknown>(path, { method: 'POST', body: JSON.stringify(input) }); const row = object(value);
      if (!validIdentity(row) || row.host_id !== input.host_id || row.state !== 'pending'
        || ![row.nonce, row.invitation_token].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value))) {
        throw new Error('No se confirmó la invitación del ordenador. Relee el estado antes de crear otra.');
      }
      return value as HostInvitation;
    },
    revokeHostInvitation: async id => {
      const value = await request<unknown>(`${path}/${encodeURIComponent(id)}`, { method: 'DELETE' }); const row = object(value);
      if (row.enrollment_id !== id || row.state !== 'revoked') throw new Error('No se confirmó la cancelación. Relee el estado.');
      return value as { enrollment_id: string; state: 'revoked' };
    },
  };
}
