"""Tests for environment-driven configuration (#3330)."""

import logging

import pytest

from strands_mcp_server import config
from strands_mcp_server.config import Config


@pytest.fixture(autouse=True)
def clear_config_env(monkeypatch):
    """Start every test from an unset environment."""
    for var in (config.ENV_LLMS_TXT, config.ENV_TIMEOUT, config.ENV_USER_AGENT):
        monkeypatch.delenv(var, raising=False)


class TestDefaults:
    def test_unset_environment_uses_defaults(self):
        cfg = Config()

        assert cfg.llm_texts_url == config.DEFAULT_LLMS_TXT_URLS
        assert cfg.timeout == config.DEFAULT_TIMEOUT
        assert cfg.user_agent == config.DEFAULT_USER_AGENT

    def test_default_url_list_is_not_shared_between_instances(self):
        first = Config()
        first.llm_texts_url.append("https://example.com/llms.txt")

        assert Config().llm_texts_url == config.DEFAULT_LLMS_TXT_URLS


class TestLlmsTxtUrls:
    def test_single_url(self, monkeypatch):
        monkeypatch.setenv(config.ENV_LLMS_TXT, "https://example.com/llms.txt")

        assert Config().llm_texts_url == ["https://example.com/llms.txt"]

    def test_comma_separated_list_is_split_and_stripped(self, monkeypatch):
        monkeypatch.setenv(config.ENV_LLMS_TXT, " https://a.com/llms.txt , https://b.com/llms.txt ")

        assert Config().llm_texts_url == ["https://a.com/llms.txt", "https://b.com/llms.txt"]

    def test_empty_entries_are_dropped(self, monkeypatch):
        monkeypatch.setenv(config.ENV_LLMS_TXT, "https://a.com/llms.txt,,  ,")

        assert Config().llm_texts_url == ["https://a.com/llms.txt"]

    @pytest.mark.parametrize("value", ["", "   ", ",", " , "])
    def test_blank_value_falls_back_to_defaults(self, monkeypatch, value):
        monkeypatch.setenv(config.ENV_LLMS_TXT, value)

        assert Config().llm_texts_url == config.DEFAULT_LLMS_TXT_URLS


class TestTimeout:
    def test_valid_value_is_used(self, monkeypatch):
        monkeypatch.setenv(config.ENV_TIMEOUT, "5.5")

        assert Config().timeout == 5.5

    @pytest.mark.parametrize("value", ["abc", "", "  ", "1,5"])
    def test_unparseable_value_falls_back_to_default(self, monkeypatch, value):
        monkeypatch.setenv(config.ENV_TIMEOUT, value)

        assert Config().timeout == config.DEFAULT_TIMEOUT

    @pytest.mark.parametrize("value", ["0", "-1", "-0.5"])
    def test_non_positive_value_falls_back_to_default(self, monkeypatch, value):
        monkeypatch.setenv(config.ENV_TIMEOUT, value)

        assert Config().timeout == config.DEFAULT_TIMEOUT

    def test_bad_value_is_logged(self, monkeypatch, caplog):
        monkeypatch.setenv(config.ENV_TIMEOUT, "abc")

        with caplog.at_level(logging.WARNING, logger="strands_mcp_server.config"):
            Config()

        assert config.ENV_TIMEOUT in caplog.text

    def test_bad_value_does_not_raise(self, monkeypatch):
        monkeypatch.setenv(config.ENV_TIMEOUT, "not-a-number")

        assert Config().timeout > 0


class TestUserAgent:
    def test_custom_value_is_used(self, monkeypatch):
        monkeypatch.setenv(config.ENV_USER_AGENT, "acme-docs/2.0")

        assert Config().user_agent == "acme-docs/2.0"

    @pytest.mark.parametrize("value", ["", "   "])
    def test_blank_value_falls_back_to_default(self, monkeypatch, value):
        monkeypatch.setenv(config.ENV_USER_AGENT, value)

        assert Config().user_agent == config.DEFAULT_USER_AGENT
