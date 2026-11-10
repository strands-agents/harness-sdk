#!/usr/bin/env bash
#
# run-checks.sh — run the local equivalent of the CI merge gate for only the
# areas your changes touch.
#
# It mirrors `.github/workflows/ci.yml`: detect which of {python, typescript,
# docs} changed, then run each area's checks locally. Run from anywhere inside
# the repo.
#
# For each detected area it first runs the mechanical auto-fixers (code
# formatting, lint --fix, lockfile sync), then runs the checks and reports what
# the fixers could not resolve. The auto-fixers WRITE to working-tree files.
#
# Usage:
#   run-checks.sh [--base <ref>] [--all] [--list] [--heavy] [area...]
#
#   (no args)        Detect changed areas vs the auto-detected base (closest
#                    main/master across local + all remotes — fork-aware), plus
#                    staged + unstaged + untracked changes, then fix + check.
#   --base <ref>     Compare against <ref> instead of the auto-detected base.
#   --all            Fix + check every area regardless of what changed.
#   --list           Print the detected areas and the files that triggered
#                    them, then exit without fixing or checking.
#   --heavy          Also run slow/CI-parity steps that are skipped by default
#                    (browser test install + browser tests, package test, full
#                    Python version matrix). These are slow and may need extra
#                    system deps; CI runs them on every PR anyway.
#   area...          Explicit areas to run: python, typescript, docs.
#                    Overrides detection.
#
# Exit code is non-zero if any check fails after fixing. Each area runs
# independently so you see every failure, not just the first.
#
# NOTE: a clean run here does NOT guarantee CI is green. This runs your current
# OS + interpreter/node only — it does not reproduce CI's version/OS matrices
# (Python 3.10–3.14 × linux/win/mac; Node 22/24 × 3 OS) or the npm-pack
# out-of-tree smoke test. It clears the deterministic, single-platform
# failures (lint, format, types, build, unit tests) so CI rarely bounces.
set -uo pipefail

# --- locate repo root -------------------------------------------------------
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [[ -z "${REPO_ROOT}" ]]; then
  echo "error: not inside a git repository" >&2
  exit 2
fi
cd "${REPO_ROOT}" || exit 1

# --- args -------------------------------------------------------------------
BASE_REF=""        # empty = auto-detect; set by --base to force a specific ref
FORCE_ALL=0
LIST_ONLY=0
RUN_HEAVY=0
EXPLICIT_AREAS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      [[ $# -ge 2 ]] || { echo "error: --base requires a <ref>" >&2; exit 2; }
      BASE_REF="$2"; shift 2 ;;
    --all) FORCE_ALL=1; shift ;;
    --list) LIST_ONLY=1; shift ;;
    --heavy) RUN_HEAVY=1; shift ;;
    python|typescript|docs) EXPLICIT_AREAS+=("$1"); shift ;;
    -h|--help) sed -n '2,50p' "$0"; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; exit 2 ;;
  esac
done

# --- resolve the base commit ------------------------------------------------
# Diff committed branch work against a base. Works on forks with no config: scan
# main/master across local + ALL remotes (so origin/main and upstream/main are
# both candidates) and pick the closest ancestor of HEAD. This mirrors the
# base-finding in .agents/skills/pr-writer/get-diff.sh — a small, deliberate
# copy; keep the two in sync if the fork heuristics change. --base <ref> skips
# the scan. BASE_SHA is resolved once and reused; empty means no base (no commits
# ahead, or a fresh detached checkout), in which case the base diff is skipped
# and staged/unstaged/untracked files are still checked — the normal case when
# you haven't committed yet.
# Sets globals BASE_SHA (the merge-base commit, or empty) and BASE_DISPLAY (a
# human label for the report).
BASE_SHA=""
BASE_DISPLAY=""
resolve_base_sha() {
  if [[ -n "${BASE_REF}" ]]; then
    BASE_SHA="$(git merge-base "${BASE_REF}" HEAD 2>/dev/null || true)"
    BASE_DISPLAY="${BASE_REF}"
    return
  fi
  local candidates=() ref remote_ref best="" best_dist=999999 dist
  for ref in main master; do
    git rev-parse --verify --quiet "${ref}" >/dev/null 2>&1 && candidates+=("${ref}")
    for remote_ref in $(git for-each-ref --format='%(refname:short)' "refs/remotes/*/${ref}" 2>/dev/null); do
      candidates+=("${remote_ref}")
    done
  done
  for ref in "${candidates[@]:-}"; do
    [[ -z "${ref}" ]] && continue
    dist="$(git rev-list --count "${ref}..HEAD" 2>/dev/null || echo 999999)"
    if [[ "${dist}" -lt "${best_dist}" ]]; then best="${ref}"; best_dist="${dist}"; fi
  done
  if [[ -n "${best}" ]]; then
    BASE_SHA="$(git merge-base "${best}" HEAD 2>/dev/null || true)"
    BASE_DISPLAY="${best}"
  fi
}
resolve_base_sha

# --- collect the changed file list ------------------------------------------
# Pre-commit reality: committed-since-base, staged, unstaged, AND untracked
# files, so the script works whether or not you've staged, and catches brand-new
# files (a new module would be invisible to `git diff` alone).
changed_files() {
  {
    if [[ -n "${BASE_SHA}" ]]; then
      git diff --name-only "${BASE_SHA}...HEAD"
    fi
    git diff --name-only HEAD                      # unstaged (tracked)
    git diff --name-only --cached                  # staged
    git ls-files --others --exclude-standard       # untracked, not git-ignored
  } | sort -u | grep -v '^$' || true
}

# --- path filters -----------------------------------------------------------
# A file matches an area if it matches any of these glob prefixes. Returns 0
# (match) / 1 (no match). Each area mirrors CI's filter in ci.yml.
matches_python() {
  case "$1" in
    strands-py/*|.github/workflows/python-*|.github/workflows/ci.yml) return 0 ;;
  esac
  return 1
}
matches_typescript() {
  case "$1" in
    strands-ts/*) return 0 ;;
    package.json|package-lock.json) return 0 ;;
    .github/workflows/typescript-*|.github/workflows/ci.yml) return 0 ;;
  esac
  return 1
}
matches_docs() {
  case "$1" in
    site/*|.github/workflows/docs-*|.github/workflows/ci.yml) return 0 ;;
  esac
  return 1
}

# --- decide which areas to run ----------------------------------------------
# Plain scalars (not associative arrays) so this runs on the bash 3.2 that
# ships with macOS. One flag + one file list per area.
AREA_ON_python=0;     AREA_FILES_python=""
AREA_ON_typescript=0; AREA_FILES_typescript=""
AREA_ON_docs=0;       AREA_FILES_docs=""

if [[ ${#EXPLICIT_AREAS[@]} -gt 0 ]]; then
  for a in "${EXPLICIT_AREAS[@]}"; do
    case "$a" in
      python)     AREA_ON_python=1 ;;
      typescript) AREA_ON_typescript=1 ;;
      docs)       AREA_ON_docs=1 ;;
    esac
  done
elif [[ ${FORCE_ALL} -eq 1 ]]; then
  AREA_ON_python=1; AREA_ON_typescript=1; AREA_ON_docs=1
else
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    if matches_python "$f";     then AREA_ON_python=1;     AREA_FILES_python+="  $f"$'\n'; fi
    if matches_typescript "$f"; then AREA_ON_typescript=1; AREA_FILES_typescript+="  $f"$'\n'; fi
    if matches_docs "$f";       then AREA_ON_docs=1;       AREA_FILES_docs+="  $f"$'\n'; fi
  done < <(changed_files)
fi

# --- report what we found ---------------------------------------------------
if [[ -n "${BASE_SHA}" ]]; then
  echo "Base:          ${BASE_DISPLAY} (${BASE_SHA:0:9})"
else
  echo "Base:          none — checking staged/unstaged/untracked only"
fi
echo "Detected areas:"
[[ ${AREA_ON_python} -eq 1 ]]     && echo "  - python"
[[ ${AREA_ON_typescript} -eq 1 ]] && echo "  - typescript"
[[ ${AREA_ON_docs} -eq 1 ]]       && echo "  - docs"
if [[ ${AREA_ON_python} -eq 0 && ${AREA_ON_typescript} -eq 0 && ${AREA_ON_docs} -eq 0 ]]; then
  echo "  (none — no changed files matched any locally-checkable area)"
fi

if [[ ${LIST_ONLY} -eq 1 ]]; then
  echo
  if [[ ${AREA_ON_python} -eq 1     && -n "${AREA_FILES_python}" ]];     then echo "python files:";     printf '%s' "${AREA_FILES_python}"; fi
  if [[ ${AREA_ON_typescript} -eq 1 && -n "${AREA_FILES_typescript}" ]]; then echo "typescript files:"; printf '%s' "${AREA_FILES_typescript}"; fi
  if [[ ${AREA_ON_docs} -eq 1       && -n "${AREA_FILES_docs}" ]];       then echo "docs files:";       printf '%s' "${AREA_FILES_docs}"; fi
  exit 0
fi

# --- runner helpers ---------------------------------------------------------
FAILED_AREAS=()
FAILED_STEPS=()
FAILED_SNIPPETS=()
# Output is buffered through a temp file so child processes never block on pipe
# backpressure (see commit message). This means no streaming/color in interactive
# use — acceptable since the only consumer is agents.
run_step() {  # run_step "label" cmd args...
  local label="$1"; shift
  echo
  echo "  > ${label}"
  local _outfile rc=0
  _outfile="$(mktemp "${TMPDIR:-/tmp}/run-checks.XXXXXX")" || { "$@"; return; }
  trap 'rm -f "${_outfile:-}"' RETURN
  "$@" > "$_outfile" 2>&1 || rc=$?
  cat "$_outfile"
  if [[ $rc -ne 0 ]]; then
    echo "  FAILED: ${label}" >&2
    FAILED_STEPS+=("${label}")
    FAILED_SNIPPETS+=("$(tail -20 "$_outfile")")
  fi
  [[ $rc -eq 0 ]]
}

# A fixer that errors is reported but does not fail the area; the checks that
# follow decide pass/fail.
fix_step() {  # fix_step "label" cmd args...
  local label="$1"; shift
  echo
  echo "  fix: ${label}"
  "$@" || echo "  fixer errored (continuing to checks): ${label}" >&2
}

# pipe_fix "label" '<file-list-producer>' cmd args... — run a scoped fixer over
# the NUL-delimited file list from <producer>, via xargs -0r so each filename
# (spaces and all) is passed as one argument and nothing runs when the list is
# empty. Same "report-but-don't-fail" semantics as fix_step.
pipe_fix() {
  local label="$1" producer="$2"; shift 2
  echo
  echo "  fix: ${label}"
  eval "${producer}" | xargs -0r "$@" \
    || echo "  fixer errored (continuing to checks): ${label}" >&2
}

# Each area has a fix_* function (mechanical auto-fixers, never fails the run)
# and a check_* function (the gate, sets pass/fail). Phase 1 runs all selected
# fixers, then phase 2 runs all selected checks on the now-fixed tree.

have_hatch() {
  command -v hatch >/dev/null 2>&1 && return 0
  echo "  'hatch' not found — install with: pip install hatch" >&2
  return 1
}
have_npm() {
  command -v npm >/dev/null 2>&1 && return 0
  echo "  'npm' not found" >&2
  return 1
}

# Fixers are scoped to the files your change touches, so they never reformat
# unrelated files into your commit. The project's own commands (hatch fmt,
# npm run format/lint) cannot be scoped — they always act on the whole tree —
# so the fixers call the underlying tools (ruff, prettier, eslint) directly
# with an explicit file list. The CHECK phase still uses the project commands
# tree-wide, for exact CI parity.
#
# changed_z <pathspec...> — emit the changed files in the CURRENT directory that
# match the git <pathspec>(s), NUL-delimited and relative to the current dir, so
# they can be piped straight to a fixer. Uses git's own machine interface: -z
# for safe filenames, --relative for cwd-relative paths, --diff-filter=d to drop
# deletions, ls-files for new/untracked files. Consume with `xargs -0r`. Run it
# from inside the subproject. Emits nothing if no files match.
changed_z() {
  {
    if [[ -n "${BASE_SHA}" ]]; then
      git diff --name-only -z --relative --diff-filter=d "${BASE_SHA}...HEAD" -- "$@"
    fi
    git diff --name-only -z --relative --diff-filter=d -- "$@"          # unstaged
    git diff --name-only -z --relative --diff-filter=d --cached -- "$@" # staged
    git ls-files --others --exclude-standard -z -- "$@"                 # untracked
  } | sort -zu
}

# --- Python: mirrors python-test-lint.yml -----------------------------------
# Scoped to changed strands-py/ .py files via ruff directly (hatch fmt cannot
# be scoped). ruff lives in the hatch-static-analysis env.
fix_python() {
  have_hatch || return 0
  ( cd strands-py || exit 1
    if [[ -z "$(changed_z '*.py')" ]]; then
      echo; echo "  fix: no changed strands-py/ .py files to format"
      exit 0
    fi
    pipe_fix "format (ruff format, scoped)" \
      'changed_z "*.py"' hatch run hatch-static-analysis:ruff format
    pipe_fix "lint autofix (ruff check --fix, scoped)" \
      'changed_z "*.py"' hatch run hatch-static-analysis:ruff check --fix
  )
}
# CI runs: hatch fmt --linter --check (lint) + hatch test tests --cover (matrix
# py3.10–3.14 × linux/win/mac). Locally we check on the current interpreter;
# --heavy runs hatch test --all (all installed Python versions).
check_python() {
  have_hatch || return 1
  local ok=1
  ( cd strands-py || exit 1
    run_step "lint (hatch fmt --linter --check)" hatch fmt --linter --check || exit 1
    if [[ ${RUN_HEAVY} -eq 1 ]]; then
      run_step "unit tests, all Python versions (hatch test --all)" hatch test --all || exit 1
    else
      run_step "unit tests (hatch test tests --cover)" hatch test tests --cover || exit 1
    fi
  ) || ok=0
  return $((1 - ok))
}

# --- TypeScript: mirrors typescript-pr-and-push.yml fan-out -----------------
# Scoped to changed strands-ts/ files via prettier/eslint directly. eslint only
# lints src + test/integ (per package.json), so scope the autofix to those.
# npm install (lockfile sync) is inherently whole-repo but only writes the
# lockfile, which is itself part of a dependency change — so it doesn't pollute.
fix_typescript() {
  have_npm || return 0
  ( cd strands-ts || exit 1
    if [[ -z "$(changed_z '.')" ]]; then
      echo; echo "  fix: no changed strands-ts/ files to format"
    else
      # prettier: all changed ts files (--ignore-unknown skips what it can't parse).
      pipe_fix "format (prettier --write, scoped)" \
        "changed_z '.'" npx prettier --ignore-unknown --write
      # eslint only covers src/ and test/integ/ (per package.json); scope to those.
      if [[ -n "$(changed_z 'src/' 'test/integ/')" ]]; then
        pipe_fix "lint autofix (eslint --fix, scoped)" \
          "changed_z 'src/' 'test/integ/'" npx eslint --fix
      fi
    fi
  )
  # lockfile sync only matters when package.json / lockfile changed.
  if [[ -n "$(changed_z 'package.json' 'package-lock.json')" ]]; then
    fix_step "lockfile sync (npm install)" npm install
  fi
}
# CI runs (across jobs): build, lint, format:check, type-check,
# check:browser-bundle, test:all:coverage, test:package, npm-pack smoke test,
# and npm audit --audit-level=high. Locally we run the deterministic subset;
# --heavy adds browser tests + test:package. The npm-pack smoke test stays in CI.
# CI dropped its package-lock drift check in #2841 (to unblock Dependabot/audit
# fixes), so we no longer check drift either — the fixer above still runs
# `npm install` to keep the lockfile synced when a dependency change touched it.
check_typescript() {
  have_npm || return 1
  local ok=1
  # build first: workspace type resolution + integ type-check need dist/.
  run_step "build (npm run build)"            npm run build           || ok=0
  run_step "lint (npm run lint)"              npm run lint            || ok=0
  run_step "format check (npm run format:check)" npm run format:check || ok=0
  run_step "type-check (npm run type-check)"  npm run type-check      || ok=0
  run_step "browser bundle (npm run check:browser-bundle)" npm run check:browser-bundle || ok=0
  run_step "npm audit (--audit-level=high)"   npm audit --audit-level=high || ok=0

  if [[ ${RUN_HEAVY} -eq 1 ]]; then
    run_step "browser install (npm run test:browser:install)" npm run test:browser:install || ok=0
    run_step "all tests + coverage (npm run test:all:coverage)" npm run test:all:coverage || ok=0
    run_step "package test (npm run test:package)" npm run test:package || ok=0
  else
    run_step "unit tests + coverage (npm run test:coverage)" npm run test:coverage || ok=0
    echo "  skipped (CI-only / --heavy): browser tests, test:package, npm-pack smoke test"
  fi
  return $((1 - ok))
}

# --- Docs: mirrors docs-ci.yml ----------------------------------------------
# Scoped to changed site/ files via prettier directly (--ignore-unknown skips
# files prettier has no parser for, e.g. images).
fix_docs() {
  have_npm || return 0
  ( cd site || exit 1
    if [[ -z "$(changed_z '.')" ]]; then
      echo; echo "  fix: no changed site/ files to format"
      exit 0
    fi
    pipe_fix "format (prettier --write, scoped)" \
      "changed_z '.'" npx prettier --ignore-unknown --write
  )
}
# CI runs (in site/): cms:build, typecheck, build the TS SDK + relink,
# typecheck:snippets, npm test.
check_docs() {
  have_npm || return 1
  local ok=1
  ( cd site || exit 1
    run_step "build (npm run cms:build)"          npm run cms:build         || exit 1
    run_step "typecheck (npm run typecheck)"      npm run typecheck         || exit 1
    run_step "snippet typecheck (npm run typecheck:snippets)" npm run typecheck:snippets || exit 1
    run_step "tests (npm test)"                   npm test                  || exit 1
  ) || ok=0
  return $((1 - ok))
}

# --- phase 1: fix -----------------------------------------------------------
echo
echo "### PHASE 1: auto-fix ###"
[[ ${AREA_ON_python} -eq 1 ]]     && { echo; echo "=== python ===";     fix_python; }
[[ ${AREA_ON_typescript} -eq 1 ]] && { echo; echo "=== typescript ==="; fix_typescript; }
[[ ${AREA_ON_docs} -eq 1 ]]       && { echo; echo "=== docs ===";       fix_docs; }

# --- phase 2: check ---------------------------------------------------------
echo
echo "### PHASE 2: check ###"
if [[ ${AREA_ON_python} -eq 1 ]]; then
  echo; echo "=== python ==="
  check_python || FAILED_AREAS+=("python")
fi
if [[ ${AREA_ON_typescript} -eq 1 ]]; then
  echo; echo "=== typescript ==="
  check_typescript || FAILED_AREAS+=("typescript")
fi
if [[ ${AREA_ON_docs} -eq 1 ]]; then
  echo; echo "=== docs ==="
  check_docs || FAILED_AREAS+=("docs")
fi

# --- summary ----------------------------------------------------------------
echo
echo "============================================"
if [[ ${#FAILED_AREAS[@]} -eq 0 ]]; then
  echo "All local checks passed."
  echo "  Reminder: CI also runs OS/version matrices + npm-pack smoke test not reproduced here."
  exit 0
else
  echo "Failures in: ${FAILED_AREAS[*]}"
  echo
  for i in "${!FAILED_STEPS[@]}"; do
    echo "--- FAILED: ${FAILED_STEPS[$i]} ---"
    echo "${FAILED_SNIPPETS[$i]}"
    echo
  done
  exit 1
fi
