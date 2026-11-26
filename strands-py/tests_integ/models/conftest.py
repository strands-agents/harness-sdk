import pytest

from tests_integ.models import conformance


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    report = outcome.get_result()
    conformance.apply_known_failure(item, call, report)
    conformance.record(item, report, call.excinfo.value if call.excinfo else None)
    conformance.apply_probe(item, call, report)
