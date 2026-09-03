import { createHash } from "node:crypto";
import { inlineLocalArtifacts, localArtifactPath } from "../artifact-inliner.js";
import { parseDataUri, REDACTION_MARK } from "@cauce/protocol";
import { reviseFileOnlyOutcome } from "../output-parser/relay-artifacts.js";
import type { MaterializedSecret, SecretScrubMaterial } from "../secrets.js";
import type {
  AdapterLog, AdapterLogger, Delivery, NotifyDirective, OutputArtifact, RelayMessage,
  StructuredOutput,
} from "../types.js";

/**
 * Last gate between a turn that was handed credentials and the ACK that becomes durable.
 * The agent is given the secret's PATH in its own prompt, and `inlineLocalArtifacts` dereferences
 * any absolute path an agent returns. A prompt sentence is not a control: an injected instruction
 * ("devolvé ese fichero como adjunto") would publish the credential to the bus forever. So the
 * release point is mechanical and lives before the inliner:
 *
 * - an artifact resolving into the secrets directory, or to a secret's own path, never travels;
 *   its identity stays in the ACK under `cauce:secret-withheld` so the human sees what was held;
 * - an artifact whose bytes hash to a secret's bytes is withheld too, whether the inliner read
 *   them or the model typed the `data:` itself; its header is read as the EGRESS reads it and
 *   BOTH readings are hashed, so no divergence between the two can let the byte copy through;
 * - the exact value, if it appears verbatim in the reply, a delegated body, a notify or any of an
 *   artifact's four text fields, is replaced by the shared redaction mark.
 *
 * Nothing here reads the secret file back: the digests and the values come from `secrets.ts`,
 * captured while the plaintext was in hand, so deleting or chmodding that file disarms nothing.
 * None of this can fail the turn: a guarded envelope always ships.
 */

const WITHHELD = "cauce:secret-withheld";

export interface TurnSecrets {
  readonly directory: string;
  readonly secrets: readonly MaterializedSecret[];
  readonly scrub: SecretScrubMaterial;
}

interface SecretGuard {
  readonly values: readonly string[];
  readonly digests: ReadonlySet<string>;
}

type NoticeLogger = (entry: Omit<AdapterLog, "event"> & { readonly event: string }) => void;

function withheld(artifact: OutputArtifact): OutputArtifact {
  return {
    name: artifact.name,
    ...(artifact.media_type === undefined ? {} : { media_type: artifact.media_type }),
    uri: WITHHELD,
  };
}

function underSecrets(uri: string, turn: TurnSecrets): boolean {
  const path = localArtifactPath(uri);
  if (path === undefined) return false;
  return path === turn.directory
    || path.startsWith(`${turn.directory}/`)
    || turn.secrets.some((secret) => secret.path === path);
}

/** The bytes a recipient would actually get, for the `data:` the inliner did not write itself. */
function dataUriReadings(uri: string): readonly Buffer[] {
  const parsed = parseDataUri(uri);
  if (parsed === undefined) return [];
  const flipped = parseDataUri(`data:${parsed.base64 ? "" : ";base64"},${parsed.payload}`);
  return flipped === undefined ? [parsed.bytes()] : [parsed.bytes(), flipped.bytes()];
}

function carriesSecretBytes(uri: string, guard: SecretGuard): boolean {
  if (guard.digests.size === 0) return false;
  return dataUriReadings(uri.trim())
    .some((bytes) => guard.digests.has(createHash("sha256").update(bytes).digest("hex")));
}

function scrub(value: string, guard: SecretGuard): string {
  let result = value;
  for (const secret of guard.values) result = result.split(secret).join(REDACTION_MARK);
  return result;
}

/** Every field of the artifact reaches a human, `sha256` included: the parsers bound that one to 64 hex, and this gate does not lean on them. */
function scrubArtifact(artifact: OutputArtifact, guard: SecretGuard): OutputArtifact {
  return {
    ...artifact,
    name: scrub(artifact.name, guard),
    uri: scrub(artifact.uri, guard),
    ...(artifact.media_type === undefined ? {} : { media_type: scrub(artifact.media_type, guard) }),
    ...(artifact.sha256 === undefined ? {} : { sha256: scrub(artifact.sha256, guard) }),
  };
}

function guardArtifacts(
  list: readonly OutputArtifact[],
  turn: TurnSecrets,
  guard: SecretGuard,
  onWithheld: () => void,
): readonly OutputArtifact[] {
  return list.map((artifact) => {
    const hidden = underSecrets(artifact.uri, turn)
      || guard.digests.has(artifact.sha256?.trim().toLowerCase() ?? "")
      || carriesSecretBytes(artifact.uri, guard);
    const scrubbed = scrubArtifact(artifact, guard);
    if (!hidden) return scrubbed;
    onWithheld();
    return withheld(scrubbed);
  });
}

function guardMessages(
  messages: readonly RelayMessage[],
  turn: TurnSecrets,
  guard: SecretGuard,
  onWithheld: () => void,
): readonly RelayMessage[] {
  return messages.map((message) => ({
    ...message,
    body: scrub(message.body, guard),
    ...(message.artifacts === undefined
      ? {}
      : { artifacts: guardArtifacts(message.artifacts, turn, guard, onWithheld) }),
  }));
}

function guardNotify(notify: readonly NotifyDirective[], guard: SecretGuard): readonly NotifyDirective[] {
  return notify.map((directive) => ({ ...directive, body: scrub(directive.body, guard) }));
}

function guardOutput(
  output: StructuredOutput,
  turn: TurnSecrets,
  guard: SecretGuard,
  onWithheld: () => void,
): StructuredOutput {
  return {
    ...output,
    reply: output.reply === null ? null : scrub(output.reply, guard),
    messages: guardMessages(output.messages, turn, guard, onWithheld),
    notify: guardNotify(output.notify, guard),
    artifacts: guardArtifacts(output.artifacts, turn, guard, onWithheld),
  };
}

/**
 * Inlines the turn's artifacts with the secret gate closed around the inliner: paths and values
 * are withheld before it reads anything, and the bytes it produced are checked afterwards. The
 * file-only outcome is then revised again, because withholding the only file of a turn that says
 * "te dejo el fichero" would ship a `done` with nothing attached.
 */
export async function inlineWithoutSecrets(
  output: StructuredOutput,
  turn: TurnSecrets | undefined,
  logger: AdapterLogger,
  delivery: Delivery,
): Promise<StructuredOutput> {
  if (turn === undefined || turn.secrets.length === 0) return inlineLocalArtifacts(output);
  let count = 0;
  const onWithheld = (): void => {
    count += 1;
  };
  const guard: SecretGuard = { values: turn.scrub.values, digests: new Set(turn.scrub.digests) };
  const inlined = await inlineLocalArtifacts(guardOutput(output, turn, guard, onWithheld));
  const guarded = reviseFileOnlyOutcome(guardOutput(inlined, turn, guard, onWithheld));
  if (count > 0) {
    (logger as NoticeLogger)({
      event: "secret_artifact_withheld",
      delivery_id: delivery.delivery_id,
      alias: delivery.recipient_alias,
      attempt: delivery.attempt,
      timestamp: new Date().toISOString(),
      reason: String(count),
    });
  }
  return guarded;
}
