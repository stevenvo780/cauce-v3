import assert from "node:assert/strict";
import test from "node:test";
import { isCanonicalOpenCodeScopeKey } from "../src/sdk/durable-store/session-file.js";

test("isCanonicalOpenCodeScopeKey accepts the auth-v3 scope key the engine emits", () => {
  assert.equal(isCanonicalOpenCodeScopeKey(`auth-v3:${"A".repeat(43)}`), true);
});

test("isCanonicalOpenCodeScopeKey rejects the retired auth-v1 prefix", () => {
  assert.equal(isCanonicalOpenCodeScopeKey(`auth-v1:${"A".repeat(43)}`), false);
});

test("isCanonicalOpenCodeScopeKey rejects a malformed digest length", () => {
  assert.equal(isCanonicalOpenCodeScopeKey(`auth-v3:${"A".repeat(42)}`), false);
  assert.equal(isCanonicalOpenCodeScopeKey("auth-v3:"), false);
});
