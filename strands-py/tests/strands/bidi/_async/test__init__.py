from unittest.mock import AsyncMock

import pytest

from strands.bidi._async import stop_all


@pytest.mark.asyncio
async def test_stop_exception():
    func1 = AsyncMock()
    func2 = AsyncMock(side_effect=ValueError("stop 2 failed"))
    func3 = AsyncMock()
    func4 = AsyncMock(side_effect=ValueError("stop 4 failed"))

    with pytest.raises(Exception, match=r"failed stop sequence") as exc_info:
        await stop_all(func1, func2, func3, func4)

    func1.assert_called_once()
    func2.assert_called_once()
    func3.assert_called_once()
    func4.assert_called_once()

    tru_message = str(exc_info.value)
    assert "ValueError('stop 2 failed')" in tru_message
    assert "ValueError('stop 4 failed')" in tru_message


@pytest.mark.asyncio
async def test_stop_success():
    func1 = AsyncMock()
    func2 = AsyncMock()
    func3 = AsyncMock()

    await stop_all(func1, func2, func3)

    func1.assert_called_once()
    func2.assert_called_once()
    func3.assert_called_once()
