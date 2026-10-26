#!/usr/bin/env bash
# Publishes every test-infra/dashboards/*.json to CloudWatch under the file's base name.
#
#   bash test-infra/scripts/put-dashboards.sh            # needs cloudwatch:PutDashboard on the target account
#   bash test-infra/scripts/put-dashboards.sh --dry-run  # only validates the JSON locally
#
# put-dashboard is idempotent and overwrites a dashboard of the same name in place, so the console URLs and
# the iframes that embed them keep working.
set -euo pipefail

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../dashboards" && pwd)"
dry_run=0
[ "${1:-}" = "--dry-run" ] && dry_run=1

for file in "$dir"/*.json; do
  name="$(basename "$file" .json)"
  python3 -c 'import json, sys; json.load(open(sys.argv[1]))' "$file"
  if [ "$dry_run" -eq 1 ]; then
    echo "valid JSON: $name"
    continue
  fi
  echo "put-dashboard $name"
  aws cloudwatch put-dashboard \
    --dashboard-name "$name" \
    --dashboard-body "file://$file" \
    --query 'DashboardValidationMessages' \
    --output json
done
