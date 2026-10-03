import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import { TLSSocket } from "node:tls";

export async function reloadServer(directory: string, mode: "503" | "error" | "timeout", t: TestContext) {
  mkdirSync(directory, { recursive: true });
  const cert = join(directory, "test.crt");
  const key = join(directory, "test.key");
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
    "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  let calls = 0;
  let recovery = false;
  const server = createServer({ cert: readFileSync(cert), key: readFileSync(key),
    ca: readFileSync(cert), requestCert: true, rejectUnauthorized: true }, (request, response) => {
    calls += 1;
    if (!(request.socket instanceof TLSSocket) || !request.socket.authorized) throw new Error("client authentication required");
    if (recovery) { response.end("ok"); return; }
    if (mode === "error") { request.socket.destroy(); return; }
    if (mode === "503") { response.writeHead(503); response.end(); }
    if (mode === "timeout") {
      response.writeHead(200);
      response.write("pending");
      const stream = setInterval(() => { response.write("pending"); }, 100);
      response.on("close", () => { clearInterval(stream); });
    }
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve(); }); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing fixture port");
  return { environment: { CAUCE_TLS_CERT_FILE: cert, CAUCE_TLS_KEY_FILE: key,
    CAUCE_TLS_CA_FILE: cert, CAUCE_PROFILE_EXPECTATION_URL: `https://127.0.0.1:${String(address.port)}` },
    calls: () => calls, recover: () => { recovery = true; } };
}

export async function waitForReload(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("reload fixture condition timed out");
    await delay(10);
  }
}
