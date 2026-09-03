import { rm } from "node:fs/promises";
import { materializeAttachments, type MaterializedAttachments } from "../attachments.js";
import type { DurableStore } from "../durable-store.js";
import {
  createSecretsDirectory,
  materializeSecrets,
  pendingSecretRefs,
  type FetchSealedSecret,
} from "../secrets.js";
import type { AdapterLog, AdapterLogger, Delivery } from "../types.js";
import { promptForDelivery, secretsPromptBlock } from "./delivery-context.js";
import type { TurnSecrets } from "./secret-guard.js";

/**
 * Lifetime of everything a turn materializes on disk.
 *
 * Attachments and handed-off secrets live in two SEPARATE 0700 directories, and both outlive the
 * harness invocation: they are released only after the reply has been assembled and published.
 * Deleting them earlier is what made an agent unable to return the very file it had just been
 * given — it inlines its `artifacts` from those same paths. Keeping the secrets apart is what
 * lets the release point deny a whole prefix (see `secret-guard.ts`).
 */

/** The gateway client half of the hand-off; absent until an adapter is wired with it. */
export interface SealedSecretGateway {
  readonly fetchSealedSecret: FetchSealedSecret;
}

export interface TurnInputDeps {
  readonly logger: AdapterLogger;
  readonly tenantId: string | undefined;
  readonly fetchSealedSecret: FetchSealedSecret | undefined;
}

export interface TurnInput {
  readonly prompt: string;
  readonly attachments: MaterializedAttachments | undefined;
  readonly secrets: TurnSecrets | undefined;
}

/** `AdapterLog.event` is a closed union owned by `sdk/types.ts`; notices travel widened. */
type NoticeLogger = (entry: Omit<AdapterLog, "event"> & { readonly event: string }) => void;

async function materializeTurnSecrets(
  delivery: Delivery,
  deps: TurnInputDeps,
): Promise<TurnSecrets | undefined> {
  const refs = pendingSecretRefs(delivery.body);
  if (refs.length === 0) return undefined;
  const directory = await createSecretsDirectory();
  const materialization = await materializeSecrets(refs, {
    directory,
    keyPath: process.env.CAUCE_SEALING_KEY_PATH?.trim() ?? "",
    toTenant: deps.tenantId ?? delivery.tenant_id,
    toAlias: delivery.recipient_alias,
    fetchSealedSecret: deps.fetchSealedSecret,
    notice: (secretId, reason) => {
      (deps.logger as NoticeLogger)({
        event: "secret_handoff_skipped",
        delivery_id: delivery.delivery_id,
        alias: delivery.recipient_alias,
        attempt: delivery.attempt,
        timestamp: new Date().toISOString(),
        reason: `${secretId}:${reason}`,
      });
    },
  });
  return { directory, secrets: materialization.secrets, scrub: materialization.scrub };
}

/**
 * Builds the prompt and every file the turn will read. A failure after a directory exists removes
 * it here: from this point on nobody else holds a reference to it.
 */
export async function materializeTurnInput(
  delivery: Delivery,
  store: DurableStore,
  deps: TurnInputDeps,
): Promise<TurnInput> {
  const attachments = await materializeAttachments(delivery.body);
  let secrets: TurnSecrets | undefined;
  try {
    secrets = await materializeTurnSecrets(delivery, deps);
    const blocks = [promptForDelivery(delivery, store)];
    if (attachments !== undefined) blocks.push(attachments.prompt);
    const secretsBlock = secretsPromptBlock(secrets?.secrets ?? []);
    if (secretsBlock !== undefined) blocks.push(secretsBlock);
    return { prompt: blocks.join("\n\n"), attachments, secrets };
  } catch (error) {
    await attachments?.cleanup().catch(() => undefined);
    if (secrets !== undefined) await rm(secrets.directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Releases the turn's directories once the ACK is on its way. A failed `rm` is a disk problem, not
 * the human's: it is logged and swallowed, because turning it into a delivery failure would
 * replay a turn the agent already answered.
 */
export async function releaseAttachments(
  attachments: MaterializedAttachments | undefined,
  logger: AdapterLogger,
  delivery: Delivery,
): Promise<void> {
  if (attachments === undefined) return;
  try {
    await attachments.cleanup();
  } catch {
    (logger as NoticeLogger)({
      event: "attachment_cleanup_failed",
      delivery_id: delivery.delivery_id,
      alias: delivery.recipient_alias,
      attempt: delivery.attempt,
      timestamp: new Date().toISOString(),
    });
  }
}

export async function releaseTurn(
  turn: TurnInput | undefined,
  logger: AdapterLogger,
  delivery: Delivery,
): Promise<void> {
  if (turn === undefined) return;
  await releaseAttachments(turn.attachments, logger, delivery);
  if (turn.secrets === undefined) return;
  try {
    await rm(turn.secrets.directory, { recursive: true, force: true });
  } catch {
    (logger as NoticeLogger)({
      event: "secret_cleanup_failed",
      delivery_id: delivery.delivery_id,
      alias: delivery.recipient_alias,
      attempt: delivery.attempt,
      timestamp: new Date().toISOString(),
    });
  }
}
