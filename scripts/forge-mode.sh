#!/usr/bin/env bash
# Forge mode: pause (not stop) the pipeline for an image run and put everything back after. See src/forge-mode.js.
#   scripts/forge-mode.sh on [--vm off|keep] | off | status [--json] | expire
exec node "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/../src/forge-mode.js" "$@"
