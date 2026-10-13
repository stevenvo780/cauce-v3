import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { type TestContext } from "node:test";
import { ContextIngestClient, ContextIngestError, type NativeContextIngestInput } from "../src/sdk/context-ingest-client.js";

const input: NativeContextIngestInput = {
  base_version: 3,
  files: [{ path: "context/notes/current.md", content: "A native note" }],
};

async function clientWithResponse(t: TestContext, body: string): Promise<ContextIngestClient> {
  const server = createServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v3/context/ingest");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString("utf8")), input);
    response.writeHead(409, { "content-type": "application/json" }).end(body);
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => { if (error === undefined) resolve(); else reject(error); });
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return ContextIngestClient.fromRelayUrl(`ws://127.0.0.1:${String(address.port)}/v3/ws`, {});
}

test("recognizes the typed HTTP version conflict and preserves the current versions", async t => {
  const client = await clientWithResponse(t, JSON.stringify({
    error: "context_version_conflict", desired_version: 5, applied_version: 4,
    digest_exists_in_history: true,
  }));
  assert.deepEqual(await client.ingest(input), { state: "conflict", desired_version: 5, applied_version: 4 });
});

test("keeps the base version fallback only for a typed version conflict", async t => {
  const client = await clientWithResponse(t, JSON.stringify({ error: "context_version_conflict" }));
  assert.deepEqual(await client.ingest(input), { state: "conflict", desired_version: 3, applied_version: 3 });
});

test("rejects the governed profile response instead of reporting a version conflict", async t => {
  const client = await clientWithResponse(t, JSON.stringify({ error: "profile_is_governed" }));
  await assert.rejects(client.ingest(input), (error: unknown) =>
    error instanceof ContextIngestError && error.code === "REJECTED" && error.message.includes("profile_is_governed"));
});

for (const body of [
  JSON.stringify({ error: "unknown_conflict", desired_version: 5, applied_version: 4 }),
  JSON.stringify({ desired_version: 5, applied_version: 4 }),
  "null", "[]", "invalid json",
]) {
  test(`rejects an untyped HTTP conflict response: ${body}`, async t => {
    const client = await clientWithResponse(t, body);
    await assert.rejects(client.ingest(input), (error: unknown) =>
      error instanceof ContextIngestError && error.code === "REJECTED");
  });
}
