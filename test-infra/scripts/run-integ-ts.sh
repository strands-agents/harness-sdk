#!/usr/bin/env bash
set -euo pipefail
# Runs the TypeScript integ suite once per vitest project and keeps one junit
# report per project:
#
#   bash test-infra/scripts/run-integ-ts.sh all                  # full suite
#   bash test-infra/scripts/run-integ-ts.sh related <files...>   # specs depending on <files> (relative to strands-ts/)
#
# The junit reporter's outputFile is fixed in strands-ts/vitest.config.ts and
# the report carries no project name, while integ-node and integ-browser run
# the same *.test.ts files. One invocation per project, with the report moved
# to <project>.xml afterwards, is what lets the metrics publisher attribute
# every testcase to its project. The json report is overwritten by the second
# project; nothing in CI reads it.
#
# Exits non-zero if any project fails, after both have run.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
JUNIT=test/.artifacts/test-report/junit
PROJECTS=(integ-node integ-browser)

mode="${1:-}"
case "$mode" in
  all|related) shift ;;
  *)
    echo "usage: $0 all | related <files...>" >&2
    exit 2
    ;;
esac

cd "$ROOT/strands-ts"
status=0
for project in "${PROJECTS[@]}"; do
  if [[ "$mode" == "all" ]]; then
    npx vitest run --project "$project" || status=1
  else
    npx vitest related "$@" --project "$project" --run || status=1
  fi
  if [[ -f "$JUNIT/report.xml" ]]; then
    mv "$JUNIT/report.xml" "$JUNIT/$project.xml"
  fi
done
exit "$status"
