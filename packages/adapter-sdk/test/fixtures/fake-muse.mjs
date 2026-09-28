#!/usr/bin/env node
import { runFakeCli } from "./fake-cli-common.mjs";

// Stands in for the muse-cauce bridge: prompt on stdin, `muse exec --json` records on stdout.
await runFakeCli("muse");
