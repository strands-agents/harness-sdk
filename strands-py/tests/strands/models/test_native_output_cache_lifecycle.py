"""The rejected-native-schema cache must not pin dynamically created output models.

``handle_rejected_mechanism`` records models whose schema a provider rejected
from native structured output, and ``unsupported_mechanisms`` consults that
record. Dynamically created models (``pydantic.create_model``) are distinct
classes on every call, so the record both grows without bound for them and
can never be hit again; at minimum it must not keep the classes alive after
their last strong reference is gone.
"""

import gc
import weakref

from pydantic import BaseModel, create_model

from strands.models._native_output import (
    handle_rejected_mechanism,
    unsupported_mechanisms,
)


def _a_rejection_message() -> str:
    # Any documented native-output rejection signal triggers the per-schema record.
    return "Schema is too complex for structured outputs"


def test_rejected_native_schema_record_is_consulted_and_released():
    class StableOutput(BaseModel):
        answer: str

    assert handle_rejected_mechanism("anthropic", "claude-3", "native", StableOutput, _a_rejection_message())
    assert "native" in unsupported_mechanisms("anthropic", "claude-3", StableOutput)

    # A record for a different class on the same model must not leak into it.
    other = create_model("UnrelatedOutput", x=(int, ...))
    assert "native" not in unsupported_mechanisms("anthropic", "claude-3", other)

    dynamic = create_model("DynamicRejectedOutput", answer=(str, ...))
    handle_rejected_mechanism("anthropic", "claude-3", "native", dynamic, _a_rejection_message())
    ref = weakref.ref(dynamic)
    del dynamic
    gc.collect()

    assert ref() is None, (
        "The rejected-native-schema cache is keeping dynamically created "
        "pydantic model classes alive after their last use"
    )
