Run Strands Decider on your own machine or an on-prem box. Good for development, batch classification jobs, air-gapped environments, and anything where you don’t want traffic leaving the host.

-   **When to pick it:** development, batch classification, air-gapped or on-prem workloads, and anything where you don’t want traffic leaving the host.

## Serve it

```bash
pip install strands-decider
strands-decider serve StrandsAgents/strands-decider-E2B-gemma4-v1-2610 --port 8000
```

That’s it — `POST /v1/systemone` is up on `http://localhost:8000`. See [Inference server](/docs/labs/strands-decider/inference/index.md) for the request shape, endpoints, and flags. Point a Strands agent at it the same way you would any other Decider deployment; see [Decision models in the Strands SDK](https://strandsagents.com/docs/user-guide/sdk/decision-models/) for the client wiring.

## Picking a device

`strands-decider serve` auto-detects the best device (`cuda > mps > cpu`), or pass `--device` explicitly:

-   **`--device cuda`** — NVIDIA GPU; fastest for the Gemma 4 models.
-   **`--device mps`** — Apple Silicon GPU through PyTorch.
-   **`--device mlx`** — Apple Silicon through MLX, 1.4–1.6x faster than MPS on the Qwen3.5 model. Needs the `mlx` extra.
-   **`--device cpu`** — portable fallback; works everywhere, slower on the larger models.

See [designs/inference](https://github.com/strands-labs/strands-decider/blob/ecdb331493761f889351d3ca4936a9ef4e758b33/designs/inference.md#environments-for-serving) for the full matrix of device × model combinations.

## See also

-   Source: [`deploy/README.md`](https://github.com/strands-labs/strands-decider/blob/ecdb331493761f889351d3ca4936a9ef4e758b33/deploy/README.md) — the top-level deploy guide in the SDK repo, covering local plus every other target.