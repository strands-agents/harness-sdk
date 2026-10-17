# Benchmark Data Licensing

This directory integrates third-party benchmarks. No benchmark data is committed
to the repo — it is installed at dev time via setup scripts.

## τ-bench

- **Source**: https://github.com/sierra-research/tau-bench
- **License**: MIT, Copyright (c) 2024 Sierra
- **Install**: `bash benchmarks/tau-bench/setup.sh` (pip installs into a local venv)
- **What it provides**: Retail and airline customer-service tasks with mock CRUD
  tools, a simulated user (LLM-driven), and deterministic scoring (DB state hash).

MIT permits unrestricted commercial use, modification, and redistribution with
the sole condition that the copyright notice is preserved (see `tau-bench/NOTICE`).
