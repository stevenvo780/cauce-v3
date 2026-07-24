#!/usr/bin/env node
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
const prompt = Buffer.concat(chunks).toString("utf8");

if (prompt.includes("SCENARIO:timeout")) {
  await new Promise((resolve) => setTimeout(resolve, 60_000));
} else if (prompt.includes("SCENARIO:malformed")) {
  process.stdout.write("not-json\n");
} else {
  const failed = prompt.includes("SCENARIO:fail") || prompt.includes("SCENARIO:retry");
  process.stdout.write(
    `${JSON.stringify({
      reply: failed ? "fake failure" : "fake reply",
      messages: [],
      status: failed ? "failed" : "done",
      retryable: prompt.includes("SCENARIO:retry"),
      artifacts: [],
    })}\n`,
  );
  if (prompt.includes("SCENARIO:fail")) process.exitCode = 7;
}
