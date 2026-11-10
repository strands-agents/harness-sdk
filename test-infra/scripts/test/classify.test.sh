#!/usr/bin/env bash
set -euo pipefail

# Regression test for run-selective-ts.sh change classification.
#
# Feeds synthetic changed-file lists through the SELECTIVE_CHANGED_FILES test
# seam with SELECTIVE_DRY_RUN=1, so the script classifies into structural /
# skip / selective and exits before invoking git or vitest. No git state, no
# network, no live AWS. Run: bash test-infra/scripts/test/classify.test.sh

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/run-selective-ts.sh"

pass=0
fail=0

# expect_branch <expected> <description> <changed-files...>
# <expected> is one of: structural | skip | selective
expect_branch() {
  local expected="$1" desc="$2"
  shift 2
  local changed
  changed="$(printf '%s\n' "$@")"

  local out
  out="$(SELECTIVE_DRY_RUN=1 SELECTIVE_CHANGED_FILES="$changed" bash "$SCRIPT" 2>&1)"

  local actual
  case "$out" in
    *"Structural change detected"*) actual="structural" ;;
    *"No strands-ts source changes"*) actual="skip" ;;
    *"No changes detected"*) actual="skip" ;;
    *"Selective run for changed files"*) actual="selective" ;;
    *) actual="unknown" ;;
  esac

  if [[ "$actual" == "$expected" ]]; then
    pass=$((pass + 1))
    echo "ok   - $desc ($actual)"
  else
    fail=$((fail + 1))
    echo "FAIL - $desc: expected $expected, got $actual"
    echo "       output: $out"
  fi
}

# --- Structural: must force the full suite ---
expect_branch structural "root package.json" "package.json"
expect_branch structural "root lockfile" "package-lock.json"
expect_branch structural "strands-ts package.json" "strands-ts/package.json"
expect_branch structural "top-level tsconfig" "strands-ts/tsconfig.json"
expect_branch structural "nested src tsconfig" "strands-ts/src/tsconfig.json"
expect_branch structural "nested integ tsconfig" "strands-ts/test/integ/tsconfig.json"
expect_branch structural "vitest config" "strands-ts/vitest.config.ts"
expect_branch structural "shared integ fixture" "strands-ts/test/integ/__fixtures__/_setup-global.ts"
expect_branch structural "binary integ resource" "strands-ts/test/integ/__resources__/yellow.png"
expect_branch structural "the orchestration script itself" "test-infra/scripts/run-selective-ts.sh"
expect_branch structural "typescript CI workflow" ".github/workflows/typescript-ts-test.yml"
expect_branch structural "structural mixed with source" "README.md" "strands-ts/src/agent/agent.ts" "package.json"

# --- Skip: no strands-ts source touched ---
expect_branch skip "docs only" "site/docs/index.md"
expect_branch skip "root readme" "README.md"
expect_branch skip "python only" "strands-py/src/strands/agent.py"
expect_branch skip "empty change set" ""

# --- Selective: traceable source change ---
expect_branch selective "single src file" "strands-ts/src/agent/agent.ts"
expect_branch selective "src plus unrelated docs" "strands-ts/src/agent/agent.ts" "site/docs/x.md"
expect_branch selective "nested src file" "strands-ts/src/vended-tools/bash/types.ts"

echo "---"
echo "passed: $pass, failed: $fail"
[[ "$fail" -eq 0 ]]
