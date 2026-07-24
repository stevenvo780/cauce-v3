import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { HARNESS_DEFINITIONS } from "../src/harnesses/index.js";
import {
  OPEN_CODE_KANT_ATTACH_URL,
  OPEN_CODE_KANT_WORKING_DIRECTORY,
} from "../src/harnesses/opencode.js";

test("each harness manifest matches its advertised runtime capabilities", async () => {
  for (const [id, definition] of Object.entries(HARNESS_DEFINITIONS)) {
    const manifest = JSON.parse(await readFile(resolve(`manifests/${id}.json`), "utf8")) as {
      schema_version: number;
      harness: string;
      adapter_executable: string;
      invocation: { prompt_transport: string };
      capabilities: unknown;
    };
    assert.equal(manifest.schema_version, 1);
    assert.equal(manifest.harness, id);
    assert.equal(manifest.adapter_executable, `cauce-adapter-${id}`);
    assert.equal(manifest.invocation.prompt_transport, "stdin");
    assert.deepEqual(manifest.capabilities, definition.capabilities);
  }
});

test("Hermes declares the operational model selector by environment name only", async () => {
  const manifest = JSON.parse(await readFile(resolve("manifests/hermes.json"), "utf8")) as {
    invocation: { operational_model_env: string };
  };
  assert.equal(manifest.invocation.operational_model_env, "HERMES_INFERENCE_MODEL");
  assert.equal(JSON.stringify(manifest).includes("gpt-"), false);
});

test("OpenCode manifest pins the persistent Kant server and startup health dependency", async () => {
  const manifest = JSON.parse(await readFile(resolve("manifests/opencode.json"), "utf8")) as {
    invocation: {
      server_attach_url: string;
      working_directory: string;
      startup_health_url: string;
      startup_dependency: string;
      canonical_session_pointer: {
        enabled_alias: string;
        path: string;
        contract_version: number;
        states: string[];
        active_fields: string[];
        unavailable_reasons: string[];
        permissions: { directory: string; file: string };
        sessions_file_security: string;
        directory_fsync_unsupported_codes: string[];
        atomic_write_recovery: string;
        privacy: string;
        selection: string;
      };
    };
  };
  assert.equal(manifest.invocation.server_attach_url, OPEN_CODE_KANT_ATTACH_URL);
  assert.equal(manifest.invocation.working_directory, OPEN_CODE_KANT_WORKING_DIRECTORY);
  assert.equal(manifest.invocation.startup_health_url, `${OPEN_CODE_KANT_ATTACH_URL}/global/health`);
  assert.match(manifest.invocation.startup_dependency, /before adapter start/u);
  assert.deepEqual(manifest.invocation.canonical_session_pointer, {
    enabled_alias: "kant",
    path: "$CAUCE_STATE_DIR/canonical-opencode-session.json",
    contract_version: 1,
    states: ["active", "unavailable"],
    active_fields: ["version", "state", "alias", "harness", "scope_key", "session_id"],
    unavailable_reasons: ["missing", "ambiguous", "invalid"],
    permissions: { directory: "0700", file: "0600" },
    sessions_file_security: "bounded 1 MiB O_NOFOLLOW/O_NONBLOCK open, fstat owner/mode/type/size/stability, duplicate-free strict schema; reloaded under consumer lease",
    directory_fsync_unsupported_codes: ["EINVAL", "ENOTSUP", "EOPNOTSUPP"],
    atomic_write_recovery: "same-directory copied 0600 backup published after fsync; startup restores uncommitted backup, keeps committed target, removes incomplete staging/orphan temp, rejects ambiguity",
    privacy: "scope_key is an authenticated-scope hash; prompts and chat/user/message identifiers are forbidden",
    selection: "sticky first durable initialized scope; startup requires exactly one valid mapping",
  });
});
