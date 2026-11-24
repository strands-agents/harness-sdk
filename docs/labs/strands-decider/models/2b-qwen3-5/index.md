The Qwen3.5-based v1 checkpoint. It is the only v1 model that keeps its base model’s vision tower, so it can answer questions about images. This checkpoint is a soup of three training runs (seeds 0, 1, 2) of the same recipe.

-   **Base model:** Qwen/Qwen3.5-2B-Base
-   **Parameters:** 2B
-   **Image support:** yes (load with `--vision`; no image training, uses the base’s vision tower)
-   **Training:** LoRA adapter + pointer head; soup of three seeds (LoRA rank 16 in each run, stored as one rank-48 adapter); `google/gemma-4-31B-it` teacher; answers kept close to those of `strands-decider-2B-hobson-v19`, an earlier research model; then calibrated
-   **License:** Apache-2.0
-   **Hugging Face:** [StrandsAgents/strands-decider-2B-qwen3.5-v1-2610](https://huggingface.co/StrandsAgents/strands-decider-2B-qwen3.5-v1-2610)
-   **Mirror:** [amazon/strands-decider-2B-qwen3.5-v1-2610](https://huggingface.co/amazon/strands-decider-2B-qwen3.5-v1-2610)

## Benchmarks

| Metric | Value |
| --- | --- |
| JevBench public (window 4096) | 180/231 tasks |
| JevBench Brier | 0.280 |
| JevBench ECE | 0.072 |
| Decision Index (balanced skill) | 30.82 |
| HotpotQA (never trained on) | 0.832 |
| Held-out short tasks (n=6,000) | 0.653 |
| GPU memory (bf16) | ~4.5 GB |

Vision (NaturalBench first 300 groups, POPE-adv first 600): 0.776 / 0.872 accuracy, matching hobson-v21 within paired bootstrap 95% CIs.

Full numbers in [evaluation/results.md](https://github.com/strands-labs/strands-decider/blob/6d85079caf1f1906ebb0f1370b56ef28ba7aa93e/evaluation/results.md#v1-the-released-model).

## Run it

```bash
pip install strands-decider
strands-decider serve StrandsAgents/strands-decider-2B-qwen3.5-v1-2610 --port 8000
```

With images (needs `transformers >= 5.18`):

```bash
strands-decider serve StrandsAgents/strands-decider-2B-qwen3.5-v1-2610 --vision --port 8000
```

See [Inference server](/docs/labs/strands-decider/inference/index.md) for the request shape and [designs/images](https://github.com/strands-labs/strands-decider/blob/6d85079caf1f1906ebb0f1370b56ef28ba7aa93e/designs/images.md) for the vision request format and benchmark results.

## When to pick it

-   You need image input.
-   You want the smallest possible checkpoint.
-   You are running on a laptop or on a small CPU/MPS host.

## Limitations

-   Questions are read less than documents: with the state and options fixed, a changed question often gets the same answer.
-   Long, multi-step documents are the weak spot (JevBench hard tier lags its easy tier).
-   `score` and `noul` transfer poorly to rubrics and yes/no tasks unlike the training mix.
-   Calibration is one temperature per question type, fitted on held-out short classification; measure on your own traffic before trusting a threshold.