#!/usr/bin/env node
import { copyFile } from "node:fs/promises";
import path from "node:path";

const [, output, phase] = process.argv.slice(2);
const sourceRoot = process.env.FAKE_GATE_SNAPSHOT_DIR;
if (!sourceRoot || !output || !phase) process.exit(125);
await copyFile(path.join(sourceRoot, `${phase}.json`), output);
