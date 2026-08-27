#!/usr/bin/env bash
# Compatibility entrypoint for ws-isa after retiring the legacy Telegram poller.
#
# The container image starts /home/dev/.local/bin/salva-daemon as PID 1. Cauce
# owns Salva through its supervised adapter, so this entrypoint only keeps the
# workspace container alive. It must not start a TUI, poll Telegram, or attach a
# second bus.
set -euo pipefail

shutdown=0
trap 'shutdown=1' TERM INT HUP

while (( shutdown == 0 )); do
  sleep 3600 &
  child=$!
  wait "$child" || true
done
