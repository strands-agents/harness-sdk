The largest v1 checkpoint. A mixture of experts: 26B total parameters with ~4B active per token. Highest JevBench score in the lineup. A **soup** of three seeds trained with `Qwen/Qwen3.5-4B` as teacher, with answers kept close to those of `StrandsAgents/strands-decider-2B-hobson-v19` (an earlier research model); each layer’s LoRA update is the exact mean of the three seeds, then calibrated. Loads the text decoder of `gemma-4-26B-A4B-it` only — this model reads text.

-   **Base model:** google/gemma-4-26B-A4B-it (MoE)
-   **Parameters:** 26B total, 4B active per token
-   **Image support:** no
-   **Training:** LoRA adapter + pointer head; soup of three seeds (LoRA rank 16 in each run, stored as one rank-48 adapter); Qwen/Qwen3.5-4B teacher; answers kept close to those of `strands-decider-2B-hobson-v19`, an earlier research model; then calibrated
-   **License:** Apache-2.0
-   **Hugging Face:** [StrandsAgents/strands-decider-26B-A4B-gemma4-v1-2610](https://huggingface.co/StrandsAgents/strands-decider-26B-A4B-gemma4-v1-2610)
-   **Mirror:** [amazon/strands-decider-26B-A4B-gemma4-v1-2610](https://huggingface.co/amazon/strands-decider-26B-A4B-gemma4-v1-2610)

## Benchmarks

| Metric | Value |
| --- | --- |
| JevBench public (231, window 4096) | 207/231 |
| JevBench Brier | 0.162 |
| JevBench ECE | 0.051 |
| Decision Index 0.2.1, balanced skill | 48.69 |
| Held-out short tasks (n=6,000) | 0.708 |
| GPU memory (bf16) | ~51 GB |
| Latency, H100 (median) | 245 ms |

Full per-skill numbers (including 12 code sub-tasks ranging 0.562–0.989) are on the [Hugging Face card](https://huggingface.co/StrandsAgents/strands-decider-26B-A4B-gemma4-v1-2610#results) and in [evaluation/results.md](https://github.com/strands-labs/strands-decider/blob/d427f3cfb43e22afbbfc2675c9df8dfdca739197/evaluation/results.md).

## Run it

```bash
pip install strands-decider
strands-decider serve StrandsAgents/strands-decider-26B-A4B-gemma4-v1-2610 \
  --device cuda --device-map auto --port 8000
```

Fits on one 80 GB GPU (H100). On smaller GPUs, split it with `--device-map auto` (served on four 48 GB L40S). See [Inference server](/docs/labs/strands-decider/inference/index.md) for the request shape and [SageMaker](/docs/labs/strands-decider/deployment/sagemaker/index.md) for multi-GPU hosting.

## When to pick it

-   You want the highest JevBench score in the lineup.
-   You can host a model of about 51 GB (one H100, or several smaller GPUs).
-   You want the best v1 result on hard, multi-step tasks: this model has the highest JevBench hard-tier score of the five. These tasks stay the weak spot of every v1 model (see Limitations).

## Limitations

-   Questions are read less than documents: with the state and options fixed, a changed question often gets the same answer.
-   Long, multi-step documents are the weak spot (JevBench hard tier lags its easy tier).
-   `score` and `noul` transfer poorly to rubrics and yes/no tasks unlike the training mix.
-   Calibration is one temperature per question type, fitted on held-out short classification; measure on your own traffic before trusting a threshold.