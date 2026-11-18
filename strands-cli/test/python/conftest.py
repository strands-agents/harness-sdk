import sys

import pytest
from dev_evals_support import PACKAGE_FOLDER, FakeHarness

sys.path.insert(0, str(PACKAGE_FOLDER))

AWS_PROFILE_VARIABLES = ("AWS_PROFILE", "AWS_DEFAULT_PROFILE")
AWS_FILE_VARIABLES = ("AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE")


@pytest.fixture(autouse=True)
def offline_aws(tmp_path, monkeypatch):
    for name in AWS_PROFILE_VARIABLES:
        monkeypatch.delenv(name, raising=False)
    for name in AWS_FILE_VARIABLES:
        monkeypatch.setenv(name, str(tmp_path / "no-aws-file"))


@pytest.fixture
def harness(monkeypatch):
    fake = FakeHarness()
    monkeypatch.setitem(sys.modules, "strands_harness", fake)
    monkeypatch.setattr(sys, "path", list(sys.path))
    return fake


@pytest.fixture
def runner_log(tmp_path, monkeypatch):
    log = tmp_path / "runner.jsonl"
    monkeypatch.setenv("FAKE_RUNNER_LOG", str(log))
    return log
