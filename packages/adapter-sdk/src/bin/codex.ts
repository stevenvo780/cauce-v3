#!/usr/bin/env node
import { reportFatal, runCli } from "./shared.js";

runCli("codex").catch(reportFatal);
