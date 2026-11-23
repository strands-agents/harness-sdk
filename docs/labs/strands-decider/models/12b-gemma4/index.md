The dense Gemma 4 12B v1 checkpoint: a LoRA adapter on `google/gemma-4-12B-it` plus a small pointer head. The most accurate dense model of the v1 line: 200 of 231 on JevBench (the 26B-A4B has 207). The checkpoint is a soup of three seeds, each trained with a `Qwen/Qwen3.5-4B` teacher, with its answers kept close to those of `strands-decider-2B-hobson-v19` (an earlier research model).

-   **Base model:** google/gemma-4-12B-it
-   **Parameters:** 12B
-   **Image support:** no (text decoder only)
-   **Training:** LoRA adapter + pointer head; soup of three seeds (LoRA rank 16 in each run, stored as one rank-48 adapter); Qwen/Qwen3.5-4B teacher; answers kept close to those of `strands-decider-2B-hobson-v19`, an earlier research model; then calibrated
-   **License:** Apache-2.0
-   **Hugging Face:** [StrandsAgents/strands-decider-12B-gemma4-v1-2610](https://huggingface.co/StrandsAgents/strands-decider-12B-gemma4-v1-2610)
-   **Mirror:** [amazon/strands-decider-12B-gemma4-v1-2610](https://huggingface.co/amazon/strands-decider-12B-gemma4-v1-2610)

## Benchmarks

| Metric | Value |
| --- | --- |
| JevBench public, window 4096 | 200/231 |
| JevBench Brier | 0.173 |
| JevBench ECE | 0.061 |
| Decision Index 0.2.1 (window 32,768) | 47.14 |
| Held-out short tasks (n=6,000) | 0.708 |
| Held-out code tasks (n=1,996) | 0.870 |
| HotpotQA, never trained on (n=959) | 0.911 |

Full per-task table in the [model card](https://huggingface.co/StrandsAgents/strands-decider-12B-gemma4-v1-2610) and in [evaluation/results.md](https://github.com/strands-labs/strands-decider/blob/ecdb331493761f889351d3ca4936a9ef4e758b33/evaluation/results.md).

## Run it

```bash
pip install strands-decider
strands-decider serve StrandsAgents/strands-decider-12B-gemma4-v1-2610 --port 8000
```

Split across multiple GPUs if needed:

```bash
strands-decider serve StrandsAgents/strands-decider-12B-gemma4-v1-2610 \
  --device cuda --device-map auto --port 8000
```

See [Inference server](/docs/labs/strands-decider/inference/index.md) for the request shape.

## When to pick it

-   You have one 48 GB GPU (L40S) or larger, or several smaller GPUs with `--device-map auto`.
-   You want the best dense-model accuracy without stepping up to a mixture of experts.
-   You’re on text-only inputs — this checkpoint drops Gemma 4’s vision and audio encoders at load.

## Limitations

-   Questions are read less than documents: with the state and options fixed, a changed question often gets the same answer.
-   Long multi-step documents are the weak spot: JevBench’s hard tier scores far below its easy tier.
-   `score` / `noul` transfer poorly to rubrics and yes/no tasks unlike the training mix — train on a rubric like yours.
-   Calibration is one temperature per question type, fitted on held-out short classification; measure on your own traffic before trusting a threshold.