"""Proactive reconnect timer for bidirectional streaming.

``BidiReconnectTimer`` fires a warning then a deadline callback at caller-supplied offsets;
it holds no reconnect policy. ``resolve_deadline_s`` reads the deadline from a provider's
declared ``BidiConnectionConfig``.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable

from ..models.configs import BidiConnectionConfig

logger = logging.getLogger(__name__)


def resolve_deadline_s(connection_config: BidiConnectionConfig) -> int | None:
    """Resolve the proactive reconnect deadline in seconds from a connection config.

    Args:
        connection_config: Provider-declared reconnect timing.

    Returns:
        ``restart_after_s`` if declared and positive, else ``None`` (no proactive timer).
    """
    restart_after_s = connection_config.get("restart_after_s")
    if restart_after_s is None or restart_after_s <= 0:
        return None
    return restart_after_s


class BidiReconnectTimer:
    """Fire a warning then a deadline callback ahead of a provider's connection limit.

    The clock is injectable so tests can drive timing without wall time.
    """

    def __init__(
        self,
        on_warning: Callable[[int], Awaitable[None]],
        on_deadline: Callable[[], Awaitable[None]],
        sleep: Callable[[int], Awaitable[None]] | None = None,
    ) -> None:
        """Initialize the timer.

        Args:
            on_warning: Awaitable called with seconds-left when the warning lead elapses.
            on_deadline: Awaitable called when the reconnect deadline elapses.
            sleep: Injectable async sleep (for tests). Defaults to ``asyncio.sleep``.
        """
        self._on_warning = on_warning
        self._on_deadline = on_deadline
        self._sleep = sleep or asyncio.sleep
        self._task: asyncio.Task | None = None

    def arm(self, deadline_s: int, warning_lead_s: int) -> None:
        """Arm the warning and deadline timers, cancelling any previously armed cycle.

        Args:
            deadline_s: Seconds from now until the deadline callback fires.
            warning_lead_s: Seconds before the deadline to fire the warning callback.
        """
        self.cancel()
        self._task = asyncio.create_task(self._run(deadline_s, warning_lead_s))
        logger.debug(
            "deadline_s=<%.1f>, warning_lead_s=<%.1f> | proactive reconnect timer armed",
            deadline_s,
            warning_lead_s,
        )

    def cancel(self) -> None:
        """Cancel the armed timer, if any. Safe to call when idle."""
        if self._task is not None:
            self._task.cancel()
            self._task = None

    async def _run(self, deadline_s: int, warning_lead_s: int) -> None:
        """Sleep until the warning lead, fire the warning, then fire the deadline.

        The warning fires ``warning_lead_s`` before the deadline. When the lead is zero
        or exceeds the deadline, the warning is emitted immediately and the remaining
        wait runs down to the deadline. The deadline countdown continues while warning
        delivery is backpressured, but the deadline callback still follows the warning.
        """
        warning_at_s = max(deadline_s - warning_lead_s, 0)

        await self._sleep(warning_at_s)
        time_left_s = deadline_s - warning_at_s
        deadline_sleep: asyncio.Future[None] = asyncio.ensure_future(self._sleep(deadline_s - warning_at_s))
        try:
            await self._on_warning(time_left_s)
            await deadline_sleep
        finally:
            if not deadline_sleep.done():
                deadline_sleep.cancel()
            await asyncio.gather(deadline_sleep, return_exceptions=True)

        # Detach before the callback re-arms this timer; cancelling a live self-reference
        # would abort the reconnect the callback runs.
        self._task = None
        await self._on_deadline()
