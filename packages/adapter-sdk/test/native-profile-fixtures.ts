import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ProfileRuntimeContract } from "@cauce/protocol";
import { conBloqueDePerfil, marcaDeRevisionDelPerfil } from "@cauce/protocol";
import { HARNESS_DEFINITIONS } from "../src/harnesses/index.js";
import type { HarnessRequestContext } from "../src/harnesses/shared.js";
import type {
  CommandRunRequest,
  CommandRunResult,
  CommandRunner,
  HarnessDefinition,
  HarnessId,
} from "../src/sdk/types.js";

export const OUTPUT = {
  reply: "ok",
  messages: [],
  notify: [],
  status: "done" as const,
  retryable: false,
  artifacts: [],
};

export function hash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function profileFile(alias: string, revision: number | undefined, body: string): string {
  const managed = conBloqueDePerfil("", `<!-- alias: Steven/${alias} -->\n${body}`);
  return revision === undefined ? managed : `${marcaDeRevisionDelPerfil(revision)}\n${managed}`;
}

export function context(alias: string): HarnessRequestContext {
  return {
    self_alias: alias,
    sender_alias: "kant",
    tenant_id: "Steven",
    room_id: "grp.steven",
    channel: "telegram",
    agent_message: true,
    message_type: "agent.message",
    routing_targets: [{ tenant_id: "Steven", alias: "kant", online: true }],
    self_role: `ROLE-SENTINEL-${alias}`,
  };
}

export function contract(revision: number, paths: readonly string[]): ProfileRuntimeContract {
  return {
    revision,
    generation: `runtime-${String(revision)}`,
    documents: paths.map((path) => ({
      name: basename(path),
      path,
      sha: hash(readFileSync(path, "utf8")),
    })),
  };
}

export function definition(id: HarnessId): HarnessDefinition {
  return {
    ...HARNESS_DEFINITIONS[id],
    sessionStrategy: { kind: "none" },
    parse: () => ({ output: OUTPUT }),
  };
}

export function spyRunner(): {
  readonly runner: CommandRunner;
  readonly requests: CommandRunRequest[];
} {
  const requests: CommandRunRequest[] = [];
  return {
    requests,
    runner: {
      async run(request: CommandRunRequest): Promise<CommandRunResult> {
        requests.push(request);
        return {
          stdout: "ignored",
          stderr: "",
          exitCode: 0,
          signal: null,
          timedOut: false,
          cancelled: false,
        };
      },
    },
  };
}

export function restoreEnvironment(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- env key passed in by caller
    delete process.env[name];
  } else process.env[name] = previous;
}

const RELOAD_MATERIAL: ReadonlySet<string> = new Set([
  "CAUCE_PROFILE_EXPECTATION_URL", "CAUCE_RELAY_URL",
  "CAUCE_TLS_CERT_FILE", "CAUCE_TLS_KEY_FILE", "CAUCE_TLS_CA_FILE",
]);

export function nativeEnvironment(value = "1"): NodeJS.ProcessEnv {
  const inherited = Object.entries(process.env)
    .filter(([name]) => !RELOAD_MATERIAL.has(name));
  return {
    ...Object.fromEntries(inherited),
    CAUCE_NATIVE_PROFILE_CONTEXT: value,
  };
}

/** Self-signed pair the reload only needs to build a TLS context with; no server ever sees it. */
const RELOAD_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBqjCCAVGgAwIBAgIUKS9ls98kkt/Q/ds2sKDm74lEQc4wCgYIKoZIzj0EAwIw
KzEpMCcGA1UEAwwgY2F1Y2UtbmF0aXZlLXByb2ZpbGUtcmVsb2FkLXRlc3QwHhcN
MjYwOTAzMDM0MjUyWhcNNDYwODI5MDM0MjUyWjArMSkwJwYDVQQDDCBjYXVjZS1u
YXRpdmUtcHJvZmlsZS1yZWxvYWQtdGVzdDBZMBMGByqGSM49AgEGCCqGSM49AwEH
A0IABED/1w7XPx0JbkOn6UE7JOxHF5ECKGxqPHNbbkrs0LevPDr/iN41HABuJuc2
q6NgNZVO4Q9AGCCc2eWHUSs+5C6jUzBRMB0GA1UdDgQWBBQAjbKkQj/a1xlVJmTh
QbTU9GnJsDAfBgNVHSMEGDAWgBQAjbKkQj/a1xlVJmThQbTU9GnJsDAPBgNVHRMB
Af8EBTADAQH/MAoGCCqGSM49BAMCA0cAMEQCIHcWbG8lKLRemh8AIOKsTwHcUb70
k+R6LOizBd5sg0WSAiBHIeODCOQ8oZHl5t2L4XwOIBU3ed4UzxvPHXivfBWb2g==
-----END CERTIFICATE-----
`;
const RELOAD_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgrSh7nhRhDTlf+IWm
yWypGduMJVYAeZR10g+uJcmNCG2hRANCAARA/9cO1z8dCW5Dp+lBOyTsRxeRAihs
ajxzW25K7NC3rzw6/4jeNRwAbibnNqujYDWVTuEPQBggnNnlh1ErPuQu
-----END PRIVATE KEY-----
`;

export function reloadMaterial(directory: string, usable: boolean): {
  readonly CAUCE_TLS_CERT_FILE: string;
  readonly CAUCE_TLS_KEY_FILE: string;
  readonly CAUCE_TLS_CA_FILE: string;
} {
  mkdirSync(directory, { recursive: true });
  const files = {
    CAUCE_TLS_CERT_FILE: join(directory, "client.crt"),
    CAUCE_TLS_KEY_FILE: join(directory, "client.key"),
    CAUCE_TLS_CA_FILE: join(directory, "ca.crt"),
  };
  const material = usable
    ? [RELOAD_CERTIFICATE, RELOAD_KEY, RELOAD_CERTIFICATE]
    : ["ilegible", "ilegible", "ilegible"];
  for (const [index, file] of Object.values(files).entries()) {
    writeFileSync(file, material[index] ?? "", "utf8");
  }
  return files;
}

export function captureStderr(): { readonly lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string): boolean => { lines.push(chunk); return true; };
  return { lines, restore: () => { process.stderr.write = original; } };
}
