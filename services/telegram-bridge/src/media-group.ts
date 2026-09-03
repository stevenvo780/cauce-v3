import { AttachmentsV1Schema, MAX_ATTACHMENTS_PER_MESSAGE } from '@cauce/protocol';
import { prepareTelegramAttachments } from './attachments.js';
import {
  conversationId, screenAttachments,
  type AttachmentScreenMeta, type PreparedAttachments
} from './ingress-body.js';
import type { TelegramApi, TelegramMessage, TelegramUpdate } from './types.js';

/* Album coalescing and classification of the update kinds the poller does not serve.

   An album is N updates sharing a `media_group_id`, at most one carrying the caption: published one by one they cost
   N deliveries and N model turns, and in `mention` mode the uncaptioned members are addressed to nobody and die as
   `updates_unaddressed`.

   THE HARD PART IS THE CURSOR. `getUpdates` advances a durable, destructive offset: past it an update can never be
   requested again, so a buffered member holds the offset where it is until the coalesced message is durably
   published. There is no "flush and forget": either the batch reaches `publish` and only then does the cursor move,
   or the buffer is DISCARDED (shutdown, fence loss, poll error) and the un-advanced cursor makes Telegram re-deliver
   the whole album. Duplicates are caught by the content-free idempotency key; losses are caught by nothing. */

export const MEDIA_GROUP_DEBOUNCE_MS = 1_500;
export const MAX_MEDIA_GROUP_MEMBERS = MAX_ATTACHMENTS_PER_MESSAGE;

export type UpdateKind =
  | 'message' | 'edited_message' | 'channel_post' | 'edited_channel_post' | 'unknown';

/* `getUpdates` asks for `message` only, but the subscription is server-side state a webhook or
   another deployment can widen: naming the kind stops the extras from vanishing. */
export function updateKind(update: TelegramUpdate): UpdateKind {
  if (update.message !== undefined) return 'message';
  if (update.edited_message !== undefined) return 'edited_message';
  if (update.channel_post !== undefined) return 'channel_post';
  if (update.edited_channel_post !== undefined) return 'edited_channel_post';
  return 'unknown';
}

export function updateMessage(update: TelegramUpdate): TelegramMessage | undefined {
  return update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post;
}

/** `chat` is declared by the wire type but arrives unvalidated, so it is read as optional. */
export function messageChatId(message: TelegramMessage): string | undefined {
  return conversationId((message as { chat?: { id?: unknown } }).chat?.id);
}

export function mediaGroupId(update: TelegramUpdate): string | undefined {
  const raw = update.message?.media_group_id;
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 128 ? raw : undefined;
}

/* `normalizedBody` reads `text` first and truncates it at 4096 characters, the caption at 1024: Telegram's own
   limits, and the bound a fold of several captions has to respect or it discards the tail in silence. */
const MAX_TEXT_CHARACTERS = 4_096;
const MAX_CAPTION_CHARACTERS = 1_024;

/** What the member says on its own: the text of a plain message, the caption of a media one. */
function typedText(message: TelegramMessage | undefined): string | undefined {
  const text = typeof message?.text === 'string' && message.text.trim().length > 0
    ? message.text : undefined;
  const caption = typeof message?.caption === 'string' && message.caption.trim().length > 0
    ? message.caption : undefined;
  return text ?? caption;
}

function addressable(message: TelegramMessage | undefined): boolean {
  return typedText(message) !== undefined;
}

/* The member the addressing resolver must judge: the caption carries the mention, and judging an
   uncaptioned member would suppress the whole album. */
export function captionMember(batch: readonly TelegramUpdate[]): TelegramUpdate | undefined {
  return batch.find((entry) => addressable(entry.message)) ?? batch[0];
}

/** One member the album does not carry, paired with the verdict its caller has to audit. */
export interface RefusedMember<Reason> {
  readonly update: TelegramUpdate;
  readonly reason: Reason;
}

/**
 * Splits a batch into the members of the album and the ones that only claim to be, by ONE rule: `judge`, run on
 * every member except the primary against that member's OWN message, answering the refusal to audit or `undefined`
 * when the member belongs. `AlbumKey` states the rule and why the same one has to govern the batch boundary.
 */
export function splitOwnMembers<Reason>(
  batch: readonly TelegramUpdate[],
  primary: TelegramUpdate,
  judge: (update: TelegramUpdate) => Reason | undefined
): { readonly own: readonly TelegramUpdate[]; readonly refused: readonly RefusedMember<Reason>[] } {
  const own: TelegramUpdate[] = [];
  const refused: RefusedMember<Reason>[] = [];
  for (const entry of batch) {
    const reason = entry === primary ? undefined : judge(entry);
    if (reason === undefined) own.push(entry);
    else refused.push({ update: entry, reason });
  }
  return { own, refused };
}

/**
 * The one membership rule of an album, applied on both sides of the batch boundary.
 *
 * An album goes up to 10 members and a batch holds MAX_MEDIA_GROUP_MEMBERS, so members 5-N arrive as an IMMEDIATE
 * continuation whose `captionMember` falls back to an UNCAPTIONED member: judged alone it is addressed to nobody and
 * dies as `updates_unaddressed`, the loss this coalescer exists to remove, moved past the batch boundary. ONLY that
 * immediate continuation is covered: one album is held and any unrelated update between the halves clears it.
 *
 * `media_group_id` is NOT an authorization: it arrives in the same unvalidated payload as everything else, so it is
 * never evidence about a neighbour. A member travels under the primary's frame only if it matches this key — chat,
 * user AND thread — and its own live addressing decision either admits it or refuses it for `not_addressed`, the
 * ONE refusal that means "this member wrote nothing of its own" and the only one an uncaptioned member cannot
 * avoid. Thread policy, `sender_chat`, `via_bot`, `from.is_bot` and a caption addressed to another fleet alias
 * therefore judge EVERY member on its own message: inside the batch through `splitOwnMembers`, across it through
 * `recall`, which answers that same forgivable refusal and nothing else. Whatever the rule rejects is audited with
 * its real reason and dropped, never published into a chat, topic or session that never received it.
 */
export interface AlbumKey {
  readonly id: string | undefined;
  readonly chatId: string;
  readonly userId: string;
  readonly threadId: string;
}

export class AlbumAddressing<Decision> {
  private held: { readonly key: AlbumKey; readonly decision: Decision } | undefined;

  recall(key: AlbumKey): Decision | undefined {
    const held = this.held;
    if (key.id === undefined || held === undefined) return undefined;
    return held.key.id === key.id && held.key.chatId === key.chatId &&
      held.key.userId === key.userId && held.key.threadId === key.threadId
      ? held.decision
      : undefined;
  }

  remember(key: AlbumKey, decision: Decision): void {
    this.held = key.id === undefined ? undefined : { key, decision };
  }

  forget(): void {
    this.held = undefined;
  }
}

export function lastUpdateId(batch: readonly TelegramUpdate[]): number {
  return batch.reduce((highest, entry) => Math.max(highest, entry.update_id), 0);
}

/* Bounded coalescer, flushed by whichever comes first: a foreign update, MAX_MEDIA_GROUP_MEMBERS,
   or settling — no new member in this poll cycle, or MEDIA_GROUP_DEBOUNCE_MS elapsed. The cycle
   rule closes an album that ended a poll response: the cursor did not move, Telegram re-delivers
   it, `holds()` refuses to buffer it twice and the next cycle publishes it. */
export class MediaGroupBuffer {
  private groupId: string | undefined;
  private members: TelegramUpdate[] = [];
  private startedAt = 0;
  private cycle = 0;
  private appendedCycle = -1;

  beginCycle(): void {
    this.cycle += 1;
  }

  holds(updateId: number): boolean {
    return this.members.some((entry) => entry.update_id === updateId);
  }

  accept(update: TelegramUpdate, now: number): readonly (readonly TelegramUpdate[])[] {
    const id = mediaGroupId(update);
    if (id === undefined) return [...this.take(), [update]];
    if (this.groupId !== undefined && this.groupId !== id) {
      const flushed = this.take();
      this.start(update, id, now);
      return flushed;
    }
    if (this.groupId === undefined) {
      this.start(update, id, now);
      return [];
    }
    this.members.push(update);
    this.appendedCycle = this.cycle;
    return this.members.length >= MAX_MEDIA_GROUP_MEMBERS ? this.take() : [];
  }

  settled(now: number): readonly TelegramUpdate[] | undefined {
    if (this.members.length === 0) return undefined;
    if (this.appendedCycle === this.cycle && now - this.startedAt < MEDIA_GROUP_DEBOUNCE_MS) {
      return undefined;
    }
    return this.take()[0];
  }

  /** Drops the buffer without publishing. Safe only because the cursor never moved. */
  discard(): void {
    this.reset();
  }

  private start(update: TelegramUpdate, id: string, now: number): void {
    this.groupId = id;
    this.members = [update];
    this.startedAt = now;
    this.appendedCycle = this.cycle;
  }

  private take(): readonly (readonly TelegramUpdate[])[] {
    if (this.members.length === 0) return [];
    const batch = this.members;
    this.reset();
    return [batch];
  }

  private reset(): void {
    this.groupId = undefined;
    this.members = [];
    this.startedAt = 0;
    this.appendedCycle = -1;
  }
}

/** One member and the update it came from, so nothing downstream has to trust an array index. */
export interface MediaGroupMember {
  readonly update: TelegramUpdate;
  readonly message: TelegramMessage;
}

export interface PreparedMediaGroupMember extends MediaGroupMember {
  readonly prepared: PreparedAttachments;
}

export interface MediaGroupAttachments {
  /** The album travels as one message only if the aggregate cap admits it. */
  readonly fits: boolean;
  readonly combined: PreparedAttachments;
  /** Per member, each carrying its own update, for the individual fallback. */
  readonly members: readonly PreparedMediaGroupMember[];
}

/**
 * Pairs each update with its message, dropping any that carries none. The filtered list used to be re-indexed against
 * the batch it came from; the day the two diverged a member would have been published carrying another member's
 * bytes. There is no index left to misalign.
 */
export function batchMembers(batch: readonly TelegramUpdate[]): readonly MediaGroupMember[] {
  return batch.flatMap((update) =>
    update.message === undefined ? [] : [{ update, message: update.message }]);
}

/**
 * The primary's message carrying EVERY member's caption, in update order, or `undefined` when the join would be
 * truncated and the per-member fallback has to carry the captions whole.
 *
 * The Bot API admits a caption per album item and only the primary's used to be published: the other members' bytes
 * travelled and the instructions written on them did not, with no audit record, no metric and no way for the person
 * to know — and only when the album fit in one message, so whether a sentence reached the agent depended on the
 * aggregate byte budget. Every member here already passed the `AlbumKey` rule, so what is folded is the same chat,
 * the same user and the same topic; nothing else is merged.
 */
export function albumMessage(
  members: readonly MediaGroupMember[],
  primary: TelegramUpdate
): TelegramMessage | undefined {
  const message = members.find((member) => member.update === primary)?.message;
  if (message === undefined) return undefined;
  const captions = members.flatMap((member) => typedText(member.message) ?? []);
  if (captions.length <= 1) return message;
  const joined = captions.join('\n\n');
  const intoText = typeof message.text === 'string' && message.text.trim().length > 0;
  const limit = intoText ? MAX_TEXT_CHARACTERS : MAX_CAPTION_CHARACTERS;
  if (Array.from(joined).length > limit) return undefined;
  return intoText ? { ...message, text: joined } : { ...message, caption: joined };
}

/* Every member is downloaded and screened ONCE. `screenAttachments` drops the whole array when the
   aggregate check fails, which is right for one message and wrong for an album: four photos that
   individually fit would all be lost. Keeping the per-member results lets the poller publish them
   one by one, which is worse than one message and far better than no photos.
   Nothing is truncated here: an overflow makes `fits` false and routes the album to that per-member
   fallback, so an attachment beyond the cap is delayed into its own message, never discarded. */
export async function prepareMediaGroupAttachments(
  members: readonly MediaGroupMember[],
  api: Pick<TelegramApi, 'getFile' | 'downloadFile'>,
  updateId: number,
  meta?: AttachmentScreenMeta
): Promise<MediaGroupAttachments> {
  const prepared: PreparedMediaGroupMember[] = [];
  for (const member of members) {
    prepared.push({
      ...member,
      prepared: screenAttachments(
        await prepareTelegramAttachments(member.message, api), member.message, updateId, meta
      )
    });
  }
  const media = prepared.flatMap((entry) => entry.prepared.media);
  const errors = prepared.flatMap((entry) => entry.prepared.errors);
  const fits = media.length === 0 || AttachmentsV1Schema.safeParse(media).success;
  return { fits, combined: { media, errors }, members: prepared };
}
