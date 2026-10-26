#!/usr/bin/env bash
set -euo pipefail

# Selective TypeScript integration testing.
# Runs only the integ specs whose module graph depends on changed files.
# Falls back to the full suite on structural changes; skips when no TS source changed.
# Shared by local dev (npm run test:integ:selective) and CI.

# --- Resolve repo root so the script is callable from anywhere ---
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# DRY_RUN prints the chosen branch and exits before invoking any test command.
# Used by verification scenarios so they never trigger live AWS integ runs.
# Defined up top so it also short-circuits the early full-suite fallbacks below.
DRY_RUN="${SELECTIVE_DRY_RUN:-}"

# Run the entire integration suite. Used by the structural branch and by every
# fail-safe fallback, so the "what does a full run mean" decision lives in one
# place. Honours DRY_RUN (print intent, run nothing) and exits with the suite's
# status so a test failure surfaces as a non-zero script exit.
run_full_suite() {
  echo "$1" >&2
  [[ -n "$DRY_RUN" ]] && exit 0
  npm run test:integ:all
  exit $?
}

# --- Compute changed files ---
# Test seam: when SELECTIVE_CHANGED_FILES is defined (even empty) it overrides
# the git-derived change set, so the classification logic below can be exercised
# in isolation with no git state or network. ${VAR+x} detects "is it set",
# which lets a test assert the empty-set (skip) case distinctly from "unset".
# See test/classify.test.sh.
if [[ -n "${SELECTIVE_CHANGED_FILES+x}" ]]; then
  CHANGED="$(printf '%s' "$SELECTIVE_CHANGED_FILES" | grep -v '^$' || true)"
else
  # --- Determine the base ref to diff against ---
  # CI passes SELECTIVE_BASE_REF (the PR base SHA). Locally, discover the
  # closest of {origin/main, main, master, */main} — mirrors get-diff.sh.
  BASE="${SELECTIVE_BASE_REF:-}"
  if [[ -z "$BASE" ]]; then
    candidates=()
    for ref in main master; do
      git rev-parse --verify "$ref" &>/dev/null && candidates+=("$ref")
      for remote_ref in $(git for-each-ref --format='%(refname:short)' "refs/remotes/*/$ref" 2>/dev/null); do
        candidates+=("$remote_ref")
      done
    done
    if [[ ${#candidates[@]} -eq 0 ]]; then
      run_full_suite "WARNING: no base branch found; running full integration suite."
    fi
    BASE="${candidates[0]}"
    best=$(git rev-list --count "$BASE"..HEAD 2>/dev/null || echo 999999)
    for ref in "${candidates[@]:1}"; do
      d=$(git rev-list --count "$ref"..HEAD 2>/dev/null || echo 999999)
      if [[ "$d" -lt "$best" ]]; then BASE="$ref"; best="$d"; fi
    done
  fi

  # Diff the working tree against the merge-base so the local inner loop tests
  # what you just edited, including uncommitted edits. git diff only reports
  # tracked files, so untracked (new, not-yet-added) files are appended via
  # ls-files --others so brand-new source files select their covering tests too.
  # --exclude-standard honours .gitignore. On CI (HEAD == base SHA) there are no
  # local edits, so this reduces to the committed diff.
  MERGE_BASE="$(git merge-base "$BASE" HEAD 2>/dev/null || echo "$BASE")"
  CHANGED="$(git diff --name-only "$MERGE_BASE" 2>/dev/null)" || \
    run_full_suite "WARNING: cannot diff against $MERGE_BASE; running full integration suite."
  UNTRACKED="$(git ls-files --others --exclude-standard 2>/dev/null || true)"
  CHANGED="$(printf '%s\n%s' "$CHANGED" "$UNTRACKED" | grep -v '^$' || true)"
fi

if [[ -z "$CHANGED" ]]; then
  echo "No changes detected vs ${BASE:-base} — skipping integration tests."
  exit 0
fi

# --- Branch 1: structural fallback ---
# These paths force the FULL suite: the module-graph tracer cannot see them as
# dependencies of a test, so a change to any of them must fail safe rather than
# risk a narrowed (or empty) selective run.
STRUCTURAL_PATTERNS=(
  '^package\.json$'                            # root dependency manifest
  '^package-lock\.json$'                       # root lockfile
  '^strands-ts/package\.json$'                 # workspace manifest
  '^strands-ts/(.*/)?tsconfig.*\.json$'        # any tsconfig (src/ + test/integ/ define the $/sdk alias)
  '^strands-ts/vitest\.config\.ts$'            # vitest config (projects, aliases)
  '^strands-ts/test/integ/__fixtures__/'       # shared integ setup/fixtures
  '^strands-ts/test/integ/__resources__/'      # binary assets imported via Vite `?url` (not traced in reverse)
  '^test-infra/scripts/run-selective-ts\.sh$'  # this orchestration script
  '^\.github/workflows/typescript-'            # TypeScript CI workflows
)
STRUCTURAL="$(IFS='|'; echo "${STRUCTURAL_PATTERNS[*]}")"
if echo "$CHANGED" | grep -qE "$STRUCTURAL"; then
  run_full_suite "Structural change detected — running full integration suite."
fi

# --- Branch 2: no TS source changed ---
TS_SOURCE="$(echo "$CHANGED" | grep -E '^strands-ts/' || true)"
if [[ -z "$TS_SOURCE" ]]; then
  echo "No strands-ts source changes — skipping integration tests."
  exit 0
fi

# --- Branch 3: selective ---
# Pass changed source files to Vitest's module-graph tracer, scoped to both
# integ projects. vitest related exits 0 with "No test files found" when none
# depend on the changes — a valid skip.
#
# LOAD-BEARING ASSUMPTION (vitest v4, pinned in strands-ts/package.json): the
# "no covering spec" case exits 0, not non-zero. The whole "never skip a test
# that should run" invariant relies on this — a non-zero here would turn safe
# skips into red CI. If a future vitest major changes this, this branch must be
# revisited (and the version floor in package.json bumped deliberately).
echo "Selective run for changed files:"
echo "$TS_SOURCE" | sed 's/^/  /'
[[ -n "$DRY_RUN" ]] && exit 0
# Collect paths into an array (relative to strands-ts/) so filenames with
# spaces survive. while-read keeps this portable to macOS bash 3.2 (mapfile
# is bash 4+). TS_SOURCE is guaranteed non-empty by the Branch 2 check above.
files=()
while IFS= read -r f; do
  [[ -n "$f" ]] && files+=("$f")
done < <(echo "$TS_SOURCE" | sed -E 's#^strands-ts/##')
( cd strands-ts && npx vitest related "${files[@]}" \
    --project integ-node --project integ-browser --run )
