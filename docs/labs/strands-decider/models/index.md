Strands Decider v2 has five models on Gemma 4, from E2B to 31B. They are the current models: more accurate than v1 at every size, with a token readout, a 32,768-token context and image input. The five v1 models stay available, and their matrix is below.

## v2 model matrix

| Model | Base | Decision Index 0.3 | JevBench | OpenDecisions | DecisionPivot | BEV | GPU to use | Latency (H100, median) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [E2B-gemma4-v2-2611](/docs/labs/strands-decider/models/e2b-gemma4-v2/index.md) | gemma-4-E2B-it | 57.1 | 87.4 | 77.7 | 23.3 | 74.0 | 24 GB | 62 ms |
| [E4B-gemma4-v2-2611](/docs/labs/strands-decider/models/e4b-gemma4-v2/index.md) | gemma-4-E4B-it | 63.2 | 88.3 | 83.9 | 45.2 | 78.9 | 40 GB | 78 ms |
| [12B-gemma4-v2-2611](/docs/labs/strands-decider/models/12b-gemma4-v2/index.md) | gemma-4-12B-it | 64.1 | 92.2 | 85.7 | 58.9 | 79.0 | 48 GB | 80 ms |
| [26B-A4B-gemma4-v2-2611](/docs/labs/strands-decider/models/26b-a4b-gemma4-v2/index.md) | gemma-4-26B-A4B-it | 69.0 | 92.6 | 88.6 | 69.2 | 81.4 | 80 GB | 86 ms |
| [31B-gemma4-v2-2611](/docs/labs/strands-decider/models/31b-gemma4-v2/index.md) | gemma-4-31B-it | 71.5 | 93.1 | 92.2 | 84.3 | 84.5 | 80 GB | 99 ms |

Scores are 0 to 100. Decision Index 0.3, public: 41 tasks in five areas. JevBench: the share of the 231 public items answered correctly. OpenDecisions: everyday decisions, scored on answer quality and calibration. DecisionPivot: pair accuracy on items that differ in one decisive detail. BEV: choice, yes/no and ordered-score decisions across 18 domains. The latency is for one question, over the 231 JevBench items. Each model page has the v1 scores next to these and the latency for 30 questions.

## Which v2 model should I pick?

-   **Smallest, one 24 GB GPU or no GPU:** E2B-gemma4-v2.
-   **One 40 GB GPU:** E4B-gemma4-v2.
-   **One 48 GB GPU:** 12B-gemma4-v2.
-   **One 80 GB GPU, many questions about one state:** 26B-A4B-gemma4-v2.
-   **Most accurate:** 31B-gemma4-v2.

Every v2 model takes the same request and gives the same kind of answer, so a change of model is a change of one name in `strands-decider ask` or [`strands-decider serve`](/docs/labs/strands-decider/inference/index.md).

## v1 model matrix

Strands Decider v1 publishes five checkpoints: one Qwen3.5 base (with a vision tower) and four Gemma 4 bases spanning 2B – 26B parameters. All five share the pointer head and the public API. The Qwen3.5 model and the Gemma 4 models train on different data mixes with different teachers. The models also differ in base model, size, and image support.

| Model | Base | Params | JevBench (231) | Brier | GPU memory (bf16) | Latency (H100, median) | Images |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [2B-qwen3.5-v1-2610](/docs/labs/strands-decider/models/2b-qwen3-5/index.md) | Qwen3.5-2B-Base | 2B | 180 | 0.280 | ~4.5 GB | — | ✓ |
| [E2B-gemma4-v1-2610](/docs/labs/strands-decider/models/e2b-gemma4/index.md) | gemma-4-E2B-it | 2B eff. | 180 | 0.313 | ~9 GB | 102 ms | — |
| [E4B-gemma4-v1-2610](/docs/labs/strands-decider/models/e4b-gemma4/index.md) | gemma-4-E4B-it | 4B eff. | 187 | 0.243 | ~15 GB | 139 ms | — |
| [12B-gemma4-v1-2610](/docs/labs/strands-decider/models/12b-gemma4/index.md) | gemma-4-12B-it | 12B | 200 | 0.173 | ~23 GB | 136 ms | — |
| [26B-A4B-gemma4-v1-2610](/docs/labs/strands-decider/models/26b-a4b-gemma4/index.md) | gemma-4-26B-A4B-it | 26B MoE (4B active) | 207 | 0.162 | ~51 GB | 245 ms | — |

JevBench scores come from [evaluation/results.md](https://github.com/strands-labs/strands-decider/blob/d427f3cfb43e22afbbfc2675c9df8dfdca739197/evaluation/results.md). GPU memory is for the weights only, and it and the latency come from [designs/inference.md](https://github.com/strands-labs/strands-decider/blob/d427f3cfb43e22afbbfc2675c9df8dfdca739197/designs/inference.md#gemma-4-models). Activations come on top, and each model page names a GPU that fits. Lower Brier is better; higher JevBench is better.

## Which v1 model should I pick?

-   **Fit on a laptop or small instance, or need image input:** 2B-qwen3.5.
-   **One GPU that the model shares with other work:** E4B-gemma4.
-   **Best accuracy of the dense models, on one 48 GB GPU:** 12B-gemma4.
-   **Best accuracy, mixture-of-experts serving:** 26B-A4B-gemma4.
-   **Smallest Gemma option:** E2B-gemma4.

Every v1 checkpoint speaks the same `--state` / `--choice` / `--noul` / `--score` interface and the same HTTP contract, so switching models is a one-line change in [`strands-decider serve`](/docs/labs/strands-decider/inference/index.md).

## Naming

Model IDs follow `strands-decider-{size}-{base}-v{N}-{YYMM}`. See [designs/naming](https://github.com/strands-labs/strands-decider/blob/d427f3cfb43e22afbbfc2675c9df8dfdca739197/designs/naming.md) for the full rule, including what changes when `N` increments.