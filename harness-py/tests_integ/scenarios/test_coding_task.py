"""A small coding task over four turns: run the tests, fix the bug, add a tested function, run everything."""

from __future__ import annotations

import re
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

from recording import Recording, check_invariants
from strands import Agent

Build = Callable[..., Agent]
Record = Callable[[Agent], Recording]

_TESTING = "You are an automated integration test. Do exactly what is asked and nothing else."

_CALC = "def add(a, b):\n    return a - b\n"

_TEST_CALC = """import unittest

from calc import add


class AddTest(unittest.TestCase):
    def test_add_sums_two_numbers(self):
        self.assertEqual(add(2, 3), 5)
"""

_RUN_TESTS = f"{sys.executable} -m unittest"

_TURNS = (
    f"Run `{_RUN_TESTS}` in the current directory and report whether the tests pass.",
    "Fix the bug in calc.py that makes the test fail. Do not change test_calc.py.",
    "Add a function `multiply(a, b)` to calc.py, and a test for it in a new file test_multiply.py.",
    f"Run `{_RUN_TESTS}` again and report the result.",
)


async def test_fixes_the_bug_and_adds_a_tested_function_leaving_the_original_test_untouched(
    work_dir: Path, build_agent: Build, record_agent: Record
) -> None:
    (work_dir / "calc.py").write_text(_CALC)
    (work_dir / "test_calc.py").write_text(_TEST_CALC)
    agent = build_agent()
    recording = record_agent(agent)

    for turn in _TURNS:
        await agent.invoke_async(f"{_TESTING} {turn}")

    # The model may probe a directory with read, which fails, and recover.
    check_invariants(recording, agent, allowed_tool_errors=("read",))
    tests = subprocess.run(_RUN_TESTS.split(), cwd=work_dir, capture_output=True, text=True)
    assert tests.returncode == 0, tests.stderr
    assert int(re.search(r"Ran (\d+) tests?", tests.stderr).group(1)) >= 2, tests.stderr
    multiply = subprocess.run(
        [sys.executable, "-c", "import calc; raise SystemExit(calc.multiply(3, 4) != 12)"], cwd=work_dir
    )
    assert multiply.returncode == 0
    assert (work_dir / "test_calc.py").read_text() == _TEST_CALC
