import {
  clone,
  recoverAtomicArtifacts,
} from "./atomic-state.js"; /* eslint @typescript-eslint/no-unnecessary-boolean-literal-compare: "error" */
import type { SessionRecord } from "./contracts.js";
import { DurableStoreDeliveries } from "./deliveries.js";
import {
  canonicalOpenClawTerminalKey,
  readSessionsSecure,
  validateSessionsFile,
} from "./session-file.js";

export class DurableStoreSessions extends DurableStoreDeliveries {
  getSession(key: string): SessionRecord | undefined {
    const record = this.sessions.sessions[key];
    return record === undefined ? undefined : clone(record);
  }

  async setSession(key: string, record: SessionRecord): Promise<void> {
    await this.serialized(async () => {
      const next = validateSessionsFile({
        version: 1,
        sessions: { ...this.sessions.sessions, [key]: record },
      });
      await this.atomicWrite("sessions.json", next);
      this.sessions = next;
    });
  }

  /** Forgets a missing native session so a retry can create a fresh one. */
  async forgetSession(key: string): Promise<boolean> {
    return this.serialized(async () => {
      if (this.sessions.sessions[key] === undefined) return false;
      const remaining: Record<string, SessionRecord> = Object.fromEntries(
        Object.entries(this.sessions.sessions).filter(([sessionKey]) => sessionKey !== key),
      );
      const next = validateSessionsFile({ version: 1, sessions: remaining });
      await this.atomicWrite("sessions.json", next);
      this.sessions = next;
      return true;
    });
  }

  /** Publishes the initialized terminal pointer in the same atomic sessions update. */
  async setCanonicalOpenClawTerminalSession(
    alias: string,
    sourceKey: string,
    record: SessionRecord,
  ): Promise<void> {
    const pointerKey = canonicalOpenClawTerminalKey(alias);
    if (pointerKey === undefined || !sourceKey.startsWith(`openclaw:${alias}:`)) {
      throw new Error("Invalid canonical OpenClaw terminal session scope");
    } // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- Public JavaScript callers can pass a non-boolean value.
    if (record.initialized !== true) {
      throw new Error("Canonical OpenClaw terminal session must be initialized");
    }
    await this.serialized(async () => {
      const pointer: SessionRecord = {
        native_id: record.native_id,
        initialized: true,
      };
      const next = validateSessionsFile({
        version: 1,
        sessions: {
          ...this.sessions.sessions,
          [sourceKey]: record,
          [pointerKey]: pointer,
        },
      });
      await this.atomicWrite("sessions.json", next);
      this.sessions = next;
    });
  }

  /**
   * Repairs the OpenClaw pointer under the alias's stable lease, before connecting to the relay.
   *
   * A pointer already published is the only canonical selection and survives restarts. For stores
   * before this contract, a human session is only adopted automatically when exactly one exists;
   * with zero or several it is left absent to avoid turning `mtime` or JSON order into an
   * invented conversation choice. The next valid human turn publishes it.
   */
  async reconcileCanonicalOpenClawTerminalSession(alias: string): Promise<boolean> {
    const pointerKey = canonicalOpenClawTerminalKey(alias);
    if (pointerKey === undefined) {
      throw new Error("Invalid canonical OpenClaw terminal session scope");
    }
    return this.serialized(async () => {
      await recoverAtomicArtifacts(
        this.directory,
        ["sessions.json"],
        this.directoryFsync,
      );
      this.sessions = await readSessionsSecure(this.path("sessions.json"));

      const current = this.sessions.sessions[pointerKey];
      if (current?.initialized === true) {
        // Early writers also copied `origin`. Fixed in-place without changing the selected session
        // or revealing the value in errors or logs.
        if (current.origin !== undefined) {
          const next = validateSessionsFile({
            version: 1,
            sessions: {
              ...this.sessions.sessions,
              [pointerKey]: { native_id: current.native_id, initialized: true },
            },
          });
          await this.atomicWrite("sessions.json", next);
          this.sessions = next;
        }
        return true;
      }

      const prefix = `openclaw:${alias}:`;
      const candidates = Object.entries(this.sessions.sessions).filter(([key, candidate]) => (
        key.startsWith(prefix)
        && key !== pointerKey
        && !key.endsWith(".agent-lane")
        && candidate.initialized
      ));
      const sessions = Object.fromEntries(
        Object.entries(this.sessions.sessions).filter(([key]) => key !== pointerKey),
      );
      const candidate = candidates.length === 1 ? candidates[0]?.[1] : undefined;
      if (candidate !== undefined) {
        sessions[pointerKey] = { native_id: candidate.native_id, initialized: true };
      }
      const next = validateSessionsFile({ version: 1, sessions });
      if (JSON.stringify(next) !== JSON.stringify(this.sessions)) {
        await this.atomicWrite("sessions.json", next);
        this.sessions = next;
      }
      return candidate !== undefined;
    });
  }

}
