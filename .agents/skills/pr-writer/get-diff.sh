#!/usr/bin/env bash
set -euo pipefail

# Find the closest base ref from common branch names across all remotes and local refs.

candidates=()
for ref in main master; do
  # Check local branch
  if git rev-parse --verify "$ref" &>/dev/null; then
    candidates+=("$ref")
  fi
  # Check all remote tracking refs (e.g. origin/main, upstream/main)
  for remote_ref in $(git for-each-ref --format='%(refname:short)' "refs/remotes/*/$ref" 2>/dev/null); do
    candidates+=("$remote_ref")
  done
done

if [[ ${#candidates[@]} -eq 0 ]]; then
  echo "ERROR: No base branch found." >&2
  exit 1
fi

BASE="${candidates[0]}"
best_distance=$(git rev-list --count "$BASE"..HEAD 2>/dev/null || echo 999999)

for ref in "${candidates[@]:1}"; do
  distance=$(git rev-list --count "$ref"..HEAD 2>/dev/null || echo 999999)
  if [[ "$distance" -lt "$best_distance" ]]; then
    BASE="$ref"
    best_distance="$distance"
  fi
done

if [[ "$best_distance" -eq 0 ]]; then
  echo "ERROR: HEAD has no commits ahead of $BASE. Nothing to diff." >&2
  exit 1
fi

echo "=== BASE: $BASE ==="
echo "=== BRANCH: $(git branch --show-current) ==="
echo ""
echo "=== COMMITS ==="
git log "$BASE"..HEAD --oneline
echo ""
echo "=== CHANGED FILES ==="
git diff "$BASE"...HEAD --name-status
echo ""
echo "=== DIFF STAT ==="
git diff "$BASE"...HEAD --stat
echo ""
echo "=== DIFF ==="
git diff "$BASE"...HEAD
