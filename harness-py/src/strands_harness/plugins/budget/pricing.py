"""Calculate model-call costs from token counts and per-token rates."""


def estimate_cost(
    input_tokens: int,
    output_tokens: int,
    rates: tuple[float, float],
) -> float:
    """Return model-call cost in USD without display rounding."""
     
    return round(input_tokens * rates[0] + output_tokens * rates[1],5)
