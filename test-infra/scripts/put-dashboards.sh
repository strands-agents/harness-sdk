#!/usr/bin/env bash
# Publishes every test-infra/dashboards/*.json to CloudWatch under the file's base name.
#
#   INTEG_TEST_ACCOUNT_ID=<id> bash test-infra/scripts/put-dashboards.sh   # needs cloudwatch:PutDashboard
#   bash test-infra/scripts/put-dashboards.sh --dry-run                       # only validates the JSON locally
#
# The region is pinned and the caller's account is asserted against INTEG_TEST_ACCOUNT_ID before any put, so
# ambient credentials for another account or region cannot create the dashboards somewhere else. A dashboard
# that CloudWatch accepts with validation messages fails the script, because such a dashboard renders with
# broken widgets.
#
# put-dashboard is idempotent and overwrites a dashboard of the same name in place, so the console URLs and
# the iframes that embed them keep working.
set -euo pipefail
REGION=us-east-1
ACCOUNT="${INTEG_TEST_ACCOUNT_ID:-}"
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../dashboards" && pwd)"
dry_run=0
[ "${1:-}" = "--dry-run" ] && dry_run=1

if [ "$dry_run" -eq 0 ]; then
  if [ -z "$ACCOUNT" ]; then
    echo "refusing to publish: set INTEG_TEST_ACCOUNT_ID to the integ test account id" >&2
    exit 1
  fi
  caller="$(aws sts get-caller-identity --region "$REGION" --query Account --output text)"
  if [ "$caller" != "$ACCOUNT" ]; then
    echo "refusing to publish: caller account $caller is not $ACCOUNT" >&2
    exit 1
  fi
fi

status=0
for file in "$dir"/*.json; do
  name="$(basename "$file" .json)"
  python3 -c 'import json, sys; json.load(open(sys.argv[1]))' "$file"
  if [ "$dry_run" -eq 1 ]; then
    echo "valid JSON: $name"
    continue
  fi
  echo "put-dashboard $name"
  messages="$(aws cloudwatch put-dashboard \
    --region "$REGION" \
    --dashboard-name "$name" \
    --dashboard-body "file://$file" \
    --query 'DashboardValidationMessages' \
    --output json)"
  case "$messages" in
    ""|"[]"|"null") ;;
    *)
      echo "validation messages for $name: $messages" >&2
      status=1
      ;;
  esac
done
exit "$status"
