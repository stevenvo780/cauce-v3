// QA fixture mirroring the bootstrap seed of packages/store/migrations/001_initial.sql.
// Pablo belongs here: the runner ACL matrix needs these five tenants to reach 25 cells.
export const topology = {
  Steven: { room: 'grp.steven', aliases: ['argos', 'jarvis', 'kant', 'socrates'] },
  Miguel: { room: 'grp.miguel', aliases: ['janus', 'kratos'] },
  Isa: { room: 'grp.isa', aliases: ['salva'] },
  Jhon: { room: 'grp.jhon', aliases: ['hegel'] },
  Pablo: { room: 'grp.pablo', aliases: ['dedalo', 'midas', 'seneca', 'vulcano'] },
};

export const tenantAgents = Object.fromEntries(
  Object.entries(topology).map(([tenant, { aliases }]) => [tenant.toLowerCase(), aliases]),
);
