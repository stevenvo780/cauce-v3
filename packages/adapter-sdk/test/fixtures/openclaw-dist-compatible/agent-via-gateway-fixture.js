export async function agentCliCommand(options, runtime) {
  if (!runtime?.fixture || options.json !== true || options.deliver !== false) throw new Error("bad bridge call");
  if (process.argv.includes(options.message)) throw new Error("prompt leaked to argv");
  if (options.message.includes("BRIDGE_WAIT")) await new Promise((resolve) => setTimeout(resolve, 60_000));
  if (options.message.includes("OPENCLAW_ALL_MODELS_FAILED")) {
    const error = new Error("All models failed (4): anthropic/claude-opus-5: You've hit your session limit · resets 12:40am (UTC)");
    error.name = "FallbackSummaryError";
    throw error;
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
