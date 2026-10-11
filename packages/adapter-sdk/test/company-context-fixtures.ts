import type { CompanyContext } from "@cauce/protocol";

/** What the gateway sends for a recipient of the first company: separate infrastructure and coordination agents. */
const HUMANIZAR_FACTS = {
  company_id: "humanizar",
  infra_escalation: { tenant_id: "Steven", alias: "zeus" },
  coordination: { tenant_id: "Steven", alias: "kant" },
  gate_probe: {
    tenant_id: "Steven", room_id: "grp.steven", actor_alias: "kant", principal_alias: "gate-probe",
  },
} as const satisfies CompanyContext;

export const HUMANIZAR_MEMBER: CompanyContext = HUMANIZAR_FACTS;
export const HUMANIZAR_DIRECTOR: CompanyContext = { ...HUMANIZAR_FACTS, director: true };

const PRAXIS_LEADER_ID = { tenant_id: "Hospital", alias: "operador" } as const;
const PRAXIS_NOTICE = {
  tenant_id: "Hospital", room_id: "grp.hospital", actor_alias: "praxis-supervisor",
  principal_alias: "praxis-supervisor", recipient_alias: "operador", notify_handle: "owner_dm",
} as const;

/** A company led by one agent: it is director, receipt agent and both escalation targets. */
export const PRAXIS_LEADER: CompanyContext = {
  company_id: "praxis", director: true, human_receipt: true,
  infra_escalation: PRAXIS_LEADER_ID, coordination: PRAXIS_LEADER_ID, supervision_notice: PRAXIS_NOTICE,
};
export const PRAXIS_MEMBER: CompanyContext = {
  company_id: "praxis", infra_escalation: PRAXIS_LEADER_ID, coordination: PRAXIS_LEADER_ID,
  supervision_notice: PRAXIS_NOTICE,
};
