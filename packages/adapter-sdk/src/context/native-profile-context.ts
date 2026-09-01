import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  FICHEROS_OPENCLAW,
  MARCA_FIN,
  MARCA_INICIO,
  MARCA_PERFIL_FIN,
  MARCA_PERFIL_INICIO,
  bloqueGestionado,
  bloqueDePerfil,
  measureStrictestUnits,
  revisionDelPerfil,
  TOPES_OPENCLAW,
} from "@cauce/protocol";
import type {
  HarnessRequestContext,
  RuntimeProfileMeasurement,
} from "../contracts/harness.js";
import type { HarnessId } from "../sdk/types.js";
import { AdapterError } from "../sdk/errors.js";
import {
  discoReal,
  escribirEnDiscoRealSiCoincide,
} from "./siembra-del-perfil.js";
import {
  conBloqueGestionado,
  elFicheroYaLoDice,
  rutaDelContextoFijo,
  selloDesdeElDisco,
} from "../harnesses/contexto-fijo.js";
import { textoNativoDelSobre } from "../harnesses/shared/prompt.js";

const AUTHORED_OPENCLAW_FILES: ReadonlySet<string> = new Set<string>(
  FICHEROS_OPENCLAW.filter((name) => name !== "MEMORY.md" && name !== "HEARTBEAT.md"),
);
const MAX_CLAUDE_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_OPENCLAW_DOCUMENT_BYTES = 1024 * 1024;

interface NativeProfilePath {
  readonly path: string;
  readonly authored: boolean;
}

/** Parses the alias-local optimization flag without accepting truthy lookalikes. */
export function nativeProfileContextEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw new Error("CAUCE_NATIVE_PROFILE_CONTEXT must be exactly 0 or 1");
}

function occurrences(text: string, needle: string): number {
  let count = 0;
  for (let offset = text.indexOf(needle); offset !== -1; offset = text.indexOf(needle, offset + 1)) {
    count += 1;
  }
  return count;
}

/** Native-profile projector and verifier for one alias process. */
export class NativeProfileContext {
  private readonly home: string | undefined;
  private readonly claudeConfigDirectory: string | undefined;
  private readonly openClawWorkspace: string | undefined;
  private readonly runtimeGeneration: string;
  private readonly presenceGeneration: string | undefined;

  constructor(
    private readonly harness: HarnessId,
    sharedSession: boolean,
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    if (harness !== "claude" && harness !== "openclaw") {
      throw new Error("Native profile context is only supported by claude and openclaw");
    }
    if (sharedSession) {
      throw new Error("Native profile context requires a fresh harness process, not a shared session");
    }
    this.home = environment.HOME;
    this.claudeConfigDirectory = environment.CLAUDE_CONFIG_DIR;
    this.openClawWorkspace = environment.CAUCE_OPENCLAW_WORKSPACE;
    const generation = environment.CAUCE_CONTAINER_GENERATION;
    if (generation === undefined || generation.length === 0) {
      throw new Error("Native profile context requires CAUCE_CONTAINER_GENERATION");
    }
    this.runtimeGeneration = generation;
    const presence = environment.CAUCE_CONTAINER_PRESENCE_GENERATION;
    this.presenceGeneration = presence === undefined || presence.length === 0
      ? undefined
      : presence;
  }

  prepare(context: HarnessRequestContext | undefined): HarnessRequestContext {
    if (context === undefined) {
      throw this.failure("trusted delivery identity is missing");
    }

    try {
      if (context.native_profile_context === true) {
        return {
          ...context,
          native_profile_measurement: this.revalidate(context),
        };
      }
      const projected = this.measure(context);
      this.assertContract(context, projected);
      const instructionPath = this.instructionPath();
      const original = this.read(instructionPath);
      if (original === undefined) throw new Error(`${instructionPath} does not exist`);

      const fixed = textoNativoDelSobre(context);
      const merged = conBloqueGestionado(original, fixed);
      this.assertDocumentLimits(instructionPath, merged);
      if (merged !== original) {
        escribirEnDiscoRealSiCoincide(instructionPath, original, merged);
      }
      const seal = selloDesdeElDisco(instructionPath, (path) => {
        const file = this.read(path);
        if (file === undefined) throw new Error(`${path} disappeared during native preflight`);
        return file;
      });
      if (seal === undefined || !elFicheroYaLoDice(seal, fixed)) {
        throw new Error(`${instructionPath} does not contain the expected fixed contract`);
      }

      const measurement = this.measure(context);
      if (measurement.sha256 !== projected.sha256) {
        throw new Error("the authored profile changed while converging its fixed contract");
      }
      const trusted = { ...context };
      delete trusted.runtime_profile;
      delete trusted.context_seal;
      delete trusted.native_profile_context;
      delete trusted.native_profile_measurement;
      const result: HarnessRequestContext = {
        ...trusted,
        context_seal: seal,
        native_profile_context: true,
        native_profile_measurement: measurement,
      };
      return result;
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw this.failure(error instanceof Error ? error.message : String(error));
    }
  }

  /** Re-reads every native document and rejects any drift from an earlier preflight. */
  revalidate(context: HarnessRequestContext): RuntimeProfileMeasurement {
    const previous = context.native_profile_measurement;
    if (context.native_profile_context !== true || previous === undefined
      || context.native_profile_contract === undefined) {
      throw this.failure("native profile preflight evidence is missing");
    }
    try {
      const current = this.measure(context);
      if (current.sha256 !== previous.sha256
        || current.text !== previous.text
        || current.documents.length !== previous.documents.length) {
        throw new Error("native profile files changed after preflight");
      }
      for (let index = 0; index < current.documents.length; index += 1) {
        const before = previous.documents[index];
        const after = current.documents[index];
        if (before === undefined || after === undefined) {
          throw new Error("native profile files changed after preflight");
        }
        if (before.path !== after.path || before.sha256 !== after.sha256) {
          throw new Error("native profile files changed after preflight");
        }
      }
      return current;
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw this.failure(error instanceof Error ? error.message : String(error));
    }
  }

  private failure(detail: string): AdapterError {
    return new AdapterError(
      "NATIVE_PROFILE_CONTEXT_PREFLIGHT_FAILED",
      `Native profile context preflight failed: ${detail}`,
      true,
    );
  }

  private instructionPath(): string {
    if (this.harness === "openclaw") {
      const workspace = this.requireAbsolute(this.openClawWorkspace, "CAUCE_OPENCLAW_WORKSPACE");
      return join(workspace, "AGENTS.md");
    }
    const home = this.requireAbsolute(this.home, "HOME");
    const path = rutaDelContextoFijo("claude", home, {
      HOME: home,
      ...(this.claudeConfigDirectory === undefined
        ? {}
        : { CLAUDE_CONFIG_DIR: this.claudeConfigDirectory }),
    });
    if (path === undefined) throw new Error("claude has no native instruction path");
    return path;
  }

  private paths(): readonly NativeProfilePath[] {
    if (this.harness === "openclaw") {
      const workspace = this.requireAbsolute(this.openClawWorkspace, "CAUCE_OPENCLAW_WORKSPACE");
      return FICHEROS_OPENCLAW.map((name) => ({
        path: join(workspace, name),
        authored: AUTHORED_OPENCLAW_FILES.has(name),
      }));
    }
    return [{ path: this.instructionPath(), authored: true }];
  }

  private requireAbsolute(value: string | undefined, name: string): string {
    if (!value?.startsWith("/")) {
      throw new Error(`${name} must be an absolute path`);
    }
    return value;
  }

  private read(path: string): string | undefined {
    return discoReal.leer(
      path,
      this.harness === "claude" ? MAX_CLAUDE_DOCUMENT_BYTES : MAX_OPENCLAW_DOCUMENT_BYTES,
    );
  }

  private assertDocumentLimits(instructionPath: string, mergedInstruction: string): void {
    if (this.harness === "claude") {
      if (Buffer.byteLength(mergedInstruction, "utf8") > MAX_CLAUDE_DOCUMENT_BYTES) {
        throw new Error("CLAUDE.md exceeds the native instruction limit after fixed context");
      }
      return;
    }

    let aggregate = 0;
    for (const entry of this.paths()) {
      if (!entry.authored) continue;
      const file = entry.path === instructionPath ? mergedInstruction : this.read(entry.path);
      if (file === undefined) throw new Error(`${entry.path} does not exist`);
      const units = measureStrictestUnits(file);
      if (units > TOPES_OPENCLAW.porFichero) {
        throw new Error(`${entry.path} exceeds the OpenClaw per-file limit after fixed context`);
      }
      aggregate += units;
    }
    if (aggregate > TOPES_OPENCLAW.total) {
      throw new Error("OpenClaw authored documents exceed the aggregate limit after fixed context");
    }
  }

  private ownedBlock(file: string, path: string, owner: string): string | undefined {
    const block = bloqueDePerfil(file);
    const starts = occurrences(file, MARCA_PERFIL_INICIO);
    const ends = occurrences(file, MARCA_PERFIL_FIN);
    if (starts === 0 && ends === 0) return undefined;
    if (starts !== 1 || ends !== 1 || block === undefined) {
      throw new Error(`${path} has malformed or repeated profile markers`);
    }
    const firstLine = block.trimStart().split(/\r?\n/u, 1)[0];
    if (firstLine !== owner) throw new Error(`${path} has a profile block owned by another alias`);
    return block;
  }

  private assertManagedBlocksDoNotOverlap(file: string, path: string): void {
    const fixedStart = file.indexOf(MARCA_INICIO);
    const fixedEndMarker = file.indexOf(MARCA_FIN);
    const profileStart = file.indexOf(MARCA_PERFIL_INICIO);
    const profileEndMarker = file.indexOf(MARCA_PERFIL_FIN);
    if (fixedStart === -1 || fixedEndMarker === -1
      || profileStart === -1 || profileEndMarker === -1) return;
    const fixedEnd = fixedEndMarker + MARCA_FIN.length;
    const profileEnd = profileEndMarker + MARCA_PERFIL_FIN.length;
    if (fixedStart < profileEnd && profileStart < fixedEnd) {
      throw new Error(`${path} has overlapping fixed-context and profile blocks`);
    }
  }

  private measure(context: HarnessRequestContext): RuntimeProfileMeasurement {
    const owner = `<!-- alias: ${context.tenant_id}/${context.self_alias} -->`;
    const expectedRevision = context.native_profile_contract?.revision;
    if (expectedRevision === undefined) {
      throw new Error("delivery has no native profile revision contract");
    }
    const documents: { path: string; sha256: string }[] = [];
    const blocks: { path: string; block: string }[] = [];
    const instructionPath = this.instructionPath();
    for (const entry of this.paths()) {
      const file = this.read(entry.path);
      if (file === undefined) throw new Error(`${entry.path} does not exist`);
      const fixedStarts = occurrences(file, MARCA_INICIO);
      const fixedEnds = occurrences(file, MARCA_FIN);
      const hasNoFixedMarkers = fixedStarts === 0 && fixedEnds === 0;
      const hasOneValidFixedBlock = entry.path === instructionPath
        && fixedStarts === 1
        && fixedEnds === 1
        && bloqueGestionado(file) !== undefined;
      if (!hasNoFixedMarkers && !hasOneValidFixedBlock) {
        throw new Error(`${entry.path} has misplaced, malformed, or repeated fixed-context markers`);
      }
      if (entry.authored) {
        const observedRevision = revisionDelPerfil(file);
        if (entry.path === instructionPath && observedRevision !== expectedRevision) {
          throw new Error(
            `${entry.path} does not identify profile revision ${String(expectedRevision)}`,
          );
        }
        if (entry.path !== instructionPath && observedRevision !== undefined) {
          throw new Error(`${entry.path} has a profile revision marker outside the canonical file`);
        }
      }
      const block = entry.authored ? this.ownedBlock(file, entry.path, owner) : undefined;
      if (entry.authored) this.assertManagedBlocksDoNotOverlap(file, entry.path);
      documents.push({
        path: entry.path,
        sha256: createHash("sha256").update(file, "utf8").digest("hex"),
      });
      if (block !== undefined) blocks.push({ path: entry.path, block });
    }
    if (blocks.length === 0) {
      throw new Error("native profile has no managed block owned by this alias");
    }
    const text = blocks.map((document) =>
      `## ${document.path.slice(document.path.lastIndexOf("/") + 1)}\n\n${document.block}`).join("\n\n");
    return {
      source: "runtime-files",
      sha256: createHash("sha256").update(text, "utf8").digest("hex"),
      documents,
      text,
    };
  }

  private assertContract(
    context: HarnessRequestContext,
    measurement: RuntimeProfileMeasurement,
  ): void {
    const contract = context.native_profile_contract;
    if (contract === undefined) throw new Error("delivery has no native profile revision contract");
    if (contract.generation !== this.runtimeGeneration
      && (this.presenceGeneration === undefined
        || contract.generation !== this.presenceGeneration)) {
      throw new Error("native profile contract belongs to another runtime generation");
    }
    const paths = this.paths();
    if (contract.documents.length !== paths.length) {
      throw new Error("native profile contract has the wrong document cardinality");
    }

    const expected = new Map(contract.documents.map((document) => [document.path, document]));
    const observed = new Map(measurement.documents.map((document) => [document.path, document.sha256]));
    for (const entry of paths) {
      const document = expected.get(entry.path);
      const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
      if (document === undefined) {
        throw new Error(`native profile contract does not bind ${entry.path}`);
      }
      if (document.name !== name) {
        throw new Error(`native profile contract does not bind ${entry.path}`);
      }
      if (entry.authored && observed.get(entry.path) !== document.sha) {
        throw new Error(`${entry.path} does not match profile revision ${String(contract.revision)}`);
      }
      expected.delete(entry.path);
    }
    if (expected.size !== 0) throw new Error("native profile contract binds unexpected paths");
  }
}
