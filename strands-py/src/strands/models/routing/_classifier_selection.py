"""Internal structured-output schema for model classification."""

from pydantic import BaseModel, Field


# Providers may normalize leading underscores in structured-output tool names.
class ClassifierSelection(BaseModel):
    """Structured routing decision returned by the classifier model."""

    selected_candidate_index: int = Field(
        ge=0,
        strict=True,
        description="Zero-based index of the configured candidate best suited to the request.",
    )
