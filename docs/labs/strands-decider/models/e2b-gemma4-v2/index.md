The smallest v2 checkpoint, the next version of [E2B-gemma4-v1-2610](/docs/labs/strands-decider/models/e2b-gemma4/index.md). It is one full model: a LoRA adapter merged into `google/gemma-4-E2B-it`, with a token readout in place of the v1 pointer head. The probability of each option is read from its answer code (`A`, `B`, `C`, and so on) at the last token of the prompt. The state is encoded once, in both directions, and every question reads it. The release is the average of three runs of the same recipe, then calibrated.

-   **Base model:** google/gemma-4-E2B-it
-   **Parameters:** 2.3B effective (5.1B with embeddings)
-   **Image support:** yes (no image training; uses the base’s image input)
-   **Decision types:** `choice` (2 to 255 options), `noul` (yes/no), `score` (2 to 10 levels)
-   **Prompt length:** 32,768 tokens by default, up to 131,072 with `--max-length`; trained on prompts of up to 16,384 tokens
-   **Size:** 10.3 GB in bf16; one GPU with 24 GB of memory
-   **Training:** LoRA adapter (rank 64) + token readout; one pass over the v2 data mix; average of three runs; then calibrated with one temperature, fitted on held-out questions
-   **License:** Apache-2.0
-   **Hugging Face:** [StrandsAgents/strands-decider-E2B-gemma4-v2-2611](https://huggingface.co/StrandsAgents/strands-decider-E2B-gemma4-v2-2611)

## Benchmarks

| Model | Decision Index 0.3, public | JevBench | OpenDecisions | DecisionPivot | BEV |
| --- | --- | --- | --- | --- | --- |
| **E2B-gemma4-v2-2611 (this model)** | 57.1 | 87.4 | 77.7 | 23.3 | 74.0 |
| [E2B-gemma4-v1-2610](/docs/labs/strands-decider/models/e2b-gemma4/index.md) | 29.3 | 77.5 | 56.8 | 7.3 | 63.9 |

Scores are 0 to 100. Decision Index 0.3, public: 41 tasks in five areas. JevBench: the share of the 231 public items answered correctly. OpenDecisions: everyday decisions, scored on answer quality and calibration. DecisionPivot: pair accuracy on items that differ in one decisive detail. BEV: choice, yes/no and ordered-score decisions across 18 domains. The v2 row uses the calibration temperature that the model ships with, and the v1 row uses a temperature of 1. Only OpenDecisions depends on the temperature: at a temperature of 1, this model scores 76.2 there. The numbers are those of the HF card.

On one H100 in bf16, the median request over the 231 JevBench items takes 62 ms with one question and 92 ms with 30 questions about the same state.

Calibration: the average gap between confidence and accuracy is 3.2 points (HF card).

## Run it

```bash
pip install strands-decider
strands-decider ask StrandsAgents/strands-decider-E2B-gemma4-v2-2611 \
  --state "Help! My payouts have been failing for 3 days!" \
  --choice "Which team should handle this?=billing,sales,retail" \
  --noul "Does this convey urgency?"
```

A v2 model needs `strands-decider` 0.4.0 or later.

Add `--image photo.jpg`, once for each image, to send images with the state. To serve the model over HTTP:

```bash
strands-decider serve StrandsAgents/strands-decider-E2B-gemma4-v2-2611 --port 8000
```

In Python:

```python
from strands_decider.core import Request
from strands_decider.decision import load_decision_engine

engine = load_decision_engine("StrandsAgents/strands-decider-E2B-gemma4-v2-2611", device="cuda")
request = Request.model_validate(
    {
        "state": "My integration keeps failing with a 401 since we rotated our API key. Please help.",
        "questions": {
            "team": {
                "type": "choice",
                "instructions": "Which team should handle this request?",
                "criteria": {
                    "billing": "Charges and refunds",
                    "support": "Technical integration errors",
                    "sales": "Questions about buying a product",
                },
            },
            "urgent": {"type": "noul", "instructions": "Is the customer blocked right now?"},
        },
    }
)
response = engine.evaluate(request)
answers = response.model_dump(exclude_none=True)["answers"]
print(answers["team"]["choice"], answers["urgent"]["noul"])
```

See [Inference server](/docs/labs/strands-decider/inference/index.md) for the request shape.

## When to pick it

-   You want the smallest v2 model: it fits on one 24 GB GPU and also runs without a GPU.
-   You want the lowest latency: 62 ms for one question on one H100.

## Limitations

-   On a GPU, the model needs 24 GB of memory and cannot be split over GPUs. Long prompts with many questions need more memory: send a shorter text or fewer questions in one request.
-   v2 is trained on text only. Images go through the base model’s own image input, unchanged.
-   The temperature is fitted on held-out data and does not change the chosen answer. If your application relies on the probability values, check them on a sample of your own traffic.