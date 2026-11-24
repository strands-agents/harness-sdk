Strands Decider is a decision model built on a pretrained language model. Training does not change the base model’s own weights. It adds two small parts: a LoRA adapter (a small set of extra weights next to the base model’s) and a readout (the layer that turns the model’s output into one score for each option). This page explains the shape of the system — what it answers, how the readout works, how to read its confidence, and what the models train on — without going into the full operator reference. For that, see the design notes in [designs/](https://github.com/strands-labs/strands-decider/tree/6d85079caf1f1906ebb0f1370b56ef28ba7aa93e/designs) on GitHub.

There are two versions. The v2 models are the current models: five sizes on Gemma 4, with the token readout that this page describes first. The five v1 models stay available. [Models](/docs/labs/strands-decider/models/index.md) lists the two families, and [Training a Decider model](/docs/labs/strands-decider/training/index.md) has the v2 training steps.

## A decision, not a generation

A language model generates text token by token. Decider does not. It reads a **state** (the thing you want a decision about) and a **question** (the decision to make), then produces a single answer drawn from a space you defined on the request. The space is one of three types:

-   **noul** — our name for a yes/no question. The answer is the probability that the answer is yes.
-   **choice** — one of a labelled set of options, returned as the selected option, a probability for each option, and a confidence.
-   **score** — a level on an ordered scale, returned as an expected value on the scale, the distribution over levels, and a confidence.

Because the request fixes the output space, Decider generates no text. One forward pass gives one score for each option, and a softmax over those scores is the answer. There is no decoding loop, so one request is one model call.

## The v2 token readout

A v2 Decider model is a Gemma 4 base model (E2B, E4B, 12B, 26B-A4B or 31B) with a *token readout*. The prompt lists the options of a question under short codes (`A`, `B`, and so on). The readout gives one score for each of 255 codes, read at the last token of the prompt. Three things follow:

-   **The options belong to the request.** The readout has one row for each code, not for each option, so the same model answers a new set of options the day you write it — no retraining to add a category. A `choice` question takes 2 to 255 options, and a `score` question takes 2 to 10 levels. The v1 models have the same limits.
-   **The readout starts from the base model.** Each row starts as the base model’s own output row for that code, so training begins from what the base model already prefers.
-   **The state is read in both directions.** A state token sees all of the state and never the question. A question token sees the state and its own question.

All three question types come out of the same readout; `noul`, `choice`, and `score` differ in how the probabilities are read back, not in the forward pass. The export of a v2 model merges the adapter into the base model’s weights, so a v2 model is one directory of files.

A request can carry any number of questions about the same state. The state is encoded once and every question reads it, so an answer does not change when you add, remove or reorder the other questions, and each extra question costs only its own tokens. A v2 model keeps Gemma 4’s vision encoder, so a request can also carry images; v2 is trained on text only. The context is 32,768 tokens by default, and up to 131,072.

## The v1 pointer head

The released v1 models (Qwen3.5-2B-Base, and Gemma 4 in the sizes E2B, E4B, 12B and 26B-A4B) use a *pointer head* in place of the token readout. The head compares the hidden state at the answer position with the hidden state at the last token of each option, and gives one score for each option. It holds no per-option parameters, so a v1 model also takes its options from the request. One request can carry several questions about the same state: a v1 model encodes the state once and reuses it for every question. A v1 model keeps its adapter and its head as files next to the base model, which it loads from Hugging Face.

## Confidence and calibration

A `choice` and a `score` answer carry a confidence. For a `choice`, it is the highest probability on a scale where an even split between the options is 0 and a certain answer is 1. A `noul` answer is itself a probability: read it directly, because a value near 0 is a confident “no” and a value near 1 is a confident “yes”.

A model is calibrated when its probabilities follow its accuracy: of the answers that get a probability of 0.9, about 90% are right. A temperature inside the model scales the scores before the softmax to get there; you do not set it in a request. A v2 model carries one temperature for all question types, fitted on held-out questions and stored in its `decision_config.json`; the temperature does not change the chosen answer. A v1 model has one temperature for each question type, fitted on held-out short classification tasks.

In our measurements of the pointer-head models, on short classification tasks that a model had never seen, about a quarter of the answers had a confidence of 0.9 or more, and those answers were right about 95% of the time. A common starting point is: at 0.9 or above, act without a check; from 0.5 to 0.9, confirm first; below 0.5, send the answer to a person. These bands are measured on short classification, and long documents behave differently, so measure the thresholds on your own traffic before you rely on them.

## What the models train on

Every training row is one decision: a state, a question, its options and the answer. Each v2 size trains for one pass on 17.48 million rows, and each released v2 model is the average of three runs. The v2 recipes read rows of this kind from your files, and [Training a Decider model](/docs/labs/strands-decider/training/index.md) shows the format.

The released v1 models do not share one data mix. The Qwen3.5 model trains on a balanced mix of 246,678 rows, and the four Gemma 4 models train on a mix of 135,602 rows. The two mixes hold short classification tasks from public datasets — topic, intent, sentiment, entailment, ordinal ratings, yes/no, rule chaining — together with multi-step questions on documents, document questions that language models wrote and checked, answer-adequacy rows, and code tasks. The Qwen3.5 mix adds rows for decision types that the Gemma 4 mix has few rows for, such as tool choice, agent steps, preferences and legal text, and generated rule-application rows (apply a written policy to a case).

The rest of this section matters only if you train. The v1 models also learn from a teacher model: `gemma-4-31B-it` for the Qwen3.5 model and `Qwen/Qwen3.5-4B` for the Gemma 4 models, used where its answer agrees with the correct answer. Training also keeps the answers of a v1 model close to those of `strands-decider-2B-hobson-v19`, an earlier research model. Each released v1 model is an average of three training runs (a soup), calibrated after the average. The v2 recipes use no teacher.

If you want to train your own decider, see [Training a Decider model](/docs/labs/strands-decider/training/index.md). It starts with the choice between the customization of a released model and a v2 recipe.

## Further reading

The full design notes live in the GitHub repository. These are deeper than the site surface and change as the research moves:

-   [designs/architecture.md](https://github.com/strands-labs/strands-decider/blob/6d85079caf1f1906ebb0f1370b56ef28ba7aa93e/designs/architecture.md) — the pointer head, the token readout, question-type read-back, and confidence.
-   [designs/inference.md](https://github.com/strands-labs/strands-decider/blob/6d85079caf1f1906ebb0f1370b56ef28ba7aa93e/designs/inference.md) — the full operator reference, the shared-prefix cache, device kernels, and Hub artifact format.
-   [designs/naming.md](https://github.com/strands-labs/strands-decider/blob/6d85079caf1f1906ebb0f1370b56ef28ba7aa93e/designs/naming.md) — released model identifiers and version fields.