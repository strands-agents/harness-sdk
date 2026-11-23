The v2 recipes are the current way to train a Decider model. A v2 recipe fine-tunes a Gemma 4 base model with a LoRA adapter and a token readout, in three steps: convert your rows, train one config, and export the result.

The v2 models on the [Models](/docs/labs/strands-decider/models/index.md) page come from these recipes, and the v1 models come from the earlier recipes at the [end of this page](#earlier-recipes). New to the architecture? Start with [Understanding Strands Decider](/docs/labs/strands-decider/understanding/index.md).

## Which path to take

**You have a decision in your application and some labelled examples.** Start with the [`customize-decider` skill](https://github.com/strands-labs/strands-decider/tree/ecdb331493761f889351d3ca4936a9ef4e758b33/skills/customize-decider). It is a guide that an AI coding agent, or a person, follows step by step: build an evaluation set from your data, measure the released models on it, recalibrate the best one, and fine-tune it only if the measurement shows a gap that training can close. Recalibration needs no training run. This is the path for the rows of one application, whether you have hundreds of rows or hundreds of thousands. The skill works with the released models, and its result serves the same way as they do. For a v2 model it fine-tunes with `init_from`: a new LoRA adapter trains on the released weights, and the readout trains on from the released one.

**You want to train a general model from the base model, on a broad data mix of millions of rows.** Use a v2 recipe. The rest of this page gives the steps.

## What a v2 recipe trains

`configs/v2/` holds one training config for each Gemma 4 size:

| Size | Config | Base model |
| --- | --- | --- |
| E2B | `configs/v2/strands-decider-E2B-gemma4-v2-2611.yaml` | `google/gemma-4-E2B-it` |
| E4B | `configs/v2/strands-decider-E4B-gemma4-v2-2611.yaml` | `google/gemma-4-E4B-it` |
| 12B | `configs/v2/strands-decider-12B-gemma4-v2-2611.yaml` | `google/gemma-4-12B-it` |
| 26B-A4B | `configs/v2/strands-decider-26B-A4B-gemma4-v2-2611.yaml` | `google/gemma-4-26B-A4B-it` |
| 31B | `configs/v2/strands-decider-31B-gemma4-v2-2611.yaml` | `google/gemma-4-31B-it` |

Every config trains the same things:

-   **A LoRA adapter** of rank 64 on the base model. The base model’s own weights stay as they are. The 26B-A4B is a mixture-of-experts model, and its config also puts a small adapter on each expert.
-   **A token readout** in place of the v1 pointer head: one score for each of 255 option codes, read at the last token of the prompt.
-   **Attention over the whole state.** A state token sees all of the state, in both directions. A question token sees the state and its own question.

A recipe makes one pass over the rows, with rows of up to 16,384 tokens. It uses no teacher model: the target of each row is all that a run trains toward.

The configs are sized for the v2 data mix of 17.48 million rows, which the [data card](/docs/labs/strands-decider/data-card/index.md) describes. One optimizer step takes about 2,700 rows whatever the number of GPUs, and a run evaluates and saves every 100 steps. For a smaller data mix, lower `grad_accum` (the number of micro-batches that one step adds up), so that the run has enough steps.

## Prerequisites

-   One Linux host with NVIDIA GPUs. The example below uses 8. The configs read long rows in large micro-batches, so each GPU needs a large memory. `slice_char_budget` caps the size of one forward pass: lower it if a run stops with an out-of-memory error. The rows of a step do not change.
    
-   The repository with its training dependencies:
    
    ```bash
    git clone https://github.com/strands-labs/strands-decider && cd strands-decider
    python3 -m venv .venv && . .venv/bin/activate
    pip install -e ".[train,dev]"
    ```
    
    [Setup](https://github.com/strands-labs/strands-decider/blob/ecdb331493761f889351d3ca4936a9ef4e758b33/training/README.md#setup) in the training guide has the notes on PyTorch versions.
    
-   Network access to Hugging Face for the Gemma 4 base model. Each config pins the revision of its base model.
    
-   Your training rows and a held-out set of rows, as JSON Lines files.
    

## 1\. Convert the rows

A v2 row is one decision: a state, one question and its answer. There are three question types:

-   A `choice` question lists its options as `criteria`, and the answer is one of them.
-   A `noul` question is a yes/no question, and its `target` is the probability of yes.
-   A `score` question lists its levels, lowest first, and the answer is the number of a level. Levels count from 0.

```json
{"id": "ticket-1", "state": "Help! My payouts have been failing for 3 days.", "question": {"type": "choice", "instructions": "Which team should take this ticket?", "criteria": {"billing": "Invoices, payouts and refunds", "technical": "Errors and outages", "sales": "Plans and pricing"}}, "target": "billing", "label": "billing"}
{"id": "ticket-2", "state": "Help! My payouts have been failing for 3 days.", "question": {"type": "noul", "instructions": "Is the customer asking for a refund?"}, "target": 0.0, "label": false}
{"id": "ticket-3", "state": "Help! My payouts have been failing for 3 days.", "question": {"type": "score", "instructions": "How urgent is this ticket?", "criteria": ["Can wait", "Answer today", "Answer now"]}, "target": 2, "label": 2}
```

`target` is what training aims at. For a `choice` it is one option, or a list with a probability for each option. `label` is the correct answer, which the trainer uses to report accuracy.

The converter turns these rows into the rows that the trainer reads:

```bash
python -m training.data.strands_v2 train.jsonl data/train_examples.jsonl --workers 16
python -m training.data.strands_v2 dev.jsonl data/dev_examples.jsonl
```

It drops the rows that training cannot use and prints the count of each group: a row without instructions, a row with an image (the v2 recipes train on text), and a row that the request format refuses, for example a `choice` with one option.

## 2\. Train one config

```bash
torchrun --standalone --nproc_per_node=8 -m training.train \
  --config configs/v2/strands-decider-E4B-gemma4-v2-2611.yaml
```

Without `torchrun`, the same config trains the same steps on one GPU. The config reads `data/train_examples.jsonl` and `data/dev_examples.jsonl`, and it writes the checkpoint to `checkpoints/strands-decider-E4B-gemma4-v2-2611`.

At the start, the trainer drops the rows whose prompt is longer than 16,384 tokens and prints how many. Every 100 steps it prints the loss and the accuracy on the held-out rows, and it saves its state. To continue a stopped run, set `resume_from` in the config to the last `resume-<step>.pt` file, and start it again with the same config and the same number of GPUs.

## 3\. Export the model

```bash
python -m training.export_v2 checkpoints/strands-decider-E4B-gemma4-v2-2611 exports/E4B
```

The export writes one directory: the base model’s files with the adapter merged in, the readout (`readout.safetensors`) and `decision_config.json`.

One run is enough to start. To average several runs into one model, train the config again with another `seed`, and name every checkpoint before the output directory. The export merges each run and averages all of them with equal weights:

```bash
python -m training.export_v2 checkpoints/run-a checkpoints/run-b checkpoints/run-c exports/E4B
```

The exported model carries one temperature for all question types: the checkpoint’s own for one run, 1 for an average of several runs, or the value of `--temperature`.

The exported directory has the format of a released v2 model, so you run it the same way:

```bash
strands-decider serve exports/E4B --port 8000
```

See [The token readout](https://github.com/strands-labs/strands-decider/blob/ecdb331493761f889351d3ca4936a9ef4e758b33/designs/architecture.md#training-a-token-readout) for what the export checks.

## 4\. Evaluate and calibrate the export

```bash
python -m training.evaluate eval exports/E4B --data data/dev_examples.jsonl
python -m training.evaluate calibrate exports/E4B --data data/dev_examples.jsonl
```

`eval` scores the exported model on held-out rows. `calibrate` fits one temperature on them and writes it into the `decision_config.json` of the export. To train the exported model, or a released v2 model, on more rows, set `init_from` in a training config to its directory or its Hub id.

## Earlier recipes

The version names: v19 is a research version from before the first release, and its models have `hobson` in their names. v1 and v2 are the first and the second release.

**The v19 reference recipe.** `training/recipe.sh all` builds the data, trains one seed of the v19 reference model (Qwen3.5-2B-Base with a pointer head), calibrates and evaluates. It takes about 11 hours on one RTX 3090. [Usage](https://github.com/strands-labs/strands-decider/blob/ecdb331493761f889351d3ca4936a9ef4e758b33/training/README.md#usage) in the training guide has the stages and what each one writes.

**The released v1 models.** `configs/v1/` holds the training config of each released v1 model. Each release is an average of three runs of its config (a soup), calibrated after the average. Part of the v1 training data is built outside the repository, so `recipe.sh all` does not rebuild a v1 model. [The v1 release recipes](https://github.com/strands-labs/strands-decider/blob/ecdb331493761f889351d3ca4936a9ef4e758b33/training/README.md#the-v1-release-recipes) says what each config reads.

**Fine-tuning a released v1 model.** A training config can start from a released model with `init_from` and train it on your rows. [Fine-tuning a released model](https://github.com/strands-labs/strands-decider/blob/ecdb331493761f889351d3ca4936a9ef4e758b33/training/README.md#fine-tuning-a-released-model-with-init_from) has an example config, and the `customize-decider` skill covers the whole path.

## Where to go next

-   [The `customize-decider` skill](https://github.com/strands-labs/strands-decider/tree/ecdb331493761f889351d3ca4936a9ef4e758b33/skills/customize-decider) — measure a released model on your data, and train only if the measurement says so.
-   [The v2 recipes](https://github.com/strands-labs/strands-decider/blob/ecdb331493761f889351d3ca4936a9ef4e758b33/training/README.md#the-v2-recipes) — the three steps in the training guide.
-   [The token readout](https://github.com/strands-labs/strands-decider/blob/ecdb331493761f889351d3ca4936a9ef4e758b33/designs/architecture.md#training-a-token-readout) — the design of the readout, the attention and the export.
-   [`training/hardware.md`](https://github.com/strands-labs/strands-decider/blob/ecdb331493761f889351d3ca4936a9ef4e758b33/training/hardware.md) — memory, throughput, and length-grouped batching.