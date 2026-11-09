Released models are named

```plaintext
strands-decider-{size}-{base}-v{N}-{YYMM}
```

for example `StrandsAgents/strands-decider-2B-qwen3.5-v1-2610`. Released so far: `strands-decider-2B-qwen3.5-v1-2610` and `strands-decider-{E2B,E4B,12B,26B-A4B}-gemma4-v1-2610`.

| part | meaning | values so far |
| --- | --- | --- |
| `size` | the base model’s own size token, as its Hub id writes it | `2B` (Qwen/Qwen3.5-2B-Base); `E2B`, `E4B`, `12B`, `26B-A4B` (google/gemma-4-\*) |
| `base` | the base model family, one token | `qwen3.5`, `gemma4` |
| `v{N}` | the release on this base family, from `v1` | `v1` |
| `YYMM` | the release month, as on the Hub (Qwen’s `-2507`) | `2610` |

-   **`v{N}`** counts the releases on one base family: `v1` is the first release on each base. Releases with the same N on different bases can use different recipes, and each model card says what its model trained on. For example, `strands-decider-E4B-gemma4-v1-2610` and `strands-decider-2B-qwen3.5-v1-2610` are both v1: the Gemma 4 models train on hobson-v21’s data with code tasks added, and the Qwen3.5 model on a new data mix with another teacher ([evaluation/results.md](https://github.com/strands-labs/strands-decider/blob/846b69ebe7603038caa3bfe250e50f1137b141d7/evaluation/results.md#gemma-4-v1)).
-   **A second release in the same month** goes to the same repository. Every upload is tagged on the Hub with its date, `YYMMDD`, and the card gets a changelog line. To pin a version, download it by its tag ([inference.md](../inference/index.md#model-artifact)).
-   **Internal round numbers** stay in the research notes. They are not part of the public name.
-   **Earlier releases keep their names:** `strands-decider-2B-hobson-v19` and `strands-decider-2B-hobson-v21`. hobson-v21 and v1 are different recipes; v1 is not a rename of v21.

`training.naming.release_name(base_model, N, yymm)` builds a name from the base model’s Hub id, and `training.naming.parse(name)` checks one:

```bash
python -m training.naming Qwen/Qwen3.5-2B-Base 1 2610   # strands-decider-2B-qwen3.5-v1-2610
```

Git tags for model releases are `model/<name>`, for example `model/strands-decider-2B-qwen3.5-v1-2610`. Package versions use `v<number>` tags only, so a model tag never sets the package version.