# Provider Smoke Contract Repair — Design

**Date:** 2026-07-24
**Status:** Approved

## Goal

Make the persistent `provider-smoke` harness accept the documented custom-provider form on the first attempt in a newly started Claude Code session. The exact payload that previously produced `model="undefined"` must work:

```json
{
  "nonce": "unique-run-id",
  "strict": true,
  "providers": [
    "minimax/MiniMax-M3",
    "gemini/flash",
    "gemini/pro",
    "codex/gpt-5.6-sol",
    "claude/sonnet",
    "claude/opus"
  ]
}
```

## Root Cause

The public metadata describes `providers: [...]` without defining the element type. The workflow passes each element directly to `resolver`, which expects a full leg object containing `key`, `model`, `quotaKey`, `tarea`, and `magic`. JavaScript property reads on a string return `undefined`, so the fan-out reaches `delegar_a_cloud` with `model="undefined"` instead of failing at the input boundary.

The persistent source is `/home/dev/.claude/workflows/provider-smoke.js`. Session-generated workflow scripts are diagnostic artifacts, not the source to repair.

## Public Contract

`args` may be either a JavaScript object or its JSON-string representation.

- `nonce`: non-empty string. A generated fallback remains for compatibility, but examples always provide a unique nonce.
- `full`: boolean. When true, run all ten canonical routes.
- `strict`: boolean. When true, preserve exact requested routes rather than applying quota fallbacks.
- `providers`: optional non-empty array whose elements may be:
  1. a canonical model ID string; or
  2. an advanced provider-leg object whose `model` is a canonical model ID.

When both `providers` and `full:true` are supplied, `providers` takes precedence for backward compatibility. An explicitly empty `providers` array is invalid rather than silently launching zero legs.

Model-ID strings are the recommended public form. Advanced objects remain available for custom tasks and markers.

Canonical model IDs:

- `minimax/MiniMax-M3`
- `minimax/MiniMax-M2.7`
- `gemini/flash`
- `gemini/pro`
- `claude/sonnet`
- `claude/opus`
- `codex/gpt-5.3-codex-spark`
- `codex/gpt-5.6-sol`
- `codex/gpt-5.6-luna`
- `codex/gpt-5.6-terra`

## Normalization and Validation

Before quota resolution or agent fan-out:

1. Parse stringified `args` defensively.
2. Build a canonical catalog from the existing `BASE` and `EXTRAS` legs, keyed by model ID.
3. Normalize every `providers[i]`:
   - For a string, clone its canonical catalog leg.
   - For an object, validate required fields and clone it.
4. Reject unknown model IDs, unsupported primitive types, malformed objects, and duplicate keys with an error that names `providers[i]` and explains the accepted forms.
5. Assert that every normalized leg has non-empty `key`, `model`, `tarea`, and `magic`, and that `fallbacks` is an array.
6. Only then run quota routing and delegation.

No invalid input may launch provider agents, and `undefined` must never be interpolated into a provider call.

## Error Handling

Errors are deterministic and actionable. Example:

```text
provider-smoke: providers[2] has unknown model "example/model". Expected one of: ...
```

Invalid JSON, non-array `providers`, malformed advanced objects, and duplicate keys each receive a distinct message. Strict mode affects quota routing only; it does not weaken input validation.

## Documentation

Update the persistent workflow metadata so the skill listing states the exact schema:

```text
providers?: Array<string | ProviderSpec>; strings are canonical model IDs
```

Include copyable examples for:

- the default smoke test;
- all ten routes with `full:true`;
- selected routes using string IDs;
- one advanced object.

Update existing provider-smoke reference documentation and persistent memory where it says eight routes; the authoritative count is ten. Do not create parallel or contradictory contracts.

## Verification

Add or run regression coverage for:

1. `args` as an object and as JSON text.
2. A selected `providers` array of model-ID strings — the original failure.
3. A valid advanced object.
4. Mixed strings and advanced objects.
5. Unknown model IDs, malformed objects, non-array `providers`, duplicate keys, and invalid JSON.
6. Validation that invalid input launches zero provider legs and never emits `undefined`.
7. A fresh named-workflow invocation with a new nonce, proving the persistent registered workflow—not a session script—loads and verifies all selected routes.
8. A full strict invocation that verifies all ten canonical routes.

The final report distinguishes local deterministic contract tests from live provider-consumption tests and states any route not exercised because of unavailable quota.

## Persistence and Scope

Modify the source under `/home/dev/.claude/workflows/`, not the generated script under the session transcript. Inspect any existing adjacent skill or reference file before editing it. The result survives a Claude Code restart because discovery reads the persistent named workflow on session startup.

Repository application code is out of scope. No unrelated harness refactor, provider change, or quota-policy change is included.
