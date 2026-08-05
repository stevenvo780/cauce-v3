import type { TelegramChatPolicy, TelegramEntity, TelegramMessage, TelegramUser } from './types.js';

/**
 * Pure, deterministic addressing resolver.
 *
 * Telegram delivers every group update to every bot whose privacy mode is OFF. There is no
 * coordination point, so each poller has to decide locally whether the update was meant for it.
 * This module is that decision and nothing else: no I/O, no clock, no Postgres, no network.
 *
 * The decision is a function of (message, self, fleet directory, chat policy, chat participants).
 * All of them are stable for a given update and deployment, which is what lets the caller put the
 * outcome inside the idempotent publish payload without making the request hash time dependent.
 */

/** Lowercased Telegram usernames and live bot ids of the whole fleet, mapped to their alias. */
export interface FleetDirectory {
  readonly byUsername: ReadonlyMap<string, string>;
  readonly byBotId: ReadonlyMap<string, string>;
}

export interface AddressingSelf {
  /** Telegram bot id as a string. `getMe` returns a number; the bridge normalises to string. */
  readonly bot_id: string;
  readonly alias: string;
  readonly tenant_id: string;
  readonly username?: string | undefined;
}

/**
 * How this alias treats group chats.
 *
 * `legacy` is the pre-routing behaviour: the alias never declared a `chats` block, so every group
 * listed in `allowed_chat_ids` keeps publishing exactly as it does today. `scoped` is the opt-in
 * default-deny mode: only chats with an explicit entry are served. Keeping `legacy` reachable is
 * what makes a code-before-config rollout safe — new code alone can never mute a live group.
 */
export type GroupRouting = 'legacy' | 'scoped';

export interface AddressingInput {
  readonly message: TelegramMessage;
  readonly self: AddressingSelf;
  readonly fleet: FleetDirectory;
  readonly policy?: TelegramChatPolicy | undefined;
  /** Defaults to `scoped`, so a caller that forgets the flag can never widen the deny rules. */
  readonly groupRouting?: GroupRouting | undefined;
  /**
   * Aliases that can actually answer in THIS (chat, thread).
   *
   * Echo suppression (P3) must be scoped to them: suppressing against the whole file makes a
   * mention of an alias that is absent from the group silence every bot present in it.
   * `undefined` disables the narrowing and treats every fleet alias as able to answer.
   */
  readonly participants?: ReadonlySet<string> | undefined;
}

export type AddressingReason =
  | 'private' | 'legacy' | 'mention' | 'command' | 'reply' | 'always' | 'default_alias';

export type SuppressionReason =
  | 'no_author' | 'bot_author' | 'via_bot' | 'anonymous_sender'
  | 'chat_not_configured' | 'chat_not_allowed' | 'chat_disabled' | 'user_denied'
  | 'other_bot_mentioned' | 'foreign_mention' | 'other_bot_replied'
  | 'mention_unserved' | 'not_addressed';

/**
 * Coarse reason that is stable across reprocessing of the same update.
 *
 * `always` and `default_alias` collapse into `ambient` on purpose: both depend on the deployed
 * config. Only the bucket is allowed into the publish payload, because that payload is hashed for
 * idempotency (packages/store/src/repository.ts requestHash) and a value that can change between
 * two attempts at the same update_id would wedge the poller forever.
 */
export type AddressingBucket = 'private' | 'legacy' | 'mention' | 'command' | 'reply' | 'ambient';

export type AddressingDecision =
  | {
      readonly addressed: true;
      readonly reason: AddressingReason;
      readonly bucket: AddressingBucket;
      readonly thread_id: string;
    }
  | { readonly addressed: false; readonly reason: SuppressionReason; readonly thread_id: string };

/**
 * Budget for the entities that actually take part in addressing.
 *
 * It deliberately does NOT count decorative entities (bold, italic, code, url, custom_emoji…):
 * counting those made an ordinary formatted message push a real `@bot` mention past the budget,
 * which lost the mention and — with an ambient host configured — handed the answer to the wrong
 * bot. `MAX_INSPECTED_ENTITIES` keeps the CPU bound; Telegram itself tops out around 100.
 */
const MAX_SCANNED_ENTITIES = 16;
const MAX_INSPECTED_ENTITIES = 512;
const ADDRESSING_ENTITY_TYPES = new Set(['mention', 'text_mention', 'bot_command']);
const USERNAME_PATTERN = /^[a-z0-9_]{1,32}$/;

function positiveId(value: unknown): string | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? String(value) : undefined;
}

/**
 * Topic id for the message, or '0' when it is not a topic message.
 *
 * Telegram also sets `message_thread_id` on plain replies inside groups without topics, so the
 * `is_topic_message` guard is required. The value goes into the session hash and into durable
 * jsonb, so it is validated as a positive safe integer instead of being stringified blindly.
 */
export function telegramThreadId(message: TelegramMessage): string {
  return (message.is_topic_message === true ? positiveId(message.message_thread_id) : undefined) ?? '0';
}

interface MentionScan {
  /** Lowercased usernames from `mention` entities. */
  readonly mentionUsernames: Set<string>;
  /** Lowercased usernames from the `@suffix` of `bot_command` entities. */
  readonly commandUsernames: Set<string>;
  /** Bot/user ids from `text_mention` entities. */
  readonly mentionUserIds: Set<string>;
  /** A `/command` with no `@suffix` was present. */
  bareCommand: boolean;
  /** The first ADDRESSING entity of the message is a mention anchored at offset 0. */
  leadingMention: boolean;
  scanned: number;
  inspected: number;
  sawEntity: boolean;
}

function emptyScan(): MentionScan {
  return {
    mentionUsernames: new Set(),
    commandUsernames: new Set(),
    mentionUserIds: new Set(),
    bareCommand: false,
    leadingMention: false,
    scanned: 0,
    inspected: 0,
    sawEntity: false
  };
}

function normalizedUsername(value: string): string | undefined {
  const lowered = value.toLowerCase();
  return USERNAME_PATTERN.test(lowered) ? lowered : undefined;
}

/**
 * Telegram entity offsets are UTF-16 code units, which is exactly what `String.prototype.slice`
 * operates on. Cutting over the raw string (never over a normalised or truncated copy) is what
 * keeps '🙂🙂 @jarvis' routing to jarvis instead of to a shifted substring.
 */
function scanEntities(
  text: string | undefined,
  entities: readonly TelegramEntity[] | undefined,
  scan: MentionScan
): void {
  if (typeof text !== 'string' || !Array.isArray(entities)) return;
  // Array.isArray degrada un `readonly T[]` a `any[]`, así que se reafirma el tipo declarado.
  // El contenido sigue siendo dato de red no confiable y cada campo se valida abajo igual.
  for (const entity of entities as readonly TelegramEntity[]) {
    if (scan.scanned >= MAX_SCANNED_ENTITIES || scan.inspected >= MAX_INSPECTED_ENTITIES) return;
    scan.inspected += 1;
    if (entity === null || typeof entity !== 'object' || typeof entity.type !== 'string') continue;
    // Decorative entities are skipped before the budget is charged: a bold run or a custom emoji
    // must never be able to hide a mention that appears after it.
    if (!ADDRESSING_ENTITY_TYPES.has(entity.type)) continue;
    const { offset, length } = entity;
    if (!Number.isSafeInteger(offset) || offset < 0) continue;
    if (!Number.isSafeInteger(length) || length < 1) continue;
    if (offset + length > text.length) continue;
    const first = !scan.sawEntity;
    scan.sawEntity = true;
    scan.scanned += 1;
    if (entity.type === 'mention') {
      const raw = text.slice(offset, offset + length);
      if (!raw.startsWith('@')) continue;
      const username = normalizedUsername(raw.slice(1));
      if (username !== undefined) scan.mentionUsernames.add(username);
      if (first && offset === 0) scan.leadingMention = true;
      continue;
    }
    if (entity.type === 'text_mention') {
      const mentioned = positiveId(entity.user?.id);
      if (mentioned !== undefined) scan.mentionUserIds.add(mentioned);
      if (first && offset === 0) scan.leadingMention = true;
      continue;
    }
    if (entity.type === 'bot_command') {
      const raw = text.slice(offset, offset + length);
      const at = raw.indexOf('@');
      if (at < 0) {
        scan.bareCommand = true;
        continue;
      }
      const username = normalizedUsername(raw.slice(at + 1));
      if (username !== undefined) scan.commandUsernames.add(username);
    }
  }
}

function scanMentions(message: TelegramMessage): MentionScan {
  const scan = emptyScan();
  scanEntities(message.text, message.entities, scan);
  scanEntities(message.caption, message.caption_entities, scan);
  return scan;
}

function aliasesFor(
  usernames: ReadonlySet<string>,
  userIds: ReadonlySet<string>,
  self: AddressingSelf,
  fleet: FleetDirectory
): Set<string> {
  const result = new Set<string>();
  const selfUsername = self.username?.toLowerCase();
  for (const username of usernames) {
    const alias = fleet.byUsername.get(username);
    if (alias !== undefined) result.add(alias);
    else if (selfUsername !== undefined && username === selfUsername) result.add(self.alias);
  }
  for (const userId of userIds) {
    const alias = fleet.byBotId.get(userId);
    if (alias !== undefined) result.add(alias);
    else if (userId === self.bot_id) result.add(self.alias);
  }
  return result;
}

/**
 * True when the author of the replied-to message is another bot of this fleet.
 *
 * Deliberately keyed on the config-derived username map only: `byBotId` is populated from the
 * `getMe` of the aliases started in *this* process, so keying on it would make the value depend
 * on CAUCE_TELEGRAM_ALIASES and therefore on the deployment, not on the update.
 */
export function isFleetBot(user: TelegramUser | undefined, fleet: FleetDirectory): boolean {
  if (user === undefined || user.is_bot !== true) return false;
  const username = typeof user.username === 'string' ? user.username.toLowerCase() : undefined;
  return username !== undefined && fleet.byUsername.has(username);
}

export function addressingBucket(reason: AddressingReason): AddressingBucket {
  if (reason === 'always' || reason === 'default_alias') return 'ambient';
  return reason;
}

/**
 * A private one-to-one chat.
 *
 * `parseUpdate` validates nothing inside `message`, so `chat.type` is untrusted and may be absent.
 * Telegram private chat ids are always positive, so a missing/garbled type over a positive id is
 * still treated as private: the legacy `allowed()` filter never looked at `chat.type` and a DM
 * must not become deniable because of a field the bridge does not control.
 */
function isPrivateChat(message: TelegramMessage): boolean {
  const type = message.chat?.type;
  if (type === 'private') return true;
  return typeof type !== 'string' && Number.isSafeInteger(message.chat?.id) && Number(message.chat?.id) > 0;
}

/**
 * Precedence table. The first rule that fires wins.
 *
 *  P0.a  no usable author id                     -> deny  no_author
 *  P0.b  private chat                            -> ALLOW private   (legacy semantics, untouched)
 *  P0.b2 group + alias never declared `chats`    -> ALLOW legacy    (rollout escape hatch)
 *  P0.c  sender_chat present (anonymous/channel) -> deny  anonymous_sender
 *  P0.d  from.is_bot (groups only)               -> deny  bot_author       <- anti-echo guard
 *  P0.d2 via_bot (groups only)                   -> deny  via_bot
 *  P0.e  no policy for this group                -> deny  chat_not_configured
 *  P0.f  user outside the per-chat allowlist     -> deny  user_denied
 *  P1    policy.mode === 'off'                   -> deny  chat_disabled
 *  P2    self is a mentioned fleet member        -> ALLOW mention | command
 *  P3    a fleet member that SERVES this scope
 *        is mentioned                            -> deny  other_bot_mentioned  <- echo suppression
 *  P4    message opens with a foreign mention     -> deny  foreign_mention
 *  P5    reply to a message this bot sent         -> ALLOW reply
 *  P6    reply to another fleet bot's message     -> deny  other_bot_replied
 *  P7    policy.mode === 'always'                 -> ALLOW always
 *  P8    bare /command and self is the host       -> ALLOW command
 *  P9    self is the host of the scope            -> ALLOW default_alias
 *  P10   otherwise                                -> deny  not_addressed | mention_unserved
 *
 * P0.b sits before the bot-author guard on purpose. Today's poller never inspects `is_bot` or
 * `via_bot`, so applying the guard to private chats would silently drop DMs a human sent through
 * an inline bot. Private chats therefore keep byte-identical behaviour.
 *
 * P0.b2 exists so that shipping this code before the config can never mute a live group: an alias
 * that has not opted into `chats` keeps answering exactly as it does today.
 *
 * P3 only fires against aliases in `participants`. A mention of a fleet alias that cannot answer
 * in this scope must not silence the ones that can; the message falls through to the ambient host
 * and, if nothing claims it, is reported as `mention_unserved` rather than a plain silence.
 *
 * There is no continuity floor. An earlier draft documented P8/P9 turn-taking, but no caller ever
 * produced a floor holder, so the rules were unreachable: a precedence table that lies about who
 * speaks is worse than one that is merely conservative.
 */
export function resolveAddressing(input: AddressingInput): AddressingDecision {
  const { message, self, fleet, policy, participants } = input;
  const threadId = telegramThreadId(message);
  const deny = (reason: SuppressionReason): AddressingDecision =>
    ({ addressed: false, reason, thread_id: threadId });
  const allow = (reason: AddressingReason): AddressingDecision =>
    ({ addressed: true, reason, bucket: addressingBucket(reason), thread_id: threadId });

  // P0.a
  const authorId = positiveId(message.from?.id);
  if (authorId === undefined) return deny('no_author');

  // P0.b — private chats keep the exact legacy semantics of poller.allowed().
  if (isPrivateChat(message)) {
    return { addressed: true, reason: 'private', bucket: 'private', thread_id: '0' };
  }

  // P0.b2 — the alias never opted into group routing: keep the pre-routing behaviour verbatim.
  // Everything below (anti-echo, default-deny, addressing) is the opt-in half of the feature.
  if ((input.groupRouting ?? 'scoped') === 'legacy' && policy === undefined) {
    return { addressed: true, reason: 'legacy', bucket: 'legacy', thread_id: '0' };
  }

  // P0.c
  if (message.sender_chat !== undefined) return deny('anonymous_sender');
  // P0.d / P0.d2 — split so the anti-echo signal is not polluted by legitimate inline-bot use.
  if (message.from?.is_bot === true) return deny('bot_author');
  if (message.via_bot !== undefined) return deny('via_bot');
  // P0.e — default-deny for every group without an explicit policy.
  if (policy === undefined) return deny('chat_not_configured');
  // P0.f
  if (policy.allowed_user_ids !== undefined && !policy.allowed_user_ids.includes(authorId)) {
    return deny('user_denied');
  }
  // P1
  if (policy.mode === 'off') return deny('chat_disabled');

  const scan = scanMentions(message);
  const mentioned = aliasesFor(scan.mentionUsernames, scan.mentionUserIds, self, fleet);
  const commanded = aliasesFor(scan.commandUsernames, new Set<string>(), self, fleet);
  const targets = new Set<string>([...mentioned, ...commanded]);

  // P2
  if (targets.has(self.alias)) {
    return allow(mentioned.has(self.alias) ? 'mention' : 'command');
  }
  // P3 — narrowed to the aliases that actually serve this (chat, thread).
  const served = participants === undefined
    ? targets.size > 0
    : [...targets].some((alias) => participants.has(alias));
  if (served) return deny('other_bot_mentioned');
  // P4 — only when nothing fleet-shaped was named; an unserved fleet mention keeps falling through.
  if (targets.size === 0 && scan.leadingMention) return deny('foreign_mention');

  // P5
  const replyFrom = message.reply_to_message?.from;
  if (positiveId(replyFrom?.id) === self.bot_id) return allow('reply');
  // P6
  if (isFleetBot(replyFrom, fleet)) return deny('other_bot_replied');

  // P7
  if (policy.mode === 'always') return allow('always');
  // P8
  if (scan.bareCommand && policy.default_alias === self.alias) return allow('command');
  // P9
  if (policy.default_alias === self.alias) return allow('default_alias');
  // P10
  return deny(targets.size > 0 ? 'mention_unserved' : 'not_addressed');
}
