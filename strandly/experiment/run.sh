#!/bin/bash
# Usage:
#   bash run.sh --as my-experiment        # run all scenarios, name the run
#   bash run.sh --as test paginated       # filter by scenario name substring
#   bash run.sh --dim context-management  # filter by SDK dimension
#   bash run.sh --fast                    # run only fast synthetic-tool scenarios
#   bash run.sh list                      # list saved runs
#   bash run.sh dims                      # list dimensions and which scenarios each selects
#   bash run.sh transcript <name> [scenario]  # view transcript
#   bash run.sh --script foo.ts           # run a custom script directly
#
# Env vars:
#   CONCURRENCY=8                         # parallel scenario count (default 4)

set -e
cd "$(dirname "$0")"

if [ "$1" = "--script" ] && [ -n "$2" ]; then
  exec npx tsx "$2"
fi

exec npx tsx src/main.ts "$@"
