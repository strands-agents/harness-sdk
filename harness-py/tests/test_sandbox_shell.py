from strands.sandbox.types import ExecutionResult

from strands_harness.sandbox_shell import SHELL_PROBE, shell_of


class _Sandbox:
    def __init__(self, *results: ExecutionResult):
        self._results = list(results)
        self.probes = 0

    async def execute(self, command: str, **kwargs: object) -> ExecutionResult:
        assert command == SHELL_PROBE
        self.probes += 1
        return self._results.pop(0) if len(self._results) > 1 else self._results[0]


async def test_recognises_powershell_by_its_edition_and_caches_per_sandbox():
    sandbox = _Sandbox(ExecutionResult(exit_code=0, stdout="Core\r\n", stderr=""))
    assert await shell_of(sandbox) == "powershell"
    assert await shell_of(sandbox) == "powershell"
    assert sandbox.probes == 1


async def test_treats_an_empty_expansion_as_sh():
    assert await shell_of(_Sandbox(ExecutionResult(exit_code=0, stdout="\n", stderr=""))) == "sh"


async def test_does_not_cache_a_failed_probe():
    sandbox = _Sandbox(
        ExecutionResult(exit_code=1, stdout="", stderr=""),
        ExecutionResult(exit_code=0, stdout="Desktop\n", stderr=""),
    )
    assert await shell_of(sandbox) == "sh"
    assert await shell_of(sandbox) == "powershell"
    assert sandbox.probes == 2
