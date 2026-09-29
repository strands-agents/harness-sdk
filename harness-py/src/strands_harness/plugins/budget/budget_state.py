"""Persisted budget state and accounting operations."""

from datetime import datetime, timezone

from pydantic import BaseModel, Field
from strands.storage import LocalFileStorage, Storage

DEFAULT_STORAGE_DIR = ".agent"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class Transaction(BaseModel):
    """Cost and token usage recorded for one model call."""

    description: str
    cost: float
    timestamp: str = Field(default_factory=_utc_now_iso)
    input_tokens: int = 0
    output_tokens: int = 0


class BudgetState(BaseModel):
    """Budget limit, spend, and transaction history for one session ID."""

    session_id: str
    total_budget: float
    spent: float = 0.0
    transactions: list[Transaction] = Field(default_factory=list)

    @property
    def remaining(self) -> float:
        """Return the unspent budget in USD."""
        return self.total_budget - self.spent

    def is_exhausted(self) -> bool:
        """Return whether recorded spend has reached the budget limit."""
        return self.spent >= self.total_budget


class BudgetManager:
    """Load and update budget state through a Strands storage backend.

    A missing state has no budget limit. In that case, ``load`` returns
    ``None``, and ``record_cost`` and ``reset`` make no changes.
    """

    def __init__(self, storage: Storage | None = None) -> None:
        """Initialize the manager with local storage or a supplied backend."""
        self.storage = storage if storage is not None else LocalFileStorage(DEFAULT_STORAGE_DIR)

    def _key(self, session_id: str) -> str:
        return f"strands-budget/{session_id}.json"

    async def load(self, session_id: str) -> BudgetState | None:
        """Load the state for a session ID, or return ``None`` when absent."""
        data = await self.storage.read(self._key(session_id))
        if data is None:
            return None
        return BudgetState.model_validate_json(data)

    async def save(self, state: BudgetState) -> None:
        """Persist a complete budget state."""
        await self.storage.write(self._key(state.session_id), state.model_dump_json(indent=2).encode())

    async def set_budget(self, session_id: str, amount: float) -> BudgetState:
        """Set the limit while preserving recorded spend and transactions."""
        state = await self.load(session_id)
        if state is None:
            state = BudgetState(session_id=session_id, total_budget=amount)
        else:
            state.total_budget = amount
        await self.save(state)
        return state

    async def record_cost(
        self,
        session_id: str,
        cost: float,
        description: str,
        input_tokens: int = 0,
        output_tokens: int = 0,
    ) -> BudgetState | None:
        """Add model-call cost and token usage when a budget exists."""
        state = await self.load(session_id)
        if state is None:
            return None

        state.spent += cost
        state.transactions.append(
            Transaction(
                description=description,
                cost=cost,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
            )
        )
        await self.save(state)
        return state

    async def reset(self, session_id: str) -> BudgetState | None:
        """Clear spend and transactions while preserving the budget limit."""
        state = await self.load(session_id)
        if state is None:
            return None

        state.spent = 0.0
        state.transactions = []
        await self.save(state)
        return state

    async def delete(self, session_id: str) -> None:
        """Delete budget state so the session no longer has a limit."""
        await self.storage.delete(self._key(session_id))
