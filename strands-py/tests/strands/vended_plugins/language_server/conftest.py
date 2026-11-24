from pathlib import Path

import pytest

from ._session import FILES


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    root = tmp_path / "ws"
    root.mkdir()
    for name, text in FILES.items():
        (root / name).write_text(text)
    return root
