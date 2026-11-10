from strands.experimental import config_to_agent


def test_load_agent_from_config():
    agent = config_to_agent("file://tests_integ/fixtures/test_agent.json")

    result = agent("Say hello")

    assert "Sayer" == agent.name
    assert "You use the say tool to communicate" == agent.system_prompt
    assert agent.tool_names[0] == "say"
    assert agent.model.get_config().get("model_id") == "global.anthropic.claude-sonnet-4-5-20250929-v1:0"
    assert "hello" in str(result).lower()
