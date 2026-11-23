Strands Decider ships with a small HTTP server so your applications can keep one model loaded and ask it many questions over the network. The server runs the same engine as the CLI, so the answers match `strands-decider ask`.

## Install and serve

```bash
pip install strands-decider
strands-decider serve StrandsAgents/strands-decider-E2B-gemma4-v1-2610 --port 8000
```

On first start the engine downloads the checkpoint and warms every request shape so later requests do not pay a one-time compile cost.

## HTTP API

The server exposes three endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/systemone` | Ask one or more questions about a shared state. |
| `GET` | `/health` | Liveness, plus device and vision flags. |
| `GET` | `/ping` | Readiness without touching the engine. |

A request picks a question type for each question. The server encodes the shared state once and evaluates every question against that encoding:

```bash
curl -s localhost:8000/v1/systemone -H 'content-type: application/json' -d '{
  "state": "Refund request from customer in EU for a damaged item.",
  "questions": {
    "queue":  {"type": "choice", "instructions": "Which queue handles this?",
               "criteria": {"refunds": "refund request", "returns": "return request",
                            "complaints": "complaint", "general": "other"}},
    "urgent": {"type": "noul",   "instructions": "Is this time-sensitive?"},
    "sev":    {"type": "score",  "instructions": "How severe is the complaint?",
               "criteria": ["minor", "moderate", "major"]}
  }
}'
```

The response names the selected option for each `choice`, the probability for each `noul`, and the expected level with its distribution for each `score`. Every answer includes a calibrated confidence.

## Devices

The server picks a device automatically — `cuda`, then `mps`, then `cpu`. Pass `--device` to override. On Apple silicon, `--device mlx` runs the torso on Metal through mlx-lm.

| Flag | Install | Target |
| --- | --- | --- |
| `--device cuda` | `pip install "strands-decider[cuda]"` | NVIDIA GPU on Linux or WSL2. |
| `--device mps` | `pip install strands-decider` | Apple silicon GPU. |
| `--device mlx` | `pip install "strands-decider[mlx]"` | Apple silicon GPU through mlx-lm. |
| `--device cpu` | `pip install strands-decider` | CPU-only hosts. |

## Flags worth knowing

-   `--vision` loads the vision tower on the v1 Qwen3.5 checkpoint so requests may carry base64 `images`. v2 Gemma 4 models accept images without this flag. See [designs/images](https://github.com/strands-labs/strands-decider/blob/ecdb331493761f889351d3ca4936a9ef4e758b33/designs/images.md).
-   `--max-concurrency N` caps in-flight requests. Each request runs to completion before another picks it up on the engine.
-   `--max-batch N` sets the per-request question budget.
-   `--device-map auto` splits a model across multiple GPUs when one is not enough.

## Shared-prefix cache

Asking several questions about the same state is nearly free because the server encodes the state once and reuses the hidden representation for every question in the request. For low-latency decisions, pack related questions into a single POST rather than opening several.

## Deeper reading

-   [designs/inference](https://github.com/strands-labs/strands-decider/blob/ecdb331493761f889351d3ca4936a9ef4e758b33/designs/inference.md) — full operator reference, calibration notes, and Mac/MLX kernel details.
-   [Deployment](/docs/labs/strands-decider/deployment/local/index.md) — local, SageMaker, Lambda, and other hosting targets.