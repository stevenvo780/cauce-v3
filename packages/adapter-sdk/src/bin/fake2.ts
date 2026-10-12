#!/usr/bin/env node
import { reportFatal, runCli } from "./shared.js";

runCli("fake2").catch(reportFatal);
