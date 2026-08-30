import {
  AtomicRecoveryError,
  clone,
  recoverAtomicArtifacts,
} from "./atomic-state.js"; /* eslint @typescript-eslint/no-unnecessary-boolean-literal-compare: "error" */
import {
  CANONICAL_OPEN_CODE_SESSION_FILE,
  type CanonicalOpenCodeSessionPointer,
  type SessionRecord,
} from "./contracts.js";
import { DurableStoreDeliveries } from "./deliveries.js";
import {
  activeCanonicalOpenCodeSession,
  canonicalOpenClawTerminalKey,
  isCanonicalOpenCodeScopeKey,
  isCanonicalOpenCodeSessionId,
  readSessionsSecure,
  unavailableCanonicalOpenCodeSession,
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

  /**
   * Confirms a native OpenClaw session and publishes in the SAME rename the selector consumed
   * by the terminal TUI.
   *
   * The source entry keeps `origin` so operational tools can distinguish conversations. The
   * fixed pointer, on the other hand, contains only the opaque native identifier and the init
   * bit: copying the `conversation_id` there duplicated a user identifier the consumer did not
   * need. A single write prevents a restart from leaving a session published that still appears
   * uninitialized, or vice versa.
   */
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

  /**
   * Rebuild the non-sensitive Kant/OpenCode pointer from durable mappings.
   * This is deliberately opt-in so no other alias or harness publishes it.
   */
  async reconcileCanonicalOpenCodeSession(): Promise<CanonicalOpenCodeSessionPointer> {
    return this.serialized(async () => {
      try {
        // Runtime calls this only from AdapterClient.onLeaseAcquired, replacing
        // the pre-lease snapshot and removing the load/reconcile TOCTOU.
        await recoverAtomicArtifacts(
          this.directory,
          ["sessions.json", CANONICAL_OPEN_CODE_SESSION_FILE],
          this.directoryFsync,
        );
        this.sessions = await readSessionsSecure(this.path("sessions.json"));
      } catch (error) {
        this.canonicalOpenCodeScopeKey = undefined;
        this.canonicalOpenCodeReconciled = false;
        if (error instanceof AtomicRecoveryError
          && error.target === CANONICAL_OPEN_CODE_SESSION_FILE) throw error;
        await this.atomicWrite(
          CANONICAL_OPEN_CODE_SESSION_FILE,
          unavailableCanonicalOpenCodeSession("invalid"),
        );
        throw error;
      }
      const mappings = this.canonicalOpenCodeMappings();
      this.canonicalOpenCodeScopeKey = undefined;
      let pointer: CanonicalOpenCodeSessionPointer;
      if (mappings.length === 0) {
        pointer = unavailableCanonicalOpenCodeSession("missing");
      } else if (mappings.length > 1) {
        pointer = unavailableCanonicalOpenCodeSession("ambiguous");
      } else {
        const mapping = mappings[0];
        if (mapping === undefined
          || !isCanonicalOpenCodeScopeKey(mapping.scopeKey)
          || !isCanonicalOpenCodeSessionId(mapping.sessionId)) {
          pointer = unavailableCanonicalOpenCodeSession("invalid");
        } else {
          this.canonicalOpenCodeScopeKey = mapping.scopeKey;
          pointer = activeCanonicalOpenCodeSession(mapping.scopeKey, mapping.sessionId);
        }
      }
      await this.atomicWrite(CANONICAL_OPEN_CODE_SESSION_FILE, pointer);
      this.canonicalOpenCodeReconciled = true;
      return clone(pointer);
    });
  }

  /** Persist the mapping first, then atomically publish/refresh the sticky pointer. */
  async setCanonicalOpenCodeSession(scopeKey: string, sessionId: string): Promise<boolean> {
    if (!isCanonicalOpenCodeScopeKey(scopeKey) || !isCanonicalOpenCodeSessionId(sessionId)) return false;
    return this.serialized(async () => {
      if (!this.canonicalOpenCodeReconciled) {
        throw new Error("Canonical OpenCode session must be reconciled before publication");
      }
      const key = `opencode:kant:${scopeKey}`;
      this.sessions = {
        version: 1,
        sessions: {
          ...this.sessions.sessions,
          [key]: { native_id: sessionId, initialized: true },
        },
      };
      // This fsync+rename completes before the pointer can name the session.
      await this.atomicWrite("sessions.json", this.sessions);

      if (this.canonicalOpenCodeScopeKey === undefined) {
        const mappings = this.canonicalOpenCodeMappings();
        if (mappings.length !== 1) {
          const reason = mappings.length > 1 ? "ambiguous" : "invalid";
          await this.atomicWrite(
            CANONICAL_OPEN_CODE_SESSION_FILE,
            unavailableCanonicalOpenCodeSession(reason),
          );
          return false;
        }
        const mapping = mappings[0];
        if (mapping?.scopeKey !== scopeKey
          || !isCanonicalOpenCodeScopeKey(mapping.scopeKey)
          || !isCanonicalOpenCodeSessionId(mapping.sessionId)) {
          await this.atomicWrite(
            CANONICAL_OPEN_CODE_SESSION_FILE,
            unavailableCanonicalOpenCodeSession("invalid"),
          );
          return false;
        }
        this.canonicalOpenCodeScopeKey = scopeKey;
      }

      if (this.canonicalOpenCodeScopeKey !== scopeKey) return false;
      await this.atomicWrite(
        CANONICAL_OPEN_CODE_SESSION_FILE,
        activeCanonicalOpenCodeSession(scopeKey, sessionId),
      );
      return true;
    });
  }

  private canonicalOpenCodeMappings(): { scopeKey: string; sessionId: string }[] {
    const prefix = "opencode:kant:";
    const mappings: { scopeKey: string; sessionId: string }[] = [];
    for (const [key, record] of Object.entries(this.sessions.sessions)) {
      const candidate = record as unknown;
      if (!key.startsWith(prefix)
        || typeof candidate !== "object"
        || candidate === null
        || Array.isArray(candidate)) continue;
      const fields = candidate as Record<string, unknown>;
      if (fields.initialized !== true) continue;
      mappings.push({
        scopeKey: key.slice(prefix.length),
        sessionId: typeof fields.native_id === "string" ? fields.native_id : "",
      });
    }
    return mappings;
  }
}
