The smallest Gemma 4 v1 checkpoint: a LoRA adapter on `google/gemma-4-E2B-it` plus a small pointer head, as a soup of three seeds. Text only — the base’s vision and audio encoders are dropped at load.

-   **Base model:** `google/gemma-4-E2B-it` (text decoder only)
-   **Parameters:** 2B effective
-   **Image support:** no
-   **Training:** LoRA adapter + pointer head; soup of three seeds (LoRA rank 16 in each run, stored as one rank-48 adapter); Qwen/Qwen3.5-4B teacher; answers kept close to those of `strands-decider-2B-hobson-v19`, an earlier research model; then calibrated
-   **License:** Apache-2.0
-   **Hugging Face:** [StrandsAgents/strands-decider-E2B-gemma4-v1-2610](https://huggingface.co/StrandsAgents/strands-decider-E2B-gemma4-v1-2610)
-   **Mirror:** [amazon/strands-decider-E2B-gemma4-v1-2610](https://huggingface.co/amazon/strands-decider-E2B-gemma4-v1-2610)

## Benchmarks

| Metric | Value |
| --- | --- |
| JevBench public, window 4096 | 180 / 231 |
| JevBench Brier | 0.313 |
| JevBench ECE | 0.053 |
| Decision Index 0.2.1 (window 32,768) | 29.78 |
| Held-out short tasks (n=6,000) | 0.652 |
| Held-out code tasks (n=1,996) | 0.773 |
| GPU memory (bf16) | ~9 GB |

Decision Index was measured before the E2B attention fix; multi-question yes/no answers went through a faulty GPU kernel, so that figure may be off. Single-question numbers (JevBench, internal sets) are unaffected. Full per-skill results: [evaluation/results.md](https://github.com/strands-labs/strands-decider/blob/6d85079caf1f1906ebb0f1370b56ef28ba7aa93e/evaluation/results.md).

## Run it

```bash
pip install strands-decider
strands-decider serve StrandsAgents/strands-decider-E2B-gemma4-v1-2610 --port 8000
```

E2B uses eager attention on CUDA; the server picks the right kernel automatically. See [Inference server](/docs/labs/strands-decider/inference/index.md).

## When to pick it

-   You want the smallest Gemma 4 checkpoint and do not need images.
-   You can accept the lowest JevBench score in the Gemma family in exchange for the lowest per-token cost.

## Limitations

-   Questions are read less than documents: with the state and options fixed, a changed question often gets the same answer.
-   Long, multi-step documents are the weak spot (JevBench hard tier lags its easy tier).
-   `score` and `noul` transfer poorly to rubrics and yes/no tasks unlike the training mix.
-   Calibration is one temperature per question type, fitted on held-out short classification; measure on your own traffic before trusting a threshold.
-   Decision Index was measured before the E2B attention fix; multi-question yes/no answers went through a faulty GPU kernel, so that figure may be off (single-question numbers are unaffected).