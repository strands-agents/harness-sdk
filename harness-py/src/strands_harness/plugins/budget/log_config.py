"""Optional console logging for the budget package."""

import logging
import sys

_RESET = "\033[0m"
_LEVEL_COLORS = {
    logging.DEBUG: "\033[36m",
    logging.INFO: "\033[32m",
    logging.WARNING: "\033[33m",
    logging.ERROR: "\033[31m",
    logging.CRITICAL: "\033[1;31m",
}


class _ColorFormatter(logging.Formatter):
    """Format budget log records with a package and level prefix."""

    def __init__(self, use_color: bool) -> None:
        super().__init__()
        self._use_color = use_color

    def format(self, record: logging.LogRecord) -> str:
        prefix = f"[strands-budget-{record.levelname.lower()}]"
        timestamp = self.formatTime(record, "%Y-%m-%d %H:%M:%S")
        message = record.getMessage()
        if record.exc_info:
            message = f"{message}\n{self.formatException(record.exc_info)}"

        line = f"{prefix} {timestamp} {message}"
        if not self._use_color:
            return line
        return f"{_LEVEL_COLORS.get(record.levelno, '')}{line}{_RESET}"


def setup_logging(level: int = logging.WARNING) -> None:
    """Configure prefixed console logs for this package.

    The setup is opt-in and leaves the root logger unchanged. Repeated calls do
    not add duplicate handlers.

    Args:
        level: Minimum logging level emitted by the package logger.
    """
    package_logger = logging.getLogger("strands_harness.plugins.budget")
    if package_logger.handlers:
        return

    handler = logging.StreamHandler()
    handler.setFormatter(_ColorFormatter(use_color=sys.stderr.isatty()))
    package_logger.addHandler(handler)
    package_logger.setLevel(level)
    package_logger.propagate = False
