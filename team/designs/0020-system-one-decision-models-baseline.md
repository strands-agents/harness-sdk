# 0020 companion: System One vs LLM baseline

**Status**: Measured

**Date**: 2026-09-24

**Design**: [0020 System One Decision Models](./0020-system-one-decision-models.md)

**Issue**: [#4551](https://github.com/strands-agents/harness-sdk/issues/4551)

The design asserts that a System One model is a faster and cheaper way to make typed decisions at comparable quality, and that its calibrated confidence enables a cascade no LLM classifier can drive. This document tests those claims on public labeled data before any API is built on them. Every number here comes from the scripts in [`0020-system-one-decision-models/`](./0020-system-one-decision-models/); rerun them to reproduce.

## What was measured

Three decision tasks, each one of the design's use cases, on public test splits:

| Task               | Use case              | Question                                                     | Data                                                                                                                          |
| ------------------ | --------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `banking77`        | routing / handoff     | Choice over 77 support intents                               | [banking77](https://huggingface.co/datasets/legacy-datasets/banking77) test, 200 sampled                                      |
| `clinc_oos`        | routing with no-match | Choice over 150 intents plus an explicit out-of-scope option | [clinc_oos](https://huggingface.co/datasets/clinc/clinc_oos) `plus` test, 200 sampled (30 out-of-scope)                       |
| `prompt_injection` | guardrail             | YesNo: is this a prompt injection or jailbreak?              | [deepset/prompt-injections](https://huggingface.co/datasets/deepset/prompt-injections) test, all 116 (about one third German) |

Three arms answer **identical questions**: the same instructions and the same option descriptions, with the message as state.

- **Jev** (`jev-latest`, which answered as `jev-1.13.0`) through `POST /v1/systemone`.
- **Claude Haiku 4.5** and **Amazon Nova Micro** on Amazon Bedrock (`us-west-2`, temperature 0) through Converse with a forced single tool whose input schema is the closed answer space (an enum for Choice, a boolean for YesNo). This is the strongest fair LLM framing: the model cannot answer outside the options and emits only a few output tokens.

Samples are seeded (`4551`) and one request is made per item at concurrency 4. Prices are per million tokens, taken from the AWS Pricing API for us-west-2 on-demand (Haiku 4.5 $1.10 input / $5.50 output; Nova Micro $0.035 / $0.14) and from [docs.typesafe.ai/models](https://docs.typesafe.ai/models) (Jev $0.042 input, output free), retrieved 2026-09-24. Latency is client-observed from the same host (`us-west-2` for Bedrock, the public TypeSafe endpoint for Jev) and includes network time.

## Results

Accuracy with a 95% bootstrap CI (5,000 resamples). "Δ vs Haiku" is the paired difference on the same items.

| Task             | Arm           | Accuracy [95% CI]        | Δ vs Haiku [95% CI]         | p50 / p95 latency | $ per 1k decisions |
| ---------------- | ------------- | ------------------------ | --------------------------- | ----------------- | ------------------ |
| banking77        | **Jev**       | 0.790 [0.730, 0.845]     | +0.030 [−0.015, +0.075]     | 0.51 s / 0.57 s   | **$0.071**         |
|                  | Haiku 4.5     | 0.760 [0.700, 0.820]     | —                           | 0.85 s / 0.96 s   | $2.69              |
|                  | Nova Micro    | 0.610 [0.545, 0.675]     | −0.150                      | 0.48 s / 0.59 s   | $0.072             |
| clinc_oos        | **Jev**       | 0.880 [0.835, 0.925]     | +0.000 [−0.050, +0.050]     | 0.52 s / 0.58 s   | **$0.106**         |
|                  | Haiku 4.5     | 0.880 [0.835, 0.920]     | —                           | 0.83 s / 0.91 s   | $3.14              |
|                  | Nova Micro    | 0.625 [0.560, 0.695]     | −0.255                      | 0.48 s / 0.58 s   | $0.089             |
| prompt_injection | Jev           | 0.759 [0.672, 0.836]     | **−0.112 [−0.172, −0.052]** | 0.50 s / 0.56 s   | $0.016             |
|                  | **Haiku 4.5** | **0.871** [0.810, 0.931] | —                           | 0.76 s / 0.83 s   | $1.03              |
|                  | Nova Micro    | 0.750 [0.664, 0.828]     | −0.121                      | 0.43 s / 0.53 s   | $0.020             |

On prompt injection, precision was 1.00 for both Jev and Haiku; recall was 0.53 for Jev and 0.75 for Haiku. Jev's recall was the same on English (0.54) and German (0.52) items, so the gap is not a language effect.

### Confidence lets code trade coverage for accuracy

Jev's confidence is informative. Acting only on answers at or above a confidence floor raises accuracy on the answers kept (YesNo confidence is `|p − 0.5| × 2`):

| Task             | Floor     | Coverage  | Accuracy on covered |
| ---------------- | --------- | --------- | ------------------- |
| banking77        | 0.7 / 0.9 | 82% / 66% | 0.854 / 0.924       |
| clinc_oos        | 0.7 / 0.9 | 90% / 74% | 0.939 / 0.980       |
| prompt_injection | 0.7 / 0.9 | 81% / 62% | 0.819 / 0.917       |

The LLM arms produce no such signal: the forced tool call returns one answer with no distribution.

### The cascade the design proposes

The `DecisionAgent(fallback=...)` placement asks Jev first and sends answers below the floor to the LLM. We simulated it from the recorded per-item answers, with no new calls. Every item pays for Jev; escalated items also pay for Haiku and its latency.

| Task             | Floor | Escalated | Accuracy [95% CI]    | Δ vs Haiku-only [95% CI] | $ per 1k     | p50 / p95       |
| ---------------- | ----- | --------- | -------------------- | ------------------------ | ------------ | --------------- |
| banking77        | 0.7   | 18%       | 0.790 [0.735, 0.845] | +0.030 [+0.005, +0.060]  | $0.56 (−79%) | 0.52 s / 1.40 s |
| clinc_oos        | 0.8   | 16%       | 0.920 [0.880, 0.955] | +0.040 [+0.010, +0.075]  | $0.62 (−80%) | 0.53 s / 1.36 s |
| prompt_injection | 0.9   | 38%       | 0.862 [0.793, 0.922] | −0.009 [−0.026, +0.000]  | $0.42 (−60%) | 0.53 s / 1.31 s |

## What this supports, and what it does not

**Supported.**

- **Cost.** At equal or better accuracy on routing, Jev is 38× cheaper than Haiku 4.5 per decision on banking77 and 30× cheaper on clinc_oos. Jev and Nova Micro cost about the same, but Jev is 18 and 25.5 points more accurate.
- **Latency.** Jev's p50 is 0.25 to 0.35 s lower than Haiku's on every task, and its p95 tail is tight (under 0.6 s). Nova Micro is slightly faster than Jev and much less accurate.
- **Quality on routing.** Jev is statistically tied with Haiku on both routing tasks: the paired CIs include zero.
- **Calibrated confidence is the differentiator.** The cascade beats Haiku-only on routing accuracy (with CIs excluding zero) at about a fifth of the cost. Median latency stays at Jev's; only the escalated tail pays for the LLM. This is the design's central claim, and it holds.

**Not supported, or not yet.**

- **Guardrails are not a clean win.** On prompt injection, Jev alone trails Haiku by 11 points, all of it recall. The cascade closes the gap to within noise at 60% lower cost, but only with a high floor (0.9) that escalates 38% of traffic. The design already defaults guards to fail closed and shows the cascade. The docs must not claim System One is as accurate as an LLM for security classification. It is a cheap first pass that knows when it is unsure.
- **Wording was not tuned per arm.** One question wording served all arms. A prompt tuned for one model could move its numbers, so treat each arm's result as a lower bound.
- **Small samples.** With 116 to 200 items per task, the CIs are ±4 to 8 points. The routing ties are "not distinguishable at this n", not proof of equality.
- **Not measured here:** model selection quality (samples 2 and 3 in the P0 plan cover it), multi-question fan-out cost against an LLM (Jev's per-request latency is flat in question count, per the design's measurements), and non-English routing.

## Consequences for the design

1. Keep the cascade (`fallback=` with a confidence floor) as the recommended placement for anything security-adjacent, and say so in the placement guide.
2. `DecisionGuard` keeps failing closed by default. Its docs should cite this measurement rather than claim parity.
3. The samples' `--engine llm` switch should stay, because the right engine is a per-task empirical question, which is the point of letting one schema run on both.

## Reproduce

```bash
cd team/designs/0020-system-one-decision-models
python fetch_datasets.py                       # public slices -> data/
export TYPESAFE_API_KEY=...; export AWS_PROFILE=...   # Bedrock in us-west-2
python bench.py --arms jev,us.anthropic.claude-haiku-4-5-20251001-v1:0,us.amazon.nova-micro-v1:0
python analyze.py && python cascade.py
```

`analyze.py --arms short=id,...` and `cascade.py --fast <id> --slow <id>` take the same arm ids as `bench.py --arms`, so another arm (a self-hosted Kev server, a different LLM) runs through the same analysis. Accuracy counts an errored item (an API or parse failure) as incorrect. Latency, tokens and cost are computed over non-errored items. Every arm's `errors` count is in the summary. In the published run it is 0 for every arm and task, so no reported accuracy includes an error.

Committed summaries: [`results-summary.json`](./0020-system-one-decision-models/results-summary.json) and [`results-cascade.json`](./0020-system-one-decision-models/results-cascade.json). Per-item results are regenerated by `bench.py`.
