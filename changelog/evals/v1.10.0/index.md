# Evals v1.10.0

Released 2026-11-16
Release: https://github.com/strands-agents/evals/releases/tag/v1.10.0 · Package: https://pypi.org/project/strands-agents-evals/1.10.0/

## Features
- add context backfilling to session-converter [generators, tracing] (https://github.com/strands-agents/evals/pull/497)
- add TypedRubricEvaluator for decision-model rubrics [evaluators] (https://github.com/strands-agents/evals/pull/493)
- add validation and review steps to session-converter [generators] (https://github.com/strands-agents/evals/pull/505)
- generalize session-converter to work with non-CLI session files [tracing] (https://github.com/strands-agents/evals/pull/525)
- add synthetic case generation to session-converter (https://github.com/strands-agents/evals/pull/529)

## Fixes
- make EvaluationReport.to\_file() reject non-strict JSON [core, devx] (https://github.com/strands-agents/evals/pull/393)
- cancel the workers when run\_evaluations\_async is cancelled [core] (https://github.com/strands-agents/evals/pull/521)
- preserve embedded CloudWatch span events [tracing] (https://github.com/strands-agents/evals/pull/522)

## Other
- add integration tests for output-level judge evaluators [evaluators] (https://github.com/strands-agents/evals/pull/407)
- skip multimodal evaluator tests pending reliable image host [multimodal] (https://github.com/strands-agents/evals/pull/536)
