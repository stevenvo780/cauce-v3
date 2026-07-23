#!/usr/bin/env node
import { reportFatal, runCli } from "./shared.js";

runCli("hermes").catch(reportFatal);
