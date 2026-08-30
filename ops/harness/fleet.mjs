export const topology = {
  Steven: { room: 'grp.steven', aliases: ['argos', 'jarvis', 'kant', 'socrates', 'zeus'] },
  Miguel: { room: 'grp.miguel', aliases: ['atlas', 'iza', 'janus', 'kratos'] },
  Isa: { room: 'grp.isa', aliases: ['salva'] },
  Jhon: { room: 'grp.jhon', aliases: ['hegel'] },
  Pablo: { room: 'grp.pablo', aliases: ['dedalo', 'midas', 'seneca', 'vulcano'] },
};

export const tenantAgents = Object.fromEntries(
  Object.entries(topology).map(([tenant, { aliases }]) => [tenant.toLowerCase(), aliases]),
);
