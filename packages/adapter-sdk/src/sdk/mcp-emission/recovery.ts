import { dirname, join } from "node:path";
import { readOwnerOnlyFile } from "../secure-files.js";
import { validateStructuredOutput } from "../output-parser.js";

export async function correlatedEmission(quarantineFile: string, correlationId: string): Promise<string | undefined> {
  if (!/^[a-f0-9]{64}$/u.test(correlationId)) return undefined;
  try {
    const bytes = await readOwnerOnlyFile(join(dirname(quarantineFile), "mcp-emission", `${correlationId}.json`), "MCP turn deposit");
    const value = JSON.parse(bytes.toString("utf8")) as { correlation_id?: unknown; output?: unknown };
    if (value.correlation_id !== correlationId) return undefined;
    return JSON.stringify({ ...validateStructuredOutput(value.output), cauce_correlation_id: correlationId });
  } catch { return undefined; }
}
