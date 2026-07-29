#!/usr/bin/env node
/**
 * Reproduce el caso real: el harness deja un NIETO con stdout/stderr heredados y SALE.
 *
 * Es lo que hace cualquier CLI que arranca un servidor MCP, un watcher o un puente y no lo
 * desconecta de sus descriptores. El hijo directo muere, pero la tubería que lee el runner sigue
 * abierta del otro lado, así que `close` no llega nunca.
 *
 * argv: <marcador> <salida-final> <ms-que-vive-el-nieto> <ms-antes-de-escribir-el-marcador>
 * El nieto escribe el marcador sólo si NADIE lo mató: es la prueba de que la cosecha alcanzó a
 * los descendientes y no sólo al pid del hijo.
 */
import { spawn } from "node:child_process";
import process from "node:process";

const marker = process.argv[2];
const finalOutput = process.argv[3] ?? "";
const holdMs = Number(process.argv[4] ?? 60_000);
const markerMs = Number(process.argv[5] ?? 1_500);

if (!marker) throw new Error("marker path required");

const grandchild = spawn(
  process.execPath,
  [
    "--eval",
    `process.on('SIGTERM', () => {});`
    + `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), ${markerMs});`
    + `setTimeout(() => process.exit(0), ${holdMs});`,
  ],
  // Hereda NUESTRAS tuberías: es exactamente lo que mantiene abierto el extremo del runner.
  { stdio: ["ignore", "inherit", "inherit"] },
);
grandchild.unref();

if (finalOutput.length > 0) process.stdout.write(finalOutput);
