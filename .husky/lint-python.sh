#!/usr/bin/env sh
# Lint staged Python files against each project's own ruff config. strands-py/ and
# harness-py/ each carry their own [tool.ruff]; ruff resolves the nearest config per file,
# so one invocation covers both. Runs ruff only (no mypy) as a fast pre-filter; CI's lint
# job remains the source of truth. Range matches the root pyproject.toml and both SDKs so the
# hook and CI resolve the same ruff.
set -eu

RUFF_SPEC='ruff>=0.16.0,<0.17.0'

staged_python_files=$(
  git diff --cached --name-only --diff-filter=ACMR -- strands-py harness-py \
    | { grep -E '\.py$' || true; }
)

if [ -z "$staged_python_files" ]; then
  echo "No staged Python files under strands-py/ or harness-py/; skipping ruff."
  exit 0
fi

if ! command -v uvx >/dev/null 2>&1; then
  echo "uvx not found. Install uv (https://docs.astral.sh/uv/) to run the Python lint hook." >&2
  exit 1
fi

echo "Linting staged Python files with ruff..."
status=0
printf '%s\n' "$staged_python_files" | xargs uvx --from "$RUFF_SPEC" ruff check || status=1
printf '%s\n' "$staged_python_files" | xargs uvx --from "$RUFF_SPEC" ruff format --check || status=1
if [ "$status" -ne 0 ]; then
  echo "Python lint/format failed. Fix with 'ruff check --fix' and 'ruff format'. Commit aborted." >&2
  exit 1
fi
