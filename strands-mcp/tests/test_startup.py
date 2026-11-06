"""The MCP transport remains available when the documentation site is offline (#5860)."""

import sys
from pathlib import Path

import anyio
import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


@pytest.mark.parametrize("prefetch", ["0", "1"])
def test_main_serves_tools_offline_and_recovers(tmp_path: Path, prefetch: str):
    recovered = tmp_path / "recovered"
    launcher = """
import io
import sys
import urllib.request
from pathlib import Path
from urllib.error import URLError

def urlopen(request, **kwargs):
    if not Path(sys.argv[1]).exists():
        raise URLError("documentation is offline")
    content = (
        "[Test guide](https://strandsagents.com/test.md)"
        if request.full_url.endswith("llms.txt")
        else "# Test guide\\n\\nRecovered documentation."
    )
    return io.BytesIO(content.encode("utf-8"))

urllib.request.urlopen = urlopen
from strands_mcp_server.server import main
main()
"""
    parameters = StdioServerParameters(
        command=sys.executable,
        args=["-c", launcher, str(recovered)],
        env={"STRANDS_MCP_PREFETCH_ALL": prefetch},
    )

    async def exercise():
        with anyio.fail_after(15):
            async with stdio_client(parameters) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    tools = await session.list_tools()
                    assert {tool.name for tool in tools.tools} == {"search_docs", "fetch_doc"}

                    for name, arguments in [("search_docs", {"query": "test"}), ("fetch_doc", {})]:
                        result = await session.call_tool(name, arguments)
                        assert result.model_dump(by_alias=True)["isError"]
                        assert result.content[0].text

                    recovered.touch()
                    result = await session.call_tool("search_docs", {"query": "test"})
                    assert not result.model_dump(by_alias=True)["isError"]
                    assert "https://strandsagents.com/test.md" in result.content[0].text

                    result = await session.call_tool("fetch_doc", {"uri": "https://strandsagents.com/test.md"})
                    assert not result.model_dump(by_alias=True)["isError"]
                    assert "Recovered documentation." in result.content[0].text

    anyio.run(exercise)
