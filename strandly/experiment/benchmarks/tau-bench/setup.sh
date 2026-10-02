#!/usr/bin/env bash
# Sets up a Python venv with tau-bench installed.
# Run once before using the tau-bench scenario.
set -e
cd "$(dirname "$0")"

VENV_DIR=".venv"

if [ -d "$VENV_DIR" ]; then
  echo "venv already exists at $VENV_DIR"
else
  echo "Creating venv..."
  python3 -m venv "$VENV_DIR"
fi

echo "Installing tau-bench..."
"$VENV_DIR/bin/pip" install --quiet --upgrade pip
"$VENV_DIR/bin/pip" install --quiet "tau-bench @ git+https://github.com/sierra-research/tau-bench.git"
# boto3 is needed for litellm's bedrock provider (used for user simulation)
"$VENV_DIR/bin/pip" install --quiet boto3

# Verify the install works
echo "Verifying..."
"$VENV_DIR/bin/python" -c "from tau_bench.envs import get_env; from tau_bench.types import Action; print('tau-bench OK')"

echo ""
echo "Done. Run: bash run.sh --as test tau-bench"
