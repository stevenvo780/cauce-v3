import { mkdtemp, rm, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertV2PollerDisabled,
  chatParticipants,
  effectiveChatPolicy,
  fleetDirectory,
  fleetParticipationGaps,
  groupRouting,
  loadTelegramBridgeConfig,
  parseTelegramBridgeConfig,
  readTelegramToken
} from '../../services/telegram-bridge/src/config.js';
import type {
  TelegramAliasConfig,
  TelegramBridgeConfig
} from '../../services/telegram-bridge/src/types.js';

/**
 * Cobertura pura de `services/telegram-bridge/src/config.ts`.
 *
 * El parser (`parseTelegramBridgeConfig`) valida el contrato del JSON de la flota:
 * forma de los alias, uniqueness, invariantes cross-alias (un único ambient host
 * por (chat, thread), usernames únicos, aliases únicos por tenant). Los helpers
 * puros (`groupRouting`, `effectiveChatPolicy`, `chatParticipants`,
 * `fleetDirectory`, `fleetParticipationGaps`) son lo que `main.ts` enchufa en el
 * resolver de addressing y el egress, así que cubrirlos protege el cableado.
 *
 * Los lectores de filesystem (`loadTelegramBridgeConfig`, `readTelegramToken`,
 * `assertV2PollerDisabled`) se ejercitan contra un directorio temporal real
 * (sin red, sin Postgres): las invariantes que importan son la ruta absoluta, la
 * regex del token y el contenido del marker — no el path en disco.
 */

const TENANT = 'Steven';
const CHAT_ID = '-5001';

function rawAlias(alias: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    alias,
    tenant_id: TENANT,
    room_id: 'grp.steven',
    token_file: `/synthetic/${alias}.token`,
    v2_shutdown_marker_file: `/synthetic/${alias}.marker`,
    allowed_user_ids: ['101'],
    allowed_chat_ids: [CHAT_ID],
    recipients: [{ tenant_id: TENANT, alias }],
    poll_timeout_seconds: 25,
    poll_lease_ms: 60_000,
    ...overrides
  };
}

function buildConfig(aliases: Record<string, unknown>[]): TelegramBridgeConfig {
  return parseTelegramBridgeConfig({ aliases });
}

function firstAlias(config: TelegramBridgeConfig): TelegramAliasConfig {
  const alias = config.aliases[0];
  if (!alias) throw new Error('la configuración no devolvió ningún alias');
  return alias;
}

describe('groupRouting: distingue legacy (sin chats) de scoped (con chats)', () => {
  it('devuelve "legacy" cuando la clave chats está ausente', () => {
    const config = buildConfig([rawAlias('kant')]);
    expect(groupRouting(firstAlias(config))).toBe('legacy');
  });

  it('devuelve "scoped" cuando chats está presente, aunque sea un array vacío', () => {
    const config = buildConfig([
      rawAlias('kant'),
      rawAlias('argos', { bot_username: 'argos_bot', chats: [] })
    ]);
    expect(groupRouting(firstAlias(config))).toBe('legacy');
    expect(groupRouting(config.aliases[1] as TelegramAliasConfig)).toBe('scoped');
  });
});

describe('effectiveChatPolicy: combina chat con override de thread', () => {
  it('devuelve undefined cuando un alias scoped nunca declaró ese chat', () => {
    const config = buildConfig([rawAlias('kant', { bot_username: 'kant_bot', chats: [] })]);
    expect(effectiveChatPolicy(firstAlias(config), CHAT_ID, '0')).toBeUndefined();
  });

  it('la política del chat se aplica al thread 0 aunque haya overrides de otros threads', () => {
    const config = buildConfig([rawAlias('kant', {
      bot_username: 'kant_bot',
      chats: [{
        chat_id: CHAT_ID,
        mode: 'always',
        default_alias: 'kant',
        threads: [{ thread_id: '42', mode: 'mention' }]
      }]
    })]);
    const alias = firstAlias(config);
    expect(effectiveChatPolicy(alias, CHAT_ID, '0')).toMatchObject({ mode: 'always', default_alias: 'kant' });
    expect(effectiveChatPolicy(alias, CHAT_ID, '42')).toMatchObject({ mode: 'mention', default_alias: 'kant' });
  });

  it('un thread no declarado cae sobre la política del chat intacta', () => {
    const config = buildConfig([rawAlias('kant', {
      bot_username: 'kant_bot',
      chats: [{ chat_id: CHAT_ID, mode: 'always', default_alias: 'kant', threads: [] }]
    })]);
    const alias = firstAlias(config);
    expect(effectiveChatPolicy(alias, CHAT_ID, '999')).toMatchObject({ mode: 'always', default_alias: 'kant' });
  });

  it('un thread puede borrar el default_alias heredado con null', () => {
    const config = buildConfig([rawAlias('kant', {
      bot_username: 'kant_bot',
      chats: [{
        chat_id: CHAT_ID,
        default_alias: 'kant',
        threads: [{ thread_id: '42', default_alias: null }]
      }]
    })]);
    const alias = firstAlias(config);
    expect(effectiveChatPolicy(alias, CHAT_ID, '42')).not.toHaveProperty('default_alias');
  });
});

describe('fleetDirectory: indexa usernames y bot ids para el resolver', () => {
  it('construye byUsername en minúsculas a partir de los aliases que declararon bot_username', () => {
    const config = buildConfig([
      rawAlias('kant', { bot_username: 'Kant_Bot' }),
      rawAlias('argos', { bot_username: 'argos_bot' }),
      rawAlias('jarvis') // sin bot_username -> no indexado
    ]);
    const directory = fleetDirectory(config);
    expect(directory.byUsername.get('kant_bot')).toBe('kant');
    expect(directory.byUsername.get('argos_bot')).toBe('argos');
    expect(directory.byUsername.has('jarvis')).toBe(false);
    expect(directory.byBotId.size).toBe(0);
  });

  it('incorpora los bot ids verificados por getMe en byBotId pero no toca byUsername', () => {
    const config = buildConfig([
      rawAlias('kant', { bot_username: 'kant_bot' }),
      rawAlias('argos', { bot_username: 'argos_bot' })
    ]);
    const directory = fleetDirectory(config, new Map([['kant', '1234567'], ['argos', '7654321']]));
    expect(directory.byBotId.get('1234567')).toBe('kant');
    expect(directory.byBotId.get('7654321')).toBe('argos');
    expect(directory.byUsername.size).toBe(2);
  });
});

describe('chatParticipants: conjunto de aliases habilitados para un (chat, thread)', () => {
  it('un alias legacy cuenta como participante de cualquier chat en su allowed_chat_ids', () => {
    const config = buildConfig([rawAlias('kant')]);
    expect(chatParticipants(config, CHAT_ID, '0').has('kant')).toBe(true);
  });

  it('un alias scoped solo participa si declaró el chat con un mode distinto de off', () => {
    const config = buildConfig([
      rawAlias('kant', { bot_username: 'kant_bot', chats: [{ chat_id: CHAT_ID, mode: 'always' }] }),
      rawAlias('mudo', { bot_username: 'mudo_bot', chats: [{ chat_id: CHAT_ID, mode: 'off' }] })
    ]);
    const participants = chatParticipants(config, CHAT_ID, '0');
    expect(participants.has('kant')).toBe(true);
    expect(participants.has('mudo')).toBe(false);
  });

  it('un alias scoped que no nombró el chat no participa aunque el chat esté en allowed_chat_ids', () => {
    const config = buildConfig([rawAlias('kant', { bot_username: 'kant_bot', chats: [] })]);
    expect(chatParticipants(config, CHAT_ID, '0').size).toBe(0);
  });
});

describe('fleetParticipationGaps: pares (alias, chat) no inicializados en selected', () => {
  it('lista los pares que faltan en el conjunto vivo y omite los que ya corren', () => {
    // kant ambient, argos solo mention: ambos participan pero solo kant responde mensajes sin dueño.
    const config = buildConfig([
      rawAlias('kant', { bot_username: 'kant_bot', chats: [{ chat_id: CHAT_ID, mode: 'always' }] }),
      rawAlias('argos', { bot_username: 'argos_bot', chats: [{ chat_id: CHAT_ID, mode: 'mention' }] })
    ]);
    const running = config.aliases.filter((alias) => alias.alias === 'kant');
    const gaps = fleetParticipationGaps(config, running);
    expect(gaps).toEqual([{ alias: 'argos', chat_id: CHAT_ID }]);
  });

  it('devuelve [] cuando todo el fleet corre', () => {
    const config = buildConfig([rawAlias('kant', { bot_username: 'kant_bot', chats: [] })]);
    expect(fleetParticipationGaps(config, config.aliases)).toEqual([]);
  });
});

describe('parseTelegramBridgeConfig: invariantes cross-alias', () => {
  it('rechaza una raíz que no es objeto', () => {
    expect(() => parseTelegramBridgeConfig(null)).toThrow('must be an object');
    expect(() => parseTelegramBridgeConfig('hola')).toThrow('must be an object');
  });

  it('rechaza aliases ausente o vacío', () => {
    expect(() => parseTelegramBridgeConfig({})).toThrow('aliases must be a non-empty array');
    expect(() => parseTelegramBridgeConfig({ aliases: [] })).toThrow('aliases must be a non-empty array');
  });

  it('rechaza tokens de Telegram inline (token / bot_token)', () => {
    expect(() => buildConfig([rawAlias('kant', { token: '1234:abcd' })])).toThrow('inline Telegram tokens are forbidden');
    expect(() => buildConfig([rawAlias('kant', { bot_token: '1234:abcd' })])).toThrow('inline Telegram tokens are forbidden');
  });

  it('rechaza más de un recipient o un recipient que no se apunta a sí mismo', () => {
    expect(() => buildConfig([rawAlias('kant', {
      recipients: [
        { tenant_id: TENANT, alias: 'kant' },
        { tenant_id: TENANT, alias: 'kant' }
      ]
    })])).toThrow('Telegram ingress requires exactly one self recipient');
    expect(() => buildConfig([rawAlias('kant', {
      recipients: [{ tenant_id: TENANT, alias: 'otros' }]
    })])).toThrow('Telegram ingress requires exactly one self recipient');
  });

  it('rechaza poll_lease_ms que no excede poll_timeout_seconds * 1000 + 5000', () => {
    expect(() => buildConfig([rawAlias('kant', { poll_timeout_seconds: 30, poll_lease_ms: 30_000 })]))
      .toThrow('poll_lease_ms must exceed the long-poll timeout by at least 5 seconds');
    expect(() => buildConfig([rawAlias('kant', { poll_timeout_seconds: 30, poll_lease_ms: 34_999 })]))
      .toThrow('poll_lease_ms must exceed the long-poll timeout by at least 5 seconds');
    const ok = buildConfig([rawAlias('kant', { poll_timeout_seconds: 30, poll_lease_ms: 35_000 })]);
    expect(firstAlias(ok).poll_lease_ms).toBe(35_000);
  });

  it('rechaza un alias con tenant inválido y un nombre de alias fuera del patrón', () => {
    expect(() => buildConfig([rawAlias('kant', { tenant_id: '123-mal' })])).toThrow();
    expect(() => buildConfig([rawAlias('Kant_Mayus')])).toThrow('alias is invalid');
  });

  it('rechaza token_file / v2_shutdown_marker_file que no son absolutos', () => {
    expect(() => buildConfig([rawAlias('kant', { token_file: 'relativo/token' })]))
      .toThrow('token_file must be absolute');
    expect(() => buildConfig([rawAlias('kant', { v2_shutdown_marker_file: 'relativo/marker' })]))
      .toThrow('v2_shutdown_marker_file must be absolute');
  });

  it('rechaza un bot_username fuera del patrón de Telegram y exige unicidad case-insensitive', () => {
    expect(() => buildConfig([
      rawAlias('kant', { bot_username: 'no-empieza-con-letra1' })
    ])).toThrow('bot_username is invalid');
    expect(() => buildConfig([
      rawAlias('kant', { bot_username: 'kant_bot', chats: [] }),
      rawAlias('argos', { bot_username: 'Kant_Bot', chats: [] })
    ])).toThrow('bot_username values must be unique');
  });

  it('rechaza duplicados de alias y de ambient host en el mismo (chat, thread)', () => {
    expect(() => buildConfig([rawAlias('kant'), rawAlias('kant')])).toThrow('alias names must be unique');
    expect(() => buildConfig([
      rawAlias('kant', { bot_username: 'kant_bot', chats: [{ chat_id: CHAT_ID, mode: 'always' }] }),
      rawAlias('argos', { bot_username: 'argos_bot', chats: [{ chat_id: CHAT_ID, mode: 'always' }] })
    ])).toThrow('at most one alias may answer unaddressed messages');
  });

  it('rechaza un chat_id de chats[] que no está en allowed_chat_ids', () => {
    expect(() => buildConfig([rawAlias('kant', {
      bot_username: 'kant_bot',
      chats: [{ chat_id: '-99999', mode: 'always' }]
    })])).toThrow('chats[].chat_id must be listed in allowed_chat_ids');
  });

  it('rechaza que el chat_id de chats[] sea positivo (es un DM, no un grupo)', () => {
    expect(() => buildConfig([rawAlias('kant', {
      bot_username: 'kant_bot',
      allowed_chat_ids: ['12345'],
      chats: [{ chat_id: '12345', mode: 'always' }]
    })])).toThrow('chats[].chat_id is invalid');
  });

  it('rechaza default_alias que apunta a un alias distinto del dueño', () => {
    expect(() => buildConfig([rawAlias('kant', { bot_username: 'kant_bot', chats: [{
      chat_id: CHAT_ID, mode: 'mention', default_alias: 'otros'
    }] })])).toThrow('default_alias must name the alias that declares it');
  });

  it('rechaza mode:"off" combinado con default_alias poblado (en chats y en threads)', () => {
    expect(() => buildConfig([rawAlias('kant', { bot_username: 'kant_bot', chats: [{
      chat_id: CHAT_ID, mode: 'off', default_alias: 'kant'
    }] })])).toThrow('default_alias cannot be set while mode is off');
    expect(() => buildConfig([rawAlias('kant', { bot_username: 'kant_bot', chats: [{
      chat_id: CHAT_ID, mode: 'mention', threads: [{ thread_id: '42', mode: 'off', default_alias: 'kant' }]
    }] })])).toThrow('default_alias cannot be set while mode is off');
  });

  it('rechaza threads[].allowed_user_ids que no es subconjunto de chats[].allowed_user_ids', () => {
    expect(() => buildConfig([rawAlias('kant', { bot_username: 'kant_bot', chats: [{
      chat_id: CHAT_ID, mode: 'always', allowed_user_ids: ['101'], threads: [{ thread_id: '42', allowed_user_ids: ['999'] }]
    }] })])).toThrow('must be a subset of allowed_user_ids');
  });

  it('exige bot_username a partir del momento en que un alias declara chats no vacío', () => {
    expect(() => buildConfig([rawAlias('kant', { chats: [{ chat_id: CHAT_ID, mode: 'always' }] })]))
      .toThrow('must declare bot_username because it declares chats');
    const ok = buildConfig([rawAlias('kant', { bot_username: 'kant_bot', chats: [{ chat_id: CHAT_ID, mode: 'always' }] })]);
    expect(firstAlias(ok).bot_username).toBe('kant_bot');
  });
});

describe('lectura de filesystem: loadTelegramBridgeConfig / readTelegramToken / assertV2PollerDisabled', () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'telegram-bridge-config-'));
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  function aliasConPaths(overrides: Record<string, unknown> = {}): TelegramAliasConfig {
    return firstAlias(buildConfig([rawAlias('kant', {
      token_file: join(workdir, 'kant.token'),
      v2_shutdown_marker_file: join(workdir, 'kant.marker'),
      ...overrides
    })]));
  }

  it('loadTelegramBridgeConfig rechaza rutas que no son absolutas', async () => {
    await expect(loadTelegramBridgeConfig('relativo/config.json'))
      .rejects.toThrow('CAUCE_TELEGRAM_CONFIG_FILE must be absolute');
  });

  it('loadTelegramBridgeConfig parsea el JSON de disco', async () => {
    const path = join(workdir, 'config.json');
    await writeFile(path, JSON.stringify({ aliases: [rawAlias('kant')] }), 'utf8');
    const config = await loadTelegramBridgeConfig(path);
    expect(firstAlias(config).alias).toBe('kant');
  });

  it('readTelegramToken acepta un archivo 0600 con el formato canónico de Telegram', async () => {
    const path = join(workdir, 'token');
    await writeFile(path, '7482913055:AAH3kZq9_LmN4pQ7rS2tU5vW8xY1zA3bC4d\n', 'utf8');
    await chmod(path, 0o600);
    const token = await readTelegramToken(path);
    expect(token).toBe('7482913055:AAH3kZq9_LmN4pQ7rS2tU5vW8xY1zA3bC4d');
  });

  it('readTelegramToken rechaza permisos que no son 0600 y enlaces simbólicos', async () => {
    const path = join(workdir, 'token');
    await writeFile(path, '7482913055:AAH3kZq9_LmN4pQ7rS2tU5vW8xY1zA3bC4d', 'utf8');
    await chmod(path, 0o644);
    await expect(readTelegramToken(path)).rejects.toThrow('permissions must be 0600');

    const target = join(workdir, 'real-token');
    await writeFile(target, '7482913055:AAH3kZq9_LmN4pQ7rS2tU5vW8xY1zA3bC4d', 'utf8');
    await chmod(target, 0o600);
    const link = join(workdir, 'token-link');
    await symlink(target, link);
    await expect(readTelegramToken(link)).rejects.toThrow('regular file');
  });

  it('readTelegramToken rechaza contenido que no cumple la regex', async () => {
    const path = join(workdir, 'token');
    await writeFile(path, 'esto-no-es-un-token', 'utf8');
    await chmod(path, 0o600);
    await expect(readTelegramToken(path)).rejects.toThrow('is invalid');
  });

  it('readTelegramToken rechaza archivos vacíos después del trim', async () => {
    const path = join(workdir, 'token');
    await writeFile(path, '   \n', 'utf8');
    await chmod(path, 0o600);
    await expect(readTelegramToken(path)).rejects.toThrow('is invalid');
  });

  it('assertV2PollerDisabled exige un marker con permisos 0600 y contenido exacto', async () => {
    const alias = aliasConPaths();
    await writeFile(alias.v2_shutdown_marker_file, `v2-poller-disabled:${alias.alias}\n`, 'utf8');
    await chmod(alias.v2_shutdown_marker_file, 0o600);
    await assertV2PollerDisabled(alias);

    await writeFile(alias.v2_shutdown_marker_file, 'v2-poller-disabled:otro\n', 'utf8');
    await chmod(alias.v2_shutdown_marker_file, 0o600);
    await expect(assertV2PollerDisabled(alias)).rejects.toThrow('not confirmed');
  });

  it('assertV2PollerDisabled acepta 0640 (read para grupo/otros está permitido; solo se vetan escrituras)', async () => {
    const alias = aliasConPaths();
    await writeFile(alias.v2_shutdown_marker_file, `v2-poller-disabled:${alias.alias}`, 'utf8');
    await chmod(alias.v2_shutdown_marker_file, 0o640);
    await assertV2PollerDisabled(alias);
  });

  it('assertV2PollerDisabled rechaza marker con escritura para grupo o para otros', async () => {
    const alias = aliasConPaths();
    await writeFile(alias.v2_shutdown_marker_file, `v2-poller-disabled:${alias.alias}`, 'utf8');

    // Group write: 0o660.
    await chmod(alias.v2_shutdown_marker_file, 0o660);
    await expect(assertV2PollerDisabled(alias)).rejects.toThrow('not a protected regular file');

    // Other write: 0o606.
    await chmod(alias.v2_shutdown_marker_file, 0o606);
    await expect(assertV2PollerDisabled(alias)).rejects.toThrow('not a protected regular file');
  });

  it('assertV2PollerDisabled rechaza enlaces simbólicos hacia el marker', async () => {
    const alias = aliasConPaths();
    const real = join(workdir, 'real-marker');
    await writeFile(real, `v2-poller-disabled:${alias.alias}`, 'utf8');
    await chmod(real, 0o600);
    await symlink(real, alias.v2_shutdown_marker_file);
    await expect(assertV2PollerDisabled(alias)).rejects.toThrow('not a protected regular file');
  });
});