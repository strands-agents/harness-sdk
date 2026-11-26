/**
 * tau-bench multi-turn customer service benchmark (re-exports from benchmarks/tau-bench/).
 *
 * This is a thin entry point so the runner discovers it in `scenarios/`.
 * The real implementation lives in `benchmarks/tau-bench/scenario.ts`.
 *
 * Requires setup first:
 *   bash benchmarks/tau-bench/setup.sh
 *
 * Env vars:
 *   TAU_BENCH_ENV=retail            — environment (retail or airline)
 *   TAU_BENCH_LIMIT=5               — tasks to run (default 5, 0 = all)
 *   TAU_BENCH_USER_MODEL=bedrock/us.anthropic.claude-sonnet-4-20250514-v1:0  — model for user sim
 *   TAU_BENCH_USER_PROVIDER=bedrock                                         — litellm provider
 */

export { default } from '../benchmarks/tau-bench/scenario.js'
