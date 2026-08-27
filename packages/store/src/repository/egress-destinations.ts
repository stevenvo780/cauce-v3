export interface EgressDestinationRow {
  adapter: string;
  channel: string;
  conversation_id: string;
  conversation_kind: 'dm' | 'group';
  display_label: string | null;
  allow_kinds: string[];
  require_prior_contact: boolean;
  contact_ttl_days: number;
  min_interval_seconds: number;
  max_per_hour: number;
  max_per_day: number;
  max_per_root: number;
  quiet_hours_start: number | null;
  quiet_hours_end: number | null;
  quiet_hours_tz: string;
  enabled: boolean;
}

export const egressDestinationColumns = `adapter,channel,conversation_id,conversation_kind,display_label,allow_kinds,
  require_prior_contact,contact_ttl_days,min_interval_seconds,max_per_hour,max_per_day,max_per_root,
  quiet_hours_start,quiet_hours_end,quiet_hours_tz,enabled`;
