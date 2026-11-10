# Multimodal Image-to-Text Evaluation Support

**Status**: Accepted (merged 2026-04-30)  
**Last updated**: 2026-05-06  
**Issue**: https://github.com/strands-agents/evals/issues/128  
**PR**: https://github.com/strands-agents/evals/pull/187  

## Context

Strands-evals SDK evaluates text-based outputs using LLM-as-a-Judge, but cannot assess multimodal outputs. A developer building a vision agent hits this wall today:

```python
from strands_evals import Case, Experiment
from strands_evals.evaluators import OutputEvaluator

evaluator = OutputEvaluator(rubric="Is the caption accurate?")
case = Case(
    name="image-caption-001",
    input="Describe this image.",  # No way to carry image data
    expected_output="A dog playing fetch in a park.",
)
# The judge never sees the image — it cannot detect visual hallucinations
experiment = Experiment(cases=[case], evaluators=[evaluator])
```

There are three gaps: (1) no image-aware evaluation — judge prompts are text-only, (2) no multimodal prompt construction — no mechanism to combine image content blocks with text in a judge call, and (3) no dimension-specific rubrics for visual tasks (correctness, faithfulness, hallucination detection).

## Decision

New `MultimodalOutputEvaluator(OutputEvaluator[InputT, OutputT])` class for media-in, text-out evaluation using MLLM-as-a-Judge. Inputs are carried by a `MultimodalInput` Pydantic model with fields `media`, `instruction`, and optional `context`.
**Scope:** Image/document-to-text task output evaluation.
**Out of scope**: text-to-image, audio, video, trajectory evaluation.

### Evaluation dimensions

|Priority	|Metric	|Scale	|Core Question	|
|---	|---	|---	|---	|
|P0	|Overall Quality	|Likert-5	|How good is the response overall?	|
|P0	|Correctness	|Binary (Yes/No)	|Is the response factually accurate and complete?	|
|P1	|Faithfulness	|Binary (Yes/No)	|Is the response grounded in the image without hallucinations?	|
|P1	|Instruction Following	|Binary (Yes/No)	|Does the response address the query's requirements?	|

### Core API

The public API users import is `from strands_evals.evaluators import MultimodalOutputEvaluator` (see Developer Experience below). The imports in the snippet that follows are implementation-internal, shown for class context, not as paths end users should reach for.

```python
from strands.models.model import Model
from strands_evals.evaluators import OutputEvaluator
from strands_evals.evaluators.prompt_templates.multimodal_case_prompt_template import (
    compose_multimodal_test_prompt,
)
from strands_evals.evaluators.prompt_templates.multimodal_judge_system_prompt import (
    MLLM_JUDGE_SYSTEM_PROMPT,
)
from strands_evals.types.evaluation import InputT, OutputT


class MultimodalOutputEvaluator(OutputEvaluator[InputT, OutputT]):
    """MLLM-as-a-Judge evaluator for multimodal tasks."""

    DEFAULT_REFERENCE_SUFFIX = """

REFERENCE COMPARISON:
- Compare the response against the Oracle reference answer above.
- The reference is the gold standard. Use discrepancies as evidence for your judgment."""

    def __init__(self, rubric: str, model: Model | str | None = None,
                 include_inputs: bool = True, system_prompt: str | None = None,
                 reference_suffix: str | None = None,
                 uses_environment_state: bool = False):
        super().__init__(
            rubric=rubric, model=model,
            system_prompt=system_prompt if system_prompt is not None else MLLM_JUDGE_SYSTEM_PROMPT,
            include_inputs=include_inputs, uses_environment_state=uses_environment_state,
        )
        self.reference_suffix = reference_suffix if reference_suffix is not None else self.DEFAULT_REFERENCE_SUFFIX

    def _select_rubric(self, evaluation_case):
        """Append the reference comparison suffix when expected_output is present."""
        if evaluation_case.expected_output is not None:
            return self.rubric + self.reference_suffix
        return self.rubric

    def _build_prompt(self, evaluation_case):
        # Parent OutputEvaluator.evaluate() calls _build_prompt(); we only override this hook.
        return compose_multimodal_test_prompt(
            evaluation_case=evaluation_case,
            rubric=self._select_rubric(evaluation_case),
            include_inputs=self.include_inputs,
        )
```

`compose_multimodal_test_prompt` returns a `list[ContentBlock]` when the input is a `MultimodalInput` carrying media (e.g. `[{"image": {"format": "jpeg", "source": {"bytes": b"..."}}}, {"text": "<Input>...</Input><Output>...</Output><Rubric>...</Rubric>"}]`) and a plain `str` otherwise (text-only LLM mode).

The supporting `MultimodalInput` and `ImageData` Pydantic models are used directly in every developer example and have this shape:

```python
from __future__ import annotations

from typing import TYPE_CHECKING, Literal

from pydantic import BaseModel

if TYPE_CHECKING:
    from PIL.Image import Image as PILImage


class ImageData(BaseModel):
    """Normalizes image sources so the judge receives raw bytes."""
    source: str | bytes | PILImage  # file path, base64, data URL, HTTP(S) URL, bytes, or PIL Image
    format: Literal["jpeg", "png", "gif", "webp"] | None = None  # auto-detected from extension / data URL
    media_type: str | None = None  # auto-derived from format

    def to_bytes(self) -> bytes: ...
    def to_base64(self) -> str: ...
    def to_data_url(self) -> str: ...


AnyMediaData = ImageData  # currently aliases ImageData; future: ImageData | VideoData | AudioData | DocumentData


class MultimodalInput(BaseModel):
    """Input structure for multimodal evaluations."""
    media: AnyMediaData | list[AnyMediaData] | str
    instruction: str
    context: str | None = None
```

**Key design choices:**

* **Extends `OutputEvaluator`, overrides `_build_prompt()` only**: Parent `OutputEvaluator` was refactored to expose a `_build_prompt()` hook; subclasses inherit `evaluate()` and `evaluate_async()` unchanged. This avoids duplicating the judge-agent construction and async plumbing, and keeps text-only behavior intact for the parent.
* **Same Agent invocation pattern as parent**: `Agent.__call__(prompt, structured_output_model=...)` accepts both `str` and `list[ContentBlock]`, so the parent's evaluate loop handles both modes without branching.
* **Strands ContentBlock format:** Media blocks use `{"image": {"format": "jpeg", "source": {"bytes": b"..."}}}` — the native strands SDK format.
* **Data-driven mode dispatch (no `include_media` flag):** `compose_multimodal_test_prompt` inspects the input — if it is a `MultimodalInput` carrying media, returns content blocks; otherwise returns plain text. LLM-only comparison is achieved by passing a non-`MultimodalInput` input (e.g., a plain string).
* **Reference handling via suffix, not rubric swap:** When `expected_output` is present, `_select_rubric()` appends `reference_suffix` to the base rubric rather than swapping to a parallel reference-rubric. This keeps a single source of truth per dimension and eliminates `*_REF` rubric duplicates.
* **Built-in rubric templates:** Ships with `OVERALL_QUALITY_RUBRIC_V0`, `CORRECTNESS_RUBRIC_V0`, `FAITHFULNESS_RUBRIC_V0`, `INSTRUCTION_FOLLOWING_RUBRIC_V0`. `MultimodalOverallQualityEvaluator` overrides the default suffix with a dimension-specific one; the other three use the default suffix. Users can also provide custom rubrics and/or a custom `reference_suffix`.
* **Convenience subclasses:** `MultimodalOverallQualityEvaluator`, `MultimodalCorrectnessEvaluator`, `MultimodalFaithfulnessEvaluator`, `MultimodalInstructionFollowingEvaluator` — each pre-configures the appropriate rubric.
* **`MultimodalInput` is a Pydantic `BaseModel`:** fields are `media` (`AnyMediaData | list[AnyMediaData] | str`, where `AnyMediaData` is currently an alias for `ImageData`), `instruction` (`str`), and `context` (`str | None`). Lists of media are supported natively; a bare string source is coerced to `ImageData`. Modality-generic naming (`media`, `AnyMediaData`) leaves room for future document/video/audio types without API changes.
* **Save/load round-trip safety:** `compose_multimodal_test_prompt` coerces a raw `dict` input back to `MultimodalInput` at the prompt-composer boundary, so cases reloaded via `Experiment.from_dict` (which loses the generic parameterization) still dispatch correctly.

## Developer Experience

### Basic usage

```python
from strands_evals import Case, Experiment
from strands_evals.evaluators import MultimodalCorrectnessEvaluator
from strands_evals.types import ImageData, MultimodalInput

# Define cases with a MultimodalInput carrying the image and instruction
cases = [Case(
    input=MultimodalInput(
        media=ImageData(source="chart.png"),
        instruction="What is the revenue trend?",
    ),
)]

# Standard workflow
evaluator = MultimodalCorrectnessEvaluator()
experiment = Experiment(cases=cases, evaluators=[evaluator])
reports = experiment.run_evaluations(task=lambda case: my_model(case.input))
```

```python
# Reference-based evaluation: providing expected_output auto-appends the reference suffix
case = Case(
    input=MultimodalInput(
        media=ImageData(source="scene.jpg"),
        instruction="Describe this image.",
    ),
    expected_output="A sunny park with a dog playing fetch.",  # triggers reference suffix
)
```

```python
# Custom rubric and/or custom reference suffix
from strands_evals.evaluators import MultimodalOutputEvaluator

medical_rubric = """Rate diagnostic accuracy on a 3-point scale:
- Completely (1.0): All findings correctly identified with proper terminology.
- Partially (0.5): Key findings identified but with imprecise terminology.
- Not at all (0.0): Critical findings missed or misidentified."""

evaluator = MultimodalOutputEvaluator(
    rubric=medical_rubric,
    reference_suffix="\n\nCompare against the radiologist's ground-truth report above.",
)
```

```python
# Text-only (LLM-as-a-Judge) fallback: pass a plain string instead of a MultimodalInput
case = Case(input="Describe the chart.", actual_output="Revenue rose 15% YoY.")
# compose_multimodal_test_prompt returns a text-only prompt for this case.
```

```python
# Multiple images per case
case = Case(
    input=MultimodalInput(
        media=[ImageData(source="before.jpg"), ImageData(source="after.jpg")],
        instruction="Describe what changed between these two images.",
    ),
)
```

### Error handling

* Image not found: `ValueError` with supported sources listed
* Non-`MultimodalInput` input: dispatches to text-only mode automatically (no warning needed)
* Empty `media` on a `MultimodalInput`: falls back to text-only with `UserWarning`
* Missing `actual_output` on the case: `ValueError` (task function must return a value or `{"output": ...}`)
* Remote sources: HTTP/HTTPS URLs auto-fetched via `urllib.request` (stdlib, no extra deps)
* Supported image formats: JPEG, PNG, GIF, WebP
* Supported local sources: file paths, base64 strings, data URLs, raw bytes, PIL Images

## Alternatives Considered

1. **Modify `OutputEvaluator` directly** — Rejected: adding media handling into the text-focused class overloads its API. Instead, `OutputEvaluator` was given a `_build_prompt()` extension hook (text path unchanged), and `MultimodalOutputEvaluator` overrides only that hook.
2. **Extend `Evaluator` directly** (not `OutputEvaluator`) — Rejected: would require duplicating rubric, model, system_prompt, and the judge-agent `evaluate()`/`evaluate_async()` plumbing that `OutputEvaluator` already provides.
3. **Media data in `Case.metadata`** — Rejected: `metadata` is for auxiliary info (human scores, labels), not primary inputs. Non-obvious pattern, impossible to type-check.
4. **Separate class per dimension** (e.g., `CorrectnessEvaluator`) — Adopted as convenience subclasses: `MultimodalCorrectnessEvaluator`, `MultimodalFaithfulnessEvaluator`, etc. Core logic lives in `MultimodalOutputEvaluator`; each subclass only pre-configures its rubric (and its reference suffix, for `OverallQuality`).
5. **Using `Agent.structured_output()` instead of `Agent.__call__()`** — Rejected: `Agent.__call__` accepts both `str` and `list[ContentBlock]` inputs, so the inherited parent `evaluate()` handles both modes with a single code path.
6. **Using `"image"` as the input field name** — Rejected in favor of `"media"`: modality-generic, extends cleanly to documents/audio/video via `AnyMediaData`.
7. **`include_media` flag** — Rejected in favor of data-driven dispatch: the input's own type (`MultimodalInput` with media vs. anything else) determines the mode, eliminating a redundant knob that could conflict with the payload.
8. **Parallel `*_RUBRIC_V0_REF` variants for reference-based mode** — Rejected in favor of a `reference_suffix` appended to the base rubric: one source of truth per dimension, user-overridable, less to maintain and keep in sync.
9. **S3 URI auto-fetch via `boto3`** — Dropped from initial release: adds an optional dependency and an authentication surface. Users can pre-download to bytes/path; HTTP/HTTPS is supported via stdlib. Can be reintroduced if demand materializes.
10. **`MultimodalInput` as a `TypedDict`** — Rejected in favor of a Pydantic `BaseModel`: gives us `model_validate` for save/load round-trips, field validation on `media`, and a natural home for the `context` field.

## Consequences

**Easier:**

* Same `Case` → `Experiment` → `Report` workflow for multimodal evaluation
* Reference-based and reference-free supported via `expected_output` with automatic suffix appending
* Built-in rubrics for four dimensions adapted from experimentally validated prompts; custom rubrics and custom reference suffixes for domain-specific needs
* Text-only comparison experiments work with zero code change — just pass a non-`MultimodalInput` input
* Same `Agent.__call__` invocation and async plumbing as the parent `OutputEvaluator`
* Multiple images per case, PIL Images, bytes, data URLs, HTTP URLs, and file paths all accepted

**Trade-offs:**

* `MultimodalInput` validation runs at case construction and again at save/load; slight overhead vs. a TypedDict
* Multimodal judge calls are more expensive/slower than text-only (image tokens cost more)
* Remote media is limited to HTTP/HTTPS in this release; S3 users must pre-download

## Willingness to Implement

Yes. Implemented and merged in https://github.com/strands-agents/evals/pull/187 on 2026-04-30.
