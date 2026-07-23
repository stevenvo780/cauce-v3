export async function agentCliCommand(options, runtime) {
  if (!runtime?.fixture || options.json !== true || options.deliver !== false) throw new Error("bad bridge call");
  if (process.argv.includes(options.message)) throw new Error("prompt leaked to argv");
  if (options.message.includes("BRIDGE_WAIT")) await new Promise((resolve) => setTimeout(resolve, 60_000));
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
