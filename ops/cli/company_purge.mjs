const HELP = `Uso: cauce platform empresa purgar-canarios [--simular] [--empresa zz-canary-ID] [--admin UUID]
Solo purga empresas retiradas cuyo identificador empieza por zz-canary-.
--simular muestra las filas y bloqueos de cada empresa y revierte la transacción, sin crear copias.
La simulación toma los mismos bloqueos temporales de PostgreSQL que la preparación web.
Cada purga guarda antes un JSON privado y sincronizado en el directorio de copias de la web.
Actor: --admin, CAUCE_PLATFORM_ADMIN_ID o el administrador activo más antiguo.
En producción: cauce platform contenedor empresa purgar-canarios --simular
`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CANARY = /^zz-canary-[a-z0-9_-]{0,54}$/u;

class SimulationResult extends Error {
  constructor(preview) {
    super('Company purge preview');
    this.preview = preview;
  }
}

function parse(argv, UsageError) {
  const options = {};
  for (let index = 2; index < argv.length; index += 1) {
    const option = argv[index];
    if (!['--simular', '--empresa', '--admin'].includes(option) || Object.hasOwn(options, option)) {
      throw new UsageError('Opción desconocida o repetida; consultar empresa purgar-canarios --help.');
    }
    if (option === '--simular') options[option] = true;
    else {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new UsageError(`Falta valor de ${option}.`);
      options[option] = value;
    }
  }
  const company = options['--empresa'] ?? null;
  const actor = options['--admin'] ?? process.env.CAUCE_PLATFORM_ADMIN_ID ?? null;
  if (company !== null && !CANARY.test(company)) throw new UsageError('Solo se admiten empresas con identificador zz-canary-.');
  if (actor !== null && !UUID.test(actor)) throw new UsageError('--admin o CAUCE_PLATFORM_ADMIN_ID debe ser un UUID.');
  return { company, actor, simulate: options['--simular'] === true };
}

async function actorRequest(client, actor) {
  return (await client.query(`SELECT person.id AS "humanId",person.tenant_id AS tenant,person.alias
    FROM platform_admins admin JOIN console_users person ON person.id=admin.human_id
    JOIN companies home ON home.id=person.company_id
    WHERE person.active AND person.role='operator' AND home.enabled AND home.retired_at IS NULL
      AND ($1::uuid IS NULL OR person.id=$1) ORDER BY admin.created_at,admin.human_id LIMIT 1`, [actor])).rows[0];
}

function reportFailure(company, error, dependencies, CompanyPurgeBlockedError) {
  let reason = 'No se pudo confirmar la purga; revisa la empresa y la copia antes de reintentar.';
  if (error instanceof CompanyPurgeBlockedError) {
    process.stdout.write(`${JSON.stringify({ company_id: company, status: 'blocked', blockers: error.blockers })}\n`);
    return;
  }
  if (dependencies.isDatabaseError(error)) reason = `PostgreSQL rechazó la operación (${error.code}).`;
  else if (error?.code === 'conflict') reason = 'La empresa debe seguir retirada y sin recursos físicos ni referencias ajenas.';
  else if (error?.code === 'forbidden') reason = 'Se exige un administrador de plataforma activo y cualificado.';
  else if (error?.code === 'not_found') reason = 'La empresa ya no existe.';
  process.stderr.write(`${company}: ${reason}\n`);
}

export async function main(argv, dependencies) {
  if (argv.length === 3 && ['--help', '-h'].includes(argv[2])) {
    process.stdout.write(HELP);
    return 0;
  }
  let options, url;
  try {
    options = parse(argv, dependencies.UsageError);
    dependencies.sanitizeEnvironment(process.env);
    url = await dependencies.databaseUrl();
  } catch (error) {
    process.stderr.write(`${error instanceof dependencies.UsageError ? error.message : 'Entrada inválida.'}\n`);
    return 2;
  }
  let pool;
  try {
    const [db, purge, authority] = await Promise.all(['db', 'company-purge', 'company-authority'].map(dependencies.loadStore));
    if (!options.simulate && typeof purge.saveCompanyPurgeBackup !== 'function') {
      throw new dependencies.UsageError('La imagen de runtime debe incluir el helper saveCompanyPurgeBackup de esta versión.');
    }
    pool = db.createPool(url, { max: 1, applicationName: 'cauce-platform-purge-canaries' });
    const candidates = await db.withTransaction(pool, async client => {
      const request = await actorRequest(client, options.actor);
      if (!request) throw new dependencies.UsageError('No hay un administrador de plataforma activo para actuar.');
      authority.assertPlatformAdmin(await authority.lockCompanyAuthority(client, request));
      const companies = (await client.query(`SELECT id FROM companies WHERE id LIKE 'zz-canary-%'
        AND retired_at IS NOT NULL AND ($1::text IS NULL OR id=$1) ORDER BY id`, [options.company])).rows;
      if (options.company && companies.length === 0) throw new dependencies.UsageError('La empresa solicitada debe existir y estar retirada.');
      return companies;
    });
    let failed = 0, completed = 0;
    for (const { id } of candidates) {
      try {
        const receipt = await db.withTransaction(pool, async client => {
          await client.query("SET LOCAL lock_timeout='5s'");
          await client.query("SET LOCAL statement_timeout='30s'");
          if (!CANARY.test(id)) throw new dependencies.UsageError('La empresa no es una canaria.');
          const request = await actorRequest(client, options.actor);
          if (!request) throw new dependencies.UsageError('El administrador de plataforma ya no está activo.');
          const actor = await authority.lockCompanyAuthority(client, request);
          authority.assertPlatformAdmin(actor);
          if (options.simulate) {
            await authority.lockPlatformConfiguration(client);
            const prepared = (await client.query('SELECT snapshot,blockers FROM cauce_prepare_company_purge($1,$2)', [id, actor.humanId])).rows[0];
            throw new SimulationResult({ company_id: id, status: prepared.blockers.length ? 'blocked' : 'would_purge',
              rows: Object.fromEntries(Object.entries(prepared.snapshot.records).map(([table, rows]) => [table, rows.length])), blockers: prepared.blockers });
          }
          return purge.purgeCompany(client, actor, id, { confirmation: id },
            (_snapshot, serialized) => purge.saveCompanyPurgeBackup(id, serialized));
        });
        completed += 1;
        process.stdout.write(`${JSON.stringify(receipt)}\n`);
      } catch (error) {
        if (error instanceof SimulationResult) {
          process.stdout.write(`${JSON.stringify(error.preview)}\n`);
          if (error.preview.blockers.length) failed += 1;
        } else {
          failed += 1;
          reportFailure(id, error, dependencies, purge.CompanyPurgeBlockedError);
        }
      }
    }
    process.stdout.write(`${options.simulate ? 'Simulación' : 'Purga'}: ${candidates.length} candidata(s), ${completed} purgada(s), ${failed} bloqueada(s) o fallida(s).\n`);
    return failed > 0 ? 1 : 0;
  } catch (error) {
    const reason = error instanceof dependencies.UsageError ? error.message
      : dependencies.isDatabaseError(error) ? `PostgreSQL rechazó la operación (${error.code}).` : dependencies.localReason(error);
    process.stderr.write(`Purga no iniciada: ${reason}\n`);
    return 1;
  } finally { await pool?.end().catch(() => undefined); }
}
