import process from "node:process";

export async function runFakeCli(dialect) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const prompt = Buffer.concat(chunks).toString("utf8");
  if (prompt.includes("SCENARIO:timeout")) {
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    return;
  }
  if (prompt.includes("SCENARIO:malformed")) {
    process.stdout.write("definitely-not-json\n");
    return;
  }

  const isRetry = prompt.includes("SCENARIO:retry");
  const isFailure = prompt.includes("SCENARIO:fail") || isRetry;
  const output = {
    reply: isFailure ? `${dialect} failure` : `${dialect} success`,
    messages: isFailure ? [] : [{ to: "ops", body: `${dialect} relayed` }],
    status: isFailure ? "failed" : "done",
    retryable: isRetry,
    artifacts: isFailure ? [] : [{ name: "report", uri: "memory://report" }],
  };

  switch (dialect) {
    case "hermes":
      process.stdout.write(`${JSON.stringify({ output, session_id: "hermes-native" })}\n`);
      break;
    case "opencode":
      process.stdout.write(`${JSON.stringify({ type: "step_start", sessionID: "opencode-native", part: { type: "step-start" } })}\n`);
      process.stdout.write(`${JSON.stringify({ type: "text", sessionID: "opencode-native", part: { type: "text", text: JSON.stringify(output) } })}\n`);
      process.stdout.write(`${JSON.stringify({ type: "step_finish", sessionID: "opencode-native", part: { type: "step-finish" } })}\n`);
      break;
    case "claude":
      process.stdout.write(
        `${JSON.stringify({ type: "result", result: JSON.stringify(output), session_id: "claude-native" })}\n`,
      );
      break;
    case "codex":
      process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "codex-native" })}\n`);
      process.stdout.write(
        `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(output) } })}\n`,
      );
      process.stdout.write(`${JSON.stringify({ type: "turn.completed", usage: {} })}\n`);
      break;
    case "openclaw":
      process.stdout.write(`${JSON.stringify({ payloads: [{ text: JSON.stringify(output) }] })}\n`);
      break;
    case "fake":
      process.stdout.write(`${JSON.stringify({ output, session_id: "fake-native" })}\n`);
      break;
    default:
      throw new Error("unknown fake dialect");
  }
  if (prompt.includes("SCENARIO:fail")) process.exitCode = 9;
}
