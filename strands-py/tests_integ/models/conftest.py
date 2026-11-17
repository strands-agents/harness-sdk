import pytest

from tests_integ.models import conformance


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    conformance.record(item, outcome.get_result(), call.excinfo.value if call.excinfo else None)
