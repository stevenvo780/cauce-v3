import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentConfigMutationSchema, clampToRoleBriefLimit, countCodePoints,
  ROLE_BRIEF_MAX_CODE_POINTS, WsOutboundSchema, type ConfigMutation
} from '@cauce/protocol';
import { CauceRepository, StoreError, type DatabasePool } from '@cauce/store';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../helpers/postgres.js';

/**
 * `agents.role_brief` escrito por la mutación de configuración.
 *
 * Hasta esta rama el rol declarado de cada alias SÓLO se leía (`selfRoleBrief()` en
 * repository.ts): la única forma de cambiarlo era un UPDATE crudo contra la base, que no deja
 * revisión, no deja mutación inversa y no se puede deshacer. Lo que estos casos prueban no es que
 * la columna se escriba, sino que se escriba *auditable* y que el borde de longitud se decida en
 * el código y no en el CHECK de Postgres, que sube como 500 opaco.
 */

let database: TestDatabase;
let pool: DatabasePool;
let repository: CauceRepository;

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 120_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query(`
    TRUNCATE config_revisions RESTART IDENTITY;
    UPDATE memberships SET role='agent' WHERE alias IN ('midas','salva');
    UPDATE acl_edges SET enabled=true,allow_route=true,allow_read=true,allow_control=true;
  `);
});

afterAll(async () => {
  if (pool) await pool.end();
  if (database?.container) await database.container.stop();
});

/** El texto real que la pantalla va a editar: castellano con acentos, no un relleno de 'a'. */
const primerBrief = 'Sos salva, el agente de Isa. Lo tuyo es resolver los encargos de Isa de punta '
  + 'a punta: no delegues lo que podés hacer vos. NO toques producción ni credenciales.';
const segundoBrief = 'Sos salva. Tu trabajo es la operación diaria de Isa, y respondés vos: '
  + 'delegar es la excepción, no el primer movimiento.';

/** Aplica mutaciones como el operador del hub, hilando la revisión optimista. */
async function applyAll(mutations: readonly ConfigMutation[], from = 0): Promise<number> {
  let revision = from;
  for (const mutation of mutations) {
    const changed = await repository.applyConfigurationChange('Steven', 'kant', mutation, false, revision);
    expect(changed.applied).toBe(true);
    revision = changed.revision;
  }
  return revision;
}

function crearSalva(value: Record<string, unknown>): ConfigMutation {
  return { resource: 'agent', action: 'create', tenant_id: 'Isa', alias: 'salva', value };
}

function editarSalva(value: Record<string, unknown>): ConfigMutation {
  return { resource: 'agent', action: 'update', tenant_id: 'Isa', alias: 'salva', value };
}

/** El error tal cual sale del store: se afirma sobre su texto, que es lo que ve el operador. */
async function capturar(
  mutation: ConfigMutation, expectedRevision: number
): Promise<{ code: string; message: string }> {
  try {
    await repository.applyConfigurationChange('Steven', 'kant', mutation, false, expectedRevision);
  } catch (error) {
    const code = error instanceof StoreError ? error.code : 'no-es-StoreError';
    return { code, message: error instanceof Error ? error.message : String(error) };
  }
  throw new Error('la mutación tenía que fallar y no falló');
}

async function briefEnLaBase(): Promise<string | null> {
  const result = await pool.query<{ role_brief: string | null }>(
    `SELECT role_brief FROM agents WHERE tenant_id='Isa' AND alias='salva'`
  );
  return result.rows[0]?.role_brief ?? null;
}

describe('agents.role_brief se escribe por la mutación de configuración', () => {
  it('deja una mutación inversa que restaura el brief anterior palabra por palabra', async () => {
    await applyAll([crearSalva({ harness_id: 'codex', display_name: 'Salva', role_brief: primerBrief })]);
    expect(await briefEnLaBase()).toBe(primerBrief);

    const editado = await repository.applyConfigurationChange(
      'Steven', 'kant', editarSalva({ role_brief: segundoBrief }), false, 1
    );
    expect(editado.revision).toBe(2);
    expect(await briefEnLaBase()).toBe(segundoBrief);

    // El inverso tiene que llevar el texto ANTERIOR, no un hueco: es lo único de lo que sale la
    // vuelta atrás, y un brief perdido no se recupera de ningún otro lado.
    expect(editado.inverse_mutation).toMatchObject({
      resource: 'agent', action: 'update', tenant_id: 'Isa', alias: 'salva',
      value: { role_brief: primerBrief }
    });

    const vuelto = await repository.rollbackConfiguration('Steven', 'kant', editado.revision, false, 2);
    expect(vuelto).toMatchObject({ applied: true, revision: 3 });
    expect(await briefEnLaBase()).toBe(primerBrief);
  });

  it('restaura el brief cuando se deshace el borrado del agente', async () => {
    await applyAll([crearSalva({ display_name: 'Salva', role_brief: primerBrief })]);
    const borrado = await repository.applyConfigurationChange(
      'Steven', 'kant', { resource: 'agent', action: 'delete', tenant_id: 'Isa', alias: 'salva' }, false, 1
    );
    expect(await briefEnLaBase()).toBeNull();

    await repository.rollbackConfiguration('Steven', 'kant', borrado.revision, false, 2);
    expect(await briefEnLaBase()).toBe(primerBrief);
  });

  it('acepta 1200 caracteres y rechaza 1201 diciendo cuántos se mandaron', async () => {
    await applyAll([crearSalva({ display_name: 'Salva' })]);

    const justo = 'a'.repeat(1200);
    const cambiado = await repository.applyConfigurationChange(
      'Steven', 'kant', editarSalva({ role_brief: justo }), false, 1
    );
    expect(cambiado.applied).toBe(true);
    expect(await briefEnLaBase()).toBe(justo);

    const unoDeMas = 'b'.repeat(1201);
    const rechazo = await capturar(editarSalva({ role_brief: unoDeMas }), 2);
    expect(rechazo.code).toBe('invalid_input');
    // El mensaje nombra el límite Y lo que se mandó: una pantalla útil dice cuánto sobra, un 500
    // por violación de CHECK no dice nada.
    expect(rechazo.message).toContain('1200');
    expect(rechazo.message).toContain('1201');
    // El rechazo no puede haber dejado a medias la fila ni consumido una revisión.
    expect(await briefEnLaBase()).toBe(justo);
    expect((await pool.query(`SELECT count(*)::int AS total FROM config_revisions`)).rows[0])
      .toEqual({ total: 2 });
  });

  it('cuenta puntos de código, no unidades UTF-16: 1200 con emoji entra y 1201 no', async () => {
    await applyAll([crearSalva({ display_name: 'Salva' })]);

    // 1100 letras + 100 emoji fuera del BMP: 1200 puntos de código, 1300 unidades UTF-16.
    // `char_length` de Postgres mide lo primero, `String.length` de JS lo segundo. Si la
    // validación contara con `String.length` este brief legítimo se rechazaría con un error que
    // la base nunca habría dado.
    const conEmoji = `${'a'.repeat(1100)}${'🎉'.repeat(100)}`;
    expect([...conEmoji].length).toBe(1200);
    expect(conEmoji.length).toBe(1300);

    const guardado = await repository.applyConfigurationChange(
      'Steven', 'kant', editarSalva({ role_brief: conEmoji }), false, 1
    );
    expect(guardado.applied).toBe(true);
    // La medida que importa es la de la columna, no la del test: si esto da 1300 la validación
    // está mirando otra magnitud que el CHECK.
    expect((await pool.query<{ medido: number }>(
      `SELECT char_length(role_brief) AS medido FROM agents WHERE tenant_id='Isa' AND alias='salva'`
    )).rows[0]).toEqual({ medido: 1200 });

    const unoDeMas = `${'a'.repeat(1101)}${'🎉'.repeat(100)}`;
    expect([...unoDeMas].length).toBe(1201);
    expect(unoDeMas.length).toBe(1301);
    const rechazo = await capturar(editarSalva({ role_brief: unoDeMas }), 2);
    expect(rechazo.code).toBe('invalid_input');
    // 1201 y no 1301: el mensaje que ve el operador tiene que hablar en la misma unidad que el
    // límite que le acabamos de nombrar.
    expect(rechazo.message).toContain('1201');
    expect(rechazo.message).not.toContain('1301');
    expect(await briefEnLaBase()).toBe(conEmoji);
  });

  it('guarda NULL —no la cadena vacía— cuando el operador borra el texto', async () => {
    await applyAll([crearSalva({ display_name: 'Salva', role_brief: primerBrief })]);

    const borrado = await repository.applyConfigurationChange(
      'Steven', 'kant', editarSalva({ role_brief: '' }), false, 1
    );
    expect(borrado.applied).toBe(true);
    // `IS NULL` y no `=''`: el CHECK exige longitud >= 1, así que guardar '' sería una violación,
    // y `selfRoleBrief()` espera NULL para OMITIR la línea `Tu rol:` en vez de anteponer una vacía.
    expect((await pool.query<{ nulo: boolean }>(
      `SELECT role_brief IS NULL AS nulo FROM agents WHERE tenant_id='Isa' AND alias='salva'`
    )).rows[0]).toEqual({ nulo: true });

    // Sólo espacios y saltos de línea es lo mismo que vacío: es lo que deja una caja de texto que
    // el operador vació con el teclado.
    await applyAll([editarSalva({ role_brief: primerBrief })], borrado.revision);
    const enBlanco = await repository.applyConfigurationChange(
      'Steven', 'kant', editarSalva({ role_brief: '   \n\t  ' }), false, 3
    );
    expect(enBlanco.applied).toBe(true);
    expect(await briefEnLaBase()).toBeNull();

    // Y el inverso del borrado devuelve el texto: borrar también se deshace.
    await repository.rollbackConfiguration('Steven', 'kant', enBlanco.revision, false, 4);
    expect(await briefEnLaBase()).toBe(primerBrief);
  });

  it('acepta null explícito como borrado, igual que la cadena vacía', async () => {
    await applyAll([crearSalva({ display_name: 'Salva', role_brief: primerBrief })]);
    await applyAll([editarSalva({ role_brief: null })], 1);
    expect(await briefEnLaBase()).toBeNull();
  });

  it('no cambia el brief cuando la mutación edita otro campo', async () => {
    await applyAll([crearSalva({ display_name: 'Salva', role_brief: primerBrief })]);
    await applyAll([editarSalva({ display_name: 'Salva (Isa)' })], 1);
    // La clave ausente significa "no lo toques", no "borralo": si esto fallara, renombrar un alias
    // le borraría la identidad sin que nadie lo pidiera.
    expect(await briefEnLaBase()).toBe(primerBrief);
  });

  it('sigue dando de alta un agente sin role_brief, igual que antes de esta columna', async () => {
    const revision = await applyAll([crearSalva({
      harness_id: 'codex', display_name: 'Salva', enabled: false,
      container_name: 'claw-salva', runtime_user: 'dev',
      home_directory: '/home/dev', state_directory: '/var/state/salva'
    })]);
    expect(revision).toBe(1);
    expect((await pool.query<{ display_name: string; nulo: boolean }>(
      `SELECT display_name, role_brief IS NULL AS nulo FROM agents WHERE tenant_id='Isa' AND alias='salva'`
    )).rows[0]).toEqual({ display_name: 'Salva', nulo: true });
  });

  it('rechaza un role_brief que no es texto antes de tocar la base', async () => {
    await applyAll([crearSalva({ display_name: 'Salva' })]);
    await expect(repository.applyConfigurationChange(
      'Steven', 'kant', editarSalva({ role_brief: 42 }), false, 1
    )).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('publica el brief en el snapshot de configuración, que es lo que la pantalla lee', async () => {
    await applyAll([crearSalva({ display_name: 'Salva', role_brief: primerBrief })]);
    const snapshot = await repository.getConfiguration('Steven', 'kant');
    expect(snapshot.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ tenant_id: 'Isa', alias: 'salva', role_brief: primerBrief })
    ]));
  });

  it('el brief guardado por la consola llega al sobre de la entrega como self_role', async () => {
    await applyAll([crearSalva({ display_name: 'Salva', role_brief: primerBrief })]);
    await applyAll([editarSalva({ role_brief: segundoBrief })], 1);

    await repository.publish({
      version: '3.0', request_id: randomUUID(), trace_id: `trace-${randomUUID()}`,
      tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: 'kant',
      recipients: [{ tenant_id: 'Isa', alias: 'salva' }], body: { text: 'con rol declarado' },
      idempotency_key: randomUUID(), lane: 'interactive', priority: 0
    });
    const lease = await repository.acquireLease('Isa', 'salva', 'salva-role-brief', ['agent_identity_v1'], 30_000);
    const claimed = await repository.claimDeliveries('Isa', 'salva', 'salva-role-brief', lease.epoch!, 5);

    // El efecto, no el nombre: lo que se editó por la pantalla es lo que el adaptador antepone
    // como `Tu rol:`. Sin esta aserción el test probaría que una columna cambia, no que el alias
    // cambió de identidad.
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ self_role: segundoBrief });
  });
});

/**
 * 1200 PUNTOS DE CÓDIGO y 1300 unidades UTF-16: el brief exacto con el que la revisión adversarial
 * dejó sordo a un alias. Es el único texto que distingue las dos unidades en el borde, y por eso
 * es el que hay que usar de punta a punta y no un relleno de 'a'.
 */
const briefEnElBordeConEmoji = `${'a'.repeat(1100)}${'🎉'.repeat(100)}`;

/** Publica un mensaje para salva y devuelve el SOBRE tal como sale del store hacia el adaptador. */
async function sobreDeLaEntrega(): Promise<Record<string, unknown>> {
  await repository.publish({
    version: '3.0', request_id: randomUUID(), trace_id: `trace-${randomUUID()}`,
    tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: 'kant',
    recipients: [{ tenant_id: 'Isa', alias: 'salva' }], body: { text: 'con rol declarado' },
    idempotency_key: randomUUID(), lane: 'interactive', priority: 0
  });
  const lease = await repository.acquireLease(
    'Isa', 'salva', 'salva-role-brief', ['agent_identity_v1'], 30_000
  );
  const claimed = await repository.claimDeliveries('Isa', 'salva', 'salva-role-brief', lease.epoch!, 5);
  expect(claimed).toHaveLength(1);
  return claimed[0] as unknown as Record<string, unknown>;
}

/**
 * La unidad del tope tiene que ser la MISMA en las cuatro capas, y la que manda es el punto de
 * código porque es lo que mide `char_length` de la columna — la única capa que no se puede cambiar
 * sin migración.
 *
 * Lo que estos casos persiguen no es una función sino un EFECTO: un brief que el store guarda y el
 * CHECK acepta tiene que poder viajar en el sobre de la entrega. Mientras `self_role` contó
 * unidades UTF-16 había una franja —1200 puntos de código con emoji, 1300 en UTF-16— donde el
 * brief se guardaba, la pantalla decía «guardado» y `WsOutboundSchema.parse()` rechazaba el sobre
 * ENTERO en la entrega siguiente. El alias dejaba de recibir y no aparecía ningún error: sordo y
 * en silencio.
 */
describe('el brief que la base acepta viaja en el sobre sin dejar sordo al alias', () => {
  it('un brief de 1200 puntos de código con emoji se guarda Y el sobre pasa WsOutboundSchema', async () => {
    // CONTROL NEGATIVO de la muestra: este texto no sirve de nada si las dos unidades coinciden.
    // 1200 vs 1300 es exactamente lo que separaba a la base del esquema, y `String.length` es
    // literalmente lo que evaluaba el `.max(1200)` de zod que había acá antes: con la regla vieja
    // este sobre se rechazaba. (El rechazo contra el `WsOutboundSchema` de la versión anterior se
    // comprobó a mano contra su dist; acá se conserva la magnitud que lo causaba.)
    expect(countCodePoints(briefEnElBordeConEmoji)).toBe(ROLE_BRIEF_MAX_CODE_POINTS);
    expect(briefEnElBordeConEmoji.length).toBe(1300);
    expect(briefEnElBordeConEmoji.length).toBeGreaterThan(ROLE_BRIEF_MAX_CODE_POINTS);

    await applyAll([crearSalva({ display_name: 'Salva', role_brief: briefEnElBordeConEmoji })]);
    // La base lo aceptó midiendo en su propia unidad, no en la nuestra.
    expect((await pool.query<{ medido: number }>(
      `SELECT char_length(role_brief) AS medido FROM agents WHERE tenant_id='Isa' AND alias='salva'`
    )).rows[0]).toEqual({ medido: 1200 });

    const sobre = await sobreDeLaEntrega();
    expect(sobre.self_role).toBe(briefEnElBordeConEmoji);

    // ESTA es la aserción que prueba que el alias no queda sordo: es la misma llamada que hace
    // `websocket-transport.ts` con cada frame del gateway. Si tira, el adaptador descarta la
    // conexión entera y el agente deja de consumir entregas.
    const parseado = WsOutboundSchema.parse(sobre);
    expect(parseado).toMatchObject({ type: 'delivery', self_role: briefEnElBordeConEmoji });
  });

  it('1201 puntos de código no entran, y el número del error es 1201, no 1301', async () => {
    await applyAll([crearSalva({ display_name: 'Salva' })]);
    const unoDeMas = `${'a'.repeat(1101)}${'🎉'.repeat(100)}`;
    expect(countCodePoints(unoDeMas)).toBe(1201);
    expect(unoDeMas.length).toBe(1301);

    // El store, que es quien le contesta a la pantalla.
    const rechazo = await capturar(editarSalva({ role_brief: unoDeMas }), 1);
    expect(rechazo.code).toBe('invalid_input');
    expect(rechazo.message).toContain('1201');
    expect(rechazo.message).not.toContain('1301');

    // Y el esquema del sobre, que es la otra capa que puede rechazarlo. Tiene que hablar en la
    // MISMA unidad: un operador al que el store le dice 1201 y el protocolo 1301 no puede saber
    // cuánto le sobra.
    const fallido = WsOutboundSchema.safeParse({ ...(await sobreDeLaEntrega()), self_role: unoDeMas });
    expect(fallido.success).toBe(false);
    const mensajes = JSON.stringify(fallido.success ? [] : fallido.error.issues);
    expect(mensajes).toContain('1201');
    expect(mensajes).not.toContain('1301');
  });

  it('el recorte del adaptador no parte un par suplente ni deja un surrogate suelto', () => {
    // 1199 letras + un emoji: 1200 puntos de código, 1201 unidades UTF-16. Es el texto que el
    // `trimmed.slice(0, 1200)` de `selfRoleFromDelivery()` cortaba por la mitad del par suplente.
    const justoConEmojiAlFinal = `${'a'.repeat(1199)}🎉`;
    expect(countCodePoints(justoConEmojiAlFinal)).toBe(ROLE_BRIEF_MAX_CODE_POINTS);
    expect(justoConEmojiAlFinal.length).toBe(1201);

    // CONTROL NEGATIVO: la línea vieja, ejecutada tal cual estaba, SÍ rompe el emoji. Sin esto el
    // caso de abajo pasaría igual con cualquier implementación y no probaría nada.
    const recorteViejo = justoConEmojiAlFinal.slice(0, 1200);
    expect(Buffer.from(recorteViejo, 'utf8').toString('utf8')).toContain('�');

    const recortado = clampToRoleBriefLimit(justoConEmojiAlFinal);
    // No hace falta recortar nada: 1200 puntos de código ya entran enteros.
    expect(recortado).toBe(justoConEmojiAlFinal);
    // El efecto medido donde duele: serializar a UTF-8 y volver. Un surrogate suelto no tiene
    // representación en UTF-8 y vuelve convertido en U+FFFD, que es lo que el agente leería.
    expect(Buffer.from(recortado, 'utf8').toString('utf8')).toBe(recortado);
    expect(recortado).not.toContain('�');

    // Y cuando de verdad sobra, el corte cae en el borde de un punto de código, nunca dentro.
    const pasado = `${'a'.repeat(1199)}🎉🎉`;
    const cortado = clampToRoleBriefLimit(pasado);
    expect(countCodePoints(cortado)).toBe(ROLE_BRIEF_MAX_CODE_POINTS);
    expect(cortado).toBe(justoConEmojiAlFinal);
    expect(Buffer.from(cortado, 'utf8').toString('utf8')).toBe(cortado);
    expect(cortado).not.toContain('�');
  });
});

describe('el esquema del protocolo admite role_brief en la mutación de agente', () => {
  it('no rechaza el sobre por .strict(), que es como se cae un campo nuevo', () => {
    // `AgentConfigMutationSchema` es .strict(): si el campo no estuviera declarado, el gateway
    // rechazaría la mutación entera con "unrecognized key" y la pantalla no podría guardar nada,
    // aunque el store ya supiera escribirla.
    const aceptado = AgentConfigMutationSchema.safeParse({
      resource: 'agent', action: 'update', tenant_id: 'Isa', alias: 'salva',
      value: { role_brief: primerBrief }
    });
    expect(aceptado.success).toBe(true);

    for (const role_brief of ['', null]) {
      expect(AgentConfigMutationSchema.safeParse({
        resource: 'agent', action: 'update', tenant_id: 'Isa', alias: 'salva', value: { role_brief }
      }).success).toBe(true);
    }

    // Un brief de 1200 puntos de código con emoji mide 1300 en UTF-16: el esquema NO puede
    // rechazarlo, porque la base lo acepta.
    expect(AgentConfigMutationSchema.safeParse({
      resource: 'agent', action: 'update', tenant_id: 'Isa', alias: 'salva',
      value: { role_brief: `${'a'.repeat(1100)}${'🎉'.repeat(100)}` }
    }).success).toBe(true);
  });
});
