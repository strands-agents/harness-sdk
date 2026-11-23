The mid-size Gemma 4 v1 checkpoint. A LoRA adapter on `google/gemma-4-E4B-it` plus a small pointer head; the base’s vision and audio encoders are dropped at load, so this model reads text only. The release is a **soup of three seeds** of the same recipe, then calibrated.

-   **Base model:** google/gemma-4-E4B-it
-   **Parameters:** 4B effective
-   **Image support:** no
-   **Training:** LoRA adapter + pointer head; soup of three seeds (LoRA rank 16 in each run, stored as one rank-48 adapter); Qwen/Qwen3.5-4B teacher; answers kept close to those of `strands-decider-2B-hobson-v19`, an earlier research model; then calibrated
-   **License:** Apache-2.0
-   **Hugging Face:** [StrandsAgents/strands-decider-E4B-gemma4-v1-2610](https://huggingface.co/StrandsAgents/strands-decider-E4B-gemma4-v1-2610)
-   **Mirror:** [amazon/strands-decider-E4B-gemma4-v1-2610](https://huggingface.co/amazon/strands-decider-E4B-gemma4-v1-2610)

## Benchmarks

| Metric | Value |
| --- | --- |
| JevBench public (window 4096) | 187 / 231 |
| JevBench Brier | 0.243 |
| JevBench ECE | 0.037 |
| Decision Index 0.2.1, balanced skill (window 32,768) | 39.42 |
| Held-out short tasks (n=6,000) | 0.684 |
| Held-out code tasks (n=1,996) | 0.815 |

Full per-skill numbers in the HF card and in [evaluation/results.md](https://github.com/strands-labs/strands-decider/blob/d427f3cfb43e22afbbfc2675c9df8dfdca739197/evaluation/results.md).

## Run it

```bash
pip install strands-decider
strands-decider serve StrandsAgents/strands-decider-E4B-gemma4-v1-2610 --port 8000
```

See [Inference server](/docs/labs/strands-decider/inference/index.md) for the request shape.

## When to pick it

-   The model must share one GPU with other work.
-   You have one 24 GB GPU (L4, A10G).
-   Text-only is fine. Pick [2B-qwen3.5](/docs/labs/strands-decider/models/2b-qwen3-5/index.md) if you need images.

## Limitations

-   Questions are read less than documents: with the state and options fixed, a changed question often gets the same answer.
-   Long, multi-step documents are the weak spot (JevBench hard tier lags its easy tier).
-   `score` and `noul` transfer poorly to rubrics and yes/no tasks unlike the training mix.
-   Calibration is one temperature per question type, fitted on held-out short classification; measure on your own traffic before trusting a threshold.