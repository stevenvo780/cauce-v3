export async function agentCliCommand(options, runtime) {
  if (!runtime?.fixture || options.json !== true || options.deliver !== false) throw new Error("bad bridge call");
  if (process.argv.includes(options.message)) throw new Error("prompt leaked to argv");
  if (options.message.includes("BRIDGE_WAIT")) await new Promise((resolve) => setTimeout(resolve, 60_000));
  if (options.message.includes("OPENCLAW_ALL_MODELS_FAILED")) {
    const error = new Error("All models failed (4): anthropic/claude-opus-5: You've hit your session limit · resets 12:40am (UTC)");
    error.name = "FallbackSummaryError";
    throw error;
  }
  const reply = (text) => {
    process.stdout.write(`${JSON.stringify({ result: { payloads: [{ text: JSON.stringify({
      reply: text, messages: [], status: "done", retryable: false, artifacts: [],
    }) }] }, status: "ok" })}\n`);
  };
  if (options.local === true) { reply("embedded local run"); return; }
  if (options.message.includes("BRIDGE_ECHO_TIMEOUT")) { reply(`timeout=${String(options.timeout)}`); return; }
  for (const [marker, file] of [["BRIDGE_PROGRESS_WRITES", "run.jsonl"], ["BRIDGE_FOREIGN_WRITES", "other.jsonl"]]) {
    if (!options.message.includes(marker)) continue;
    // Stands in for a long gateway run: it prints nothing while some session transcript keeps growing.
    const { appendFileSync, mkdirSync, writeFileSync } = await import("node:fs");
    const directory = `${process.env.HOME}/.openclaw/agents/main/sessions`;
    mkdirSync(directory, { recursive: true });
    writeFileSync(`${directory}/sessions.json`, JSON.stringify({
      [`agent:main:${options.sessionKey}`]: { sessionId: "run", sessionFile: `${directory}/run.jsonl` },
    }));
    appendFileSync(`${directory}/run.jsonl`, "");
    for (let step = 0; step < 6; step += 1) {
      await new Promise((done) => setTimeout(done, 150));
      appendFileSync(`${directory}/${file}`, `{"step":${String(step)}}\n`);
    }
    reply("long run finished");
    return;
  }
  // Same shape as OpenClaw 2026.6.6 agentCliCommand: it logs through runtime.error and then runs
  // the whole turn again, embedded, whatever the gateway run is doing.
  for (const [marker, line] of [
    ["OPENCLAW_GATEWAY_TIMEOUT_FALLBACK", "EMBEDDED FALLBACK: Gateway agent timed out; running embedded agent with fresh session gateway-fallback-fixture: GatewayTransportError: gateway timeout after 930000ms"],
    ["OPENCLAW_GATEWAY_TRANSPORT_FALLBACK", "EMBEDDED FALLBACK: Gateway agent failed; running embedded agent: GatewayTransportError: gateway closed (1006)"],
  ]) {
    if (!options.message.includes(marker)) continue;
    runtime.error?.(line);
    reply("embedded duplicate ran");
    return;
  }
  if (options.message.includes("BRIDGE_LINGER")) {
    // Stands in for the embedded app-server OpenClaw falls back to: a live handle that keeps the
    // event loop running after the run resolved. Before the explicit exit, the bridge stayed here
    // forever with the answer already written, and the delivery hung in `started`.
    setInterval(() => {}, 1_000);
  }
  process.stdout.write("native log that the bridge must suppress\n");
  process.stdout.write(`${JSON.stringify({
    result: {
      payloads: [{ text: JSON.stringify({
        reply: "openclaw bridge success",
        messages: [],
        status: "done",
        retryable: false,
        artifacts: [],
      }) }],
      meta: { finalAssistantVisibleText: "must not override payload text", privateRuntimeDetail: "not public" },
    },
    runId: "fixture-run",
    status: "ok",
    summary: "fixture summary",
  })}\n`);
}
